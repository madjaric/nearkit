#!/usr/bin/env bash
# NEARKITS watchdog (DEPLOYMENT.md §13), run every two minutes by nearkit-monitor.timer. Checks the
# stack from the host, so it still reports when the app itself is down:
#   containers running, unhealthy or restarting · the app's /health through Caddy · OpenBao sealed or
#   unreachable · the signer's price floor · signer refusals · local and off-site backups failing or
#   stale · both databases · bridge orders stuck past their lifecycle · Telegram polling errors · wallet
#   operations, sends and buy alerts stuck in their queues · a stalled Volume Bot runner · bursts of
#   failed operations.
# Alerts go to the owner's Telegram chat (ALERT_TELEGRAM_CHAT_ID in monitor.env) through NEARKITS'
# bot: once when a check starts failing, again every 6 hours while it fails, and once when it
# recovers. They name the check and counts only: no secret, account, amount or transaction.
# Without a chat configured, alerts are written to the journal (journalctl -u nearkit-monitor).
# Each alert sent is noted in the journal. One Telegram didn't take (asked twice) is kept in
# monitor/pending and sent, marked delayed, by the next run Telegram answers: an outage of Telegram
# (or of this host's route to it) delays an alert, never loses it.
#   /opt/nearkit/bin/monitor            run the checks (the timer does this)
#   /opt/nearkit/bin/monitor --test     send a test alert, to check the channel
#   /opt/nearkit/bin/monitor --status   print each check's state, send nothing
#   /opt/nearkit/bin/monitor --inflight what is under way right now; exit 0 only when nothing is
set -uo pipefail
# NEARKIT_MONITOR_ROOT: tests only (server/src/ops/monitorAlerts.test.ts); production runs in /opt/nearkit.
root=${NEARKIT_MONITOR_ROOT:-/opt/nearkit}
cd "$root" || exit 1
state="$root/monitor"
install -d -m 700 "$state"
pending="$state/pending"
conf="$root/monitor.env"
# shellcheck source=/dev/null
[ -s "$conf" ] && . "$conf"
host=${MONITOR_PUBLIC_HOST:-srv2021581.hstgr.cloud}
realert=${MONITOR_REALERT_SECONDS:-21600}
digest_hour=${MONITOR_DIGEST_HOUR_UTC:-7}
mode=${1:-run}
now=$(date -u +%s)
ms=$((now * 1000))

telegram_ready() { [ -n "${ALERT_TELEGRAM_CHAT_ID:-}" ] && [ -s secrets/telegram_bot_token ]; }

# One message to the alert chat, asked twice (a moment apart); 0 when Telegram took it. Once Telegram
# hasn't taken one, the rest of this run doesn't ask again (each ask can wait 15 s; the run has 120).
telegram_down=
why=
deliver() {
  local text=$1 token code rc try
  [ -n "$telegram_down" ] && return 1
  token=$(cat secrets/telegram_bot_token)
  for try in 1 2; do
    # The URL (which holds the token) goes to curl on stdin, never in its arguments. Only the HTTP
    # status and curl's exit code are logged, never its output.
    code=$(printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$token" |
      curl -sS --max-time 15 -o /dev/null -w '%{http_code}' --config - \
        --data-urlencode "chat_id=$ALERT_TELEGRAM_CHAT_ID" --data-urlencode "text=$text" 2> /dev/null)
    rc=$?
    [ "$rc" -eq 0 ] && [ "$code" = 200 ] && return 0
    why="HTTP ${code:-none}, curl exit $rc"
    [ "$try" = 1 ] && sleep "${MONITOR_RETRY_SECONDS:-3}"
  done
  telegram_down=1
  return 1
}

# Keeps an alert to send with the next run Telegram answers. A long outage keeps the newest lines,
# within one Telegram message; the cut drops the line it falls in, so the text stays valid UTF-8.
keep() {
  printf '%s\n' "$1" >> "$pending"
  if [ "$(wc -c < "$pending")" -gt 3000 ]; then
    tail -c 3000 "$pending" | tail -n +2 > "$pending.tmp" && mv -f "$pending.tmp" "$pending"
  fi
}

send() {
  local text=$1
  if ! telegram_ready; then
    echo "ALERT (no Telegram chat configured): $text"
    return 0
  fi
  if deliver "$text"; then
    echo "monitor: alert sent: ${text//$'\n'/ · }"
    return 0
  fi
  echo "monitor: Telegram didn't take the alert ($why); kept to send again: ${text//$'\n'/ · }" >&2
  keep "$text"
  return 1
}

# The alerts earlier runs kept, sent first and marked delayed; kept again while Telegram doesn't answer.
flush_pending() {
  [ -s "$pending" ] && telegram_ready || return 0
  if deliver "📬 Delayed: NEARKITS alerts Telegram didn't take at the time
$(cat "$pending")"; then
    rm -f "$pending"
    echo "monitor: delayed alerts sent"
  else
    echo "monitor: Telegram still doesn't take alerts ($why); delayed alerts kept" >&2
  fi
}

if [ "$mode" = --test ]; then
  flush_pending
  send "🧪 NEARKITS monitoring test from $(hostname) at $(date -u +%H:%MZ). Alerts reach this chat."
  exit
fi

failing=()
declare -A detail=()
fail() {
  failing+=("$1")
  detail[$1]=$2
}
appq() { docker exec nearkit-app-db-1 psql -U nearkit -d nearkit -tA -c "$1" 2> /dev/null; }
signq() { docker exec nearkit-signer-db-1 psql -U nearkit_signer -d nearkit_signer -tA -c "$1" 2> /dev/null; }
# A count from a query, into the variable named first. A query that returns no number (a database
# down, a schema changed) is reported itself, never read as zero.
query_failed=0
count() {
  local out
  if [ "$2" = signer ]; then out=$(signq "$3"); else out=$(appq "$3"); fi
  if [[ "$out" =~ ^[0-9]+$ ]]; then printf -v "$1" '%s' "$out"; else
    printf -v "$1" '0'
    query_failed=1
  fi
}

# Before restarting the app, the buy bot or the signer (DEPLOYMENT.md §11): what is under way right
# now, at any age. Exits 0 only when nothing is; 1 while something is; 2 when it can't tell.
if [ "$mode" = --inflight ]; then
  count intents app "select count(*) from wallet_intents where status in ('confirmed','signing','submitted')"
  count txs app "select count(*) from wallet_txs where status in ('signed','submitted','unconfirmed')"
  count stage2 app "select count(*) from bridge_orders where status in ('delivered','buying','unwrapping')"
  count signed signer "select count(*) from signer_events where at > $((ms - 60000)) and kind = 'tx-signed'"
  count bots app "select count(*) from volume_bots where status = 'running'"
  echo "wallet operations in flight: $intents"
  echo "sent transactions not yet settled: $txs"
  echo "bridge orders in their NEARKITS step (buy or unwrap): $stage2"
  echo "signatures in the last minute: $signed"
  echo "running Volume Bots (each trade is a wallet operation above): $bots"
  [ "$query_failed" -ne 0 ] && { echo "a query returned no number: can't tell" >&2; exit 2; }
  [ $((intents + txs + stage2 + signed)) -eq 0 ] && { echo "nothing in flight"; exit 0; }
  exit 1
fi

# Containers: running, healthy where they have a check, and not restarting on their own.
for svc in app buybot signer openbao caddy app-db signer-db; do
  c="nearkit-$svc-1"
  # The whole record as JSON: a template can't ask for .State.Health on a container without a check.
  info=$(docker inspect "$c" 2> /dev/null | python3 -c '
import json, sys
c = json.load(sys.stdin)[0]
s = c["State"]
print(str(s["Running"]).lower(), c["RestartCount"], c["Id"], (s.get("Health") or {}).get("Status", "none"))' 2> /dev/null) ||
    { fail "container-$svc" "the $svc container doesn't exist"; continue; }
  read -r running restarts id health <<< "$info"
  [ "$running" = true ] || fail "container-$svc" "the $svc container isn't running"
  [ "${health:-}" = unhealthy ] && fail "container-$svc" "the $svc container is unhealthy"
  # A restart by Docker (crash) raises the count; a deploy makes a new container (new id) and resets it.
  prev=$(cat "$state/restarts-$svc" 2> /dev/null || true)
  if [ -n "$prev" ] && [ "${prev% *}" = "$id" ] && [ "$restarts" -gt "${prev#* }" ]; then
    fail "restart-$svc" "the $svc container restarted on its own ($((restarts - ${prev#* })) time(s) in the last check interval)"
  fi
  printf '%s %s' "$id" "$restarts" > "$state/restarts-$svc"
done

# The app, through Caddy, as users reach it.
health=$(curl -sS --max-time 10 --resolve "$host:443:127.0.0.1" "https://$host/health" 2> /dev/null)
verdict=$(printf '%s' "$health" | python3 -c '
import json, sys
try:
    h = json.load(sys.stdin)
except Exception:
    print("no-json"); sys.exit()
bad = []
if h.get("ok") is not True: bad.append("not ok")
if h.get("bot") is not True: bad.append("bot off")
if h.get("signer") != "ok": bad.append("signer " + str(h.get("signer")))
print(", ".join(bad) or "ok")' 2> /dev/null)
case "$verdict" in
  ok) ;;
  no-json | "") fail "app-health" "the app's /health doesn't answer through Caddy" ;;
  *) fail "app-health" "/health: $verdict" ;;
esac

# OpenBao: sealed (exit 2) or unreachable (exit 1). Sealed means no wallet key opens until the owner unseals.
bao=$(docker exec -e BAO_ADDR=https://127.0.0.1:8200 -e BAO_CACERT=/openbao/tls/openbao.crt nearkit-openbao-1 bao status -format=json 2> /dev/null)
case $? in
  0) ;;
  2) fail "openbao" "OpenBao is SEALED: wallets can't sign until it is unsealed (bin/openbao-unseal)" ;;
  *) [ -n "$bao" ] || fail "openbao" "OpenBao doesn't answer" ;;
esac

# The signer's refusals in the last 15 minutes (a few are normal: a stale quote, a changed price).
count denied signer "select count(*) from signer_events where at > $((ms - 900000)) and kind in ('signer-denied','owner-proof-refused','tg-approval-refused')"
[ "$denied" -ge "${MONITOR_SIGNER_DENIALS:-5}" ] && fail "signer-denials" "$denied signer refusal(s) in the last 15 minutes"

# The signer's price floor, as the running signer has it: set, and no looser than production's 10%.
# The pinned signer (3861241e7aab) falls back to 50% when the line is missing; this catches that.
floor=$(docker inspect nearkit-signer-1 --format '{{range .Config.Env}}{{println .}}{{end}}' 2> /dev/null | sed -n 's/^NEARKIT_SIGNER_MAX_SLIPPAGE_PCT=//p')
if ! [[ "$floor" =~ ^[0-9]+(\.[0-9]+)?$ ]] || ! awk -v f="$floor" -v m="${MONITOR_SIGNER_MAX_FLOOR:-10}" 'BEGIN { exit !(f > 0 && f <= m) }'; then
  fail "signer-floor" "the signer's price floor is ${floor:-not set} (NEARKIT_SIGNER_MAX_SLIPPAGE_PCT in signer.env must be set, at most ${MONITOR_SIGNER_MAX_FLOOR:-10})"
fi

# Backups: the hourly local one, and its off-site copy.
newest=$(find backups -maxdepth 1 -name 'nearkit-*.dump' -printf '%T@\n' 2> /dev/null | sort -n | tail -1)
if [ -z "$newest" ] || [ $((now - ${newest%.*})) -gt 7800 ]; then
  fail "backup-local" "no local backup in the last 2 hours"
fi
systemctl is-failed --quiet nearkit-backup.service && fail "backup-run" "the last backup run failed (journalctl -u nearkit-backup)"
if [ -s backups/.offsite.error ]; then
  read -r err_at _ err_reason < backups/.offsite.error
  ok_at=$(cut -d' ' -f1 backups/.offsite.ok 2> /dev/null || echo 0)
  [ "${err_at:-0}" -gt "${ok_at:-0}" ] && fail "backup-offsite" "off-site copy failing: ${err_reason:-unknown}"
fi
ok_at=$(cut -d' ' -f1 backups/.offsite.ok 2> /dev/null || echo 0)
[ $((now - ${ok_at:-0})) -gt 7800 ] && fail "backup-offsite-stale" "no off-site copy in the last 2 hours"

# Databases.
docker exec nearkit-app-db-1 pg_isready -q -U nearkit -d nearkit 2> /dev/null || fail "db-app" "the app database doesn't accept connections"
docker exec nearkit-signer-db-1 pg_isready -q -U nearkit_signer -d nearkit_signer 2> /dev/null || fail "db-signer" "the signer database doesn't accept connections"

# Bridge orders past their lifecycle (counts only).
count stuck app "select count(*) from bridge_orders where
  (status in ('deposit-seen','bridging') and updated_at < $((ms - 7200000)))
  or (status = 'awaiting-deposit' and deposit_deadline < $((ms - 7200000)))
  or (status in ('delivered','buying','unwrapping') and updated_at < $((ms - 3600000)))
  or (next_check_at is not null and next_check_at < $((ms - 900000)))"
[ "$stuck" -gt 0 ] && fail "bridge-stuck" "$stuck bridge order(s) stuck past their expected lifecycle"

# Telegram polling.
logs=$(docker logs --since 10m nearkit-app-1 2>&1)
polls=$(printf '%s\n' "$logs" | grep -c 'getUpdates failed' || true)
[ "${polls:-0}" -ge "${MONITOR_POLL_ERRORS:-5}" ] && fail "telegram-polling" "$polls Telegram polling error(s) in the last 10 minutes"
printf '%s\n' "$logs" | grep -q 'Telegram rejected the bot token' && fail "telegram-token" "Telegram rejected the bot token; the bot stopped"
errors=$(printf '%s\n' "$logs" | grep -c '"level":"error"' || true)
[ "${errors:-0}" -ge "${MONITOR_APP_ERRORS:-20}" ] && fail "app-errors" "$errors error log line(s) from the app in the last 10 minutes"

# Queues and workers.
count inflight app "select count(*) from wallet_intents where status in ('confirmed','signing','submitted') and updated_at < $((ms - 600000))"
[ "$inflight" -gt 0 ] && fail "intents-stuck" "$inflight wallet operation(s) in flight for over 10 minutes"
count unsettled app "select count(*) from wallet_txs where status in ('signed','submitted','unconfirmed') and updated_at < $((ms - 900000))"
[ "$unsettled" -gt 0 ] && fail "txs-unreconciled" "$unsettled sent transaction(s) not reconciled after 15 minutes"
count failed app "select count(*) from wallet_intents where status = 'failed' and updated_at > $((ms - 3600000))"
[ "$failed" -ge "${MONITOR_FAILED_OPS:-5}" ] && fail "intents-failing" "$failed wallet operation(s) failed in the last hour"
count alerts app "select count(*) from buybot_deliveries where status <> 'sent' and created_at < $((ms - 900000))"
[ "$alerts" -gt 0 ] && fail "buybot-queue" "$alerts buy alert(s) not delivered after 15 minutes"
count backlog app "select count(*) from buybot_candidates where done_at is null and first_seen < $((ms - 1800000))"
[ "$backlog" -gt "${MONITOR_BUYBOT_BACKLOG:-50}" ] && fail "buybot-backlog" "$backlog buy-alert candidate(s) waiting over 30 minutes"
count stalled app "select count(*) from volume_bots where status = 'running' and next_tick_at < $((ms - 600000))"
[ "$stalled" -gt 0 ] && fail "volumebot-stalled" "$stalled running Volume Bot(s) not stepped for over 10 minutes"

[ "$query_failed" -ne 0 ] && fail "monitor-queries" "a monitoring query returned no number (database or schema problem)"

if [ "$mode" = --status ]; then
  [ "${#failing[@]}" -eq 0 ] && echo "all checks ok"
  for k in "${failing[@]}"; do echo "FAIL $k: ${detail[$k]}"; done
  exit 0
fi

# The verdict the app shows on /health (as "ops": ok, degraded, or unknown once this stops running),
# so an outside uptime check sees host problems too. No check is named there.
printf '{"ok":%s,"at":%s,"failing":%s}\n' "$([ "${#failing[@]}" -eq 0 ] && echo true || echo false)" "$now" "${#failing[@]}" > "$root/control/.monitor.json"
chmod 644 "$root/control/.monitor.json"
mv -f "$root/control/.monitor.json" "$root/control/monitor.json"

# Alert on changes: new failures, failures still open after $realert, recoveries.
messages=()
for k in "${failing[@]}"; do
  f="$state/fail-$k"
  if [ ! -s "$f" ]; then
    printf '%s %s' "$now" "$now" > "$f"
    messages+=("🔴 ${detail[$k]}")
  else
    read -r since last < "$f"
    if [ $((now - last)) -ge "$realert" ]; then
      printf '%s %s' "$since" "$now" > "$f"
      messages+=("🔴 still failing for $(((now - since) / 3600)) h: ${detail[$k]}")
    fi
  fi
done
for f in "$state"/fail-*; do
  [ -e "$f" ] || continue
  k=${f##*/fail-}
  printf '%s\n' "${failing[@]}" | grep -qx -- "$k" && continue
  read -r since _ < "$f"
  messages+=("✅ recovered after $(((now - since) / 60)) min: $k")
  rm -f "$f"
done
flush_pending
if [ "${#messages[@]}" -gt 0 ]; then
  send "NEARKITS $(hostname) · $(date -u +%H:%MZ)
$(printf '%s\n' "${messages[@]}")"
fi

# A daily line that says all is well, so silence never hides a broken alert channel.
today=$(date -u +%F)
if [ "$(date -u +%-H)" -ge "$digest_hour" ] && [ "$(cat "$state/digest" 2> /dev/null)" != "$today" ]; then
  printf '%s' "$today" > "$state/digest"
  if [ "${#failing[@]}" -eq 0 ]; then
    send "🟢 NEARKITS daily check: all $(hostname) checks pass. Last off-site backup $(cut -d' ' -f2 backups/.offsite.ok 2> /dev/null || echo none)."
  else
    send "🟠 NEARKITS daily check: ${#failing[@]} check(s) failing: ${failing[*]}"
  fi
fi
exit 0

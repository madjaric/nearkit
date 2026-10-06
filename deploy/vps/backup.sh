#!/usr/bin/env bash
# Hourly backups (DEPLOYMENT.md §11), run by the nearkit-backup timer: both databases
# (pg_dump) and OpenBao's storage (a raft snapshot). They stay on this server, root-only;
# Hostinger's weekly server backups include them. Keeps every backup for 48 hours, then the
# midnight (UTC) one of each day for 30 days. None opens a wallet key by itself: the signer's
# dump holds data keys sealed by OpenBao, and OpenBao's snapshot is sealed by its master
# key, which only the owner's unseal key opens.
set -euo pipefail
dir=/opt/nearkit/backups
umask 077
install -d -m 700 "$dir"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
cd /opt/nearkit
# Each backup is taken on its own: one that fails (a database restarting) never skips the others,
# and the run still ends as failed, so the timer's journal shows it.
failed=0
# Chained with && (errexit doesn't apply inside a function called with ||): a step that fails
# stops this dump, and a dump that can't be listed is never kept as a backup.
dump() {
  local service=$1 user=$2 name=$3
  local out="$dir/$name-$stamp.dump"
  docker compose exec -T "$service" pg_dump -U "$user" -d "$name" --format=custom --compress=9 > "$out.partial" &&
    docker compose exec -T "$service" pg_restore --list < "$out.partial" > /dev/null &&
    mv "$out.partial" "$out"
}
for spec in app-db:nearkit:nearkit signer-db:nearkit_signer:nearkit_signer; do
  IFS=: read -r service user name <<<"$spec"
  dump "$service" "$user" "$name" || { echo "backup FAILED: $name" >&2; failed=1; }
done
bao=$(docker compose ps -q openbao 2>/dev/null || true)
if [ -n "$bao" ] && [ -s secrets/openbao_backup_token ]; then
  BAO_TOKEN=$(cat secrets/openbao_backup_token)
  export BAO_TOKEN
  x() { docker exec -i -e BAO_ADDR=https://127.0.0.1:8200 -e BAO_CACERT=/openbao/tls/openbao.crt -e BAO_TOKEN "$bao" "$@"; }
  # Renewing keeps the backup token alive; the snapshot fails while OpenBao is sealed.
  if x bao token renew >/dev/null 2>&1 && x bao operator raft snapshot save /tmp/openbao.snap >/dev/null 2>&1; then
    x cat /tmp/openbao.snap > "$dir/openbao-$stamp.snap.partial"
    mv "$dir/openbao-$stamp.snap.partial" "$dir/openbao-$stamp.snap"
  else
    echo "OpenBao snapshot skipped: sealed or unavailable"
  fi
  x rm -f /tmp/openbao.snap >/dev/null 2>&1 || true
  unset BAO_TOKEN
fi
find "$dir" \( -name '*.dump' -o -name '*.snap' \) -mmin +2880 ! -name '*T00*' -delete
find "$dir" \( -name '*.dump' -o -name '*.snap' \) -mtime +30 -delete
find "$dir" -name '*.partial' -mmin +60 -delete
if [ "$failed" -ne 0 ]; then
  echo "backup at $stamp INCOMPLETE: see the lines above" >&2
  exit 1
fi
echo "backed up at $stamp"

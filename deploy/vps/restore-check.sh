#!/usr/bin/env bash
# Restore check (DEPLOYMENT.md §12): proves that an off-site backup decrypts and restores, in an
# isolated Docker environment on any machine with Docker, git and the backup identity. It never
# touches production: it reads the backup repository and runs throwaway containers on an internal
# Docker network (no published ports), all removed at the end with the decrypted files.
#
#   deploy/vps/restore-check.sh <age-identity-file> [branch] [--unseal]
#
# Checks, in order:
#   1. the ciphertext matches the manifest's checksums, and decrypts with the identity;
#   2. the plaintext matches the manifest's checksums;
#   3. both databases restore into fresh Postgres 17 (schema version and row counts are printed);
#   4. OpenBao's raft snapshot restores into a fresh OpenBao, which then needs the PRODUCTION
#      unseal key: the throwaway key that set it up no longer opens it;
#   5. the configuration archive holds what a rebuild needs (names only are printed).
# With --unseal (the owner only, in their own terminal) it also asks for the unseal key, unseals the
# restored OpenBao, and proves the signer's own token still encrypts and decrypts with the wallet
# key. Nothing secret is printed: no key, token, dump content or plaintext.
set -euo pipefail
identity=""
branch=""
unseal=false
for a in "$@"; do
  case "$a" in
    --unseal) unseal=true ;;
    *) if [ -z "$identity" ]; then identity=$a; else branch=$a; fi ;;
  esac
done
[ -n "$identity" ] && [ -s "$identity" ] || { echo "usage: restore-check.sh <age-identity-file> [branch] [--unseal]" >&2; exit 2; }
remote=${NEARKIT_BACKUP_REMOTE:-https://github.com/madjaric/nearkit-backups.git}
pg=postgres:17-alpine
bao_image=quay.io/openbao/openbao:2.6.3
tag="nkrestore-$$"
# On Windows (Git Bash), Docker needs Windows paths and MSYS must leave container paths alone
# (only for docker: git and the rest keep MSYS's path handling).
docker() { MSYS_NO_PATHCONV=1 command docker "$@"; }
host() { if command -v cygpath > /dev/null; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

work=$(mktemp -d)
cleanup() {
  docker rm -f "$tag-app" "$tag-signer" "$tag-bao" > /dev/null 2>&1 || true
  docker network rm "$tag" > /dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
step() { printf '\n== %s\n' "$*"; }
ok() { printf '   ok  %s\n' "$*"; }
die() {
  printf '   FAIL %s\n' "$*" >&2
  exit 1
}
sum() { sha256sum < "$1" | cut -d' ' -f1; }

step "backup"
# Every check below runs in Docker: a stopped engine is said as such, never as a wrong identity.
docker info > /dev/null 2>&1 || die "Docker isn't running: start Docker Desktop (or the Docker service) and run this again"
if [ -z "$branch" ]; then
  branch=$(git ls-remote --heads "$remote" 'b-*' | sed 's#.*refs/heads/##' | sort | tail -1)
  [ -n "$branch" ] || die "no backup branch in $remote"
fi
git -c core.autocrlf=false clone -q --depth 1 --branch "$branch" "$remote" "$work/repo" || die "can't fetch $branch"
tr -d '\r' < "$work/repo/MANIFEST" > "$work/manifest"
ok "$branch"

step "1. ciphertext"
n=0
while read -r kind digest _ name; do
  [ "$kind" = cipher ] || continue
  [ "$(sum "$work/repo/$name")" = "$digest" ] || die "$name: checksum differs from the manifest"
  n=$((n + 1))
done < "$work/manifest"
[ "$n" -gt 0 ] || die "the manifest lists no files"
ok "$n file(s) match the manifest"
mkdir -p "$work/plain"
cp "$identity" "$work/identity"
docker run --rm -v "$(host "$work"):/w" alpine:3.20 sh -c \
  'apk add --no-cache age > /dev/null 2>&1 && for f in /w/repo/*.age; do age -d -i /w/identity -o "/w/plain/$(basename "$f" .age)" "$f" || exit 1; done' ||
  die "decryption failed (wrong identity?)"
rm -f "$work/identity"
ok "decrypted with the identity"

step "2. plaintext"
while read -r kind digest _ name; do
  [ "$kind" = plain ] || continue
  [ "$(sum "$work/plain/$name")" = "$digest" ] || die "$name: decrypted content differs from the manifest"
done < "$work/manifest"
ok "every file matches the checksum taken before encryption"

step "3. databases"
docker network create --internal "$tag" > /dev/null
start_pg() { docker run -d --name "$1" --network "$tag" -e POSTGRES_USER="$2" -e POSTGRES_DB="$2" -e POSTGRES_PASSWORD=restore-check "$pg" > /dev/null; }
start_pg "$tag-app" nearkit
start_pg "$tag-signer" nearkit_signer
wait_pg() { for _ in $(seq 60); do docker exec "$1" pg_isready -U "$2" -d "$2" > /dev/null 2>&1 && return 0; sleep 1; done; die "$1 didn't start"; }
wait_pg "$tag-app" nearkit
wait_pg "$tag-signer" nearkit_signer
restore() {
  local c=$1 db=$2 dump
  dump=$(ls "$work"/plain/"$db"-*.dump | head -1)
  docker cp "$(host "$dump")" "$c:/tmp/restore.dump" > /dev/null
  docker exec "$c" pg_restore -U "$db" -d "$db" --no-owner --exit-on-error /tmp/restore.dump || die "$db didn't restore"
}
q() { docker exec "$1" psql -U "$2" -d "$2" -tA -F ' ' -c "$3"; }
restore "$tag-app" nearkit
ok "app database: schema $(q "$tag-app" nearkit "select value from meta where key='schema_version'")"
ok "  users $(q "$tag-app" nearkit "select count(*) from telegram_users") · active NEARKITS wallets $(q "$tag-app" nearkit "select count(*) from trading_wallets where status='active'") · intents $(q "$tag-app" nearkit "select count(*) from wallet_intents") · bridge orders $(q "$tag-app" nearkit "select count(*) from bridge_orders")"
restore "$tag-signer" nearkit_signer
ok "signer database: keys $(q "$tag-signer" nearkit_signer "select string_agg(status||' '||n, ', ') from (select status, count(*) n from signer_keys group by 1 order by 1) x")"
sealed=$(q "$tag-signer" nearkit_signer "select count(*) from signer_keys where status='active' and sealed_key is not null")
[ "$sealed" -gt 0 ] || die "no sealed wallet key in the signer database"
ok "  $sealed active wallet key(s), each sealed (none readable without OpenBao)"

step "4. OpenBao"
snap=$(ls "$work"/plain/openbao-*.snap 2> /dev/null | head -1 || true)
[ -n "$snap" ] || die "no OpenBao snapshot in this backup"
mkdir -p "$work/bao"
cp "$snap" "$work/bao/openbao.snap"
cat > "$work/bao/bao.hcl" << 'EOF'
disable_mlock = true
storage "raft" {
  path    = "/raft"
  node_id = "restore-check"
}
listener "tcp" {
  address     = "127.0.0.1:8200"
  tls_disable = true
}
api_addr     = "http://127.0.0.1:8200"
cluster_addr = "http://127.0.0.1:8201"
EOF
docker run -d --name "$tag-bao" --network "$tag" --user 0 --tmpfs /raft -v "$(host "$work/bao"):/check:ro" \
  --entrypoint bao "$bao_image" server -config=/check/bao.hcl > /dev/null
b() { docker exec -e BAO_ADDR=http://127.0.0.1:8200 "$tag-bao" "$@"; }
for _ in $(seq 30); do b bao status > /dev/null 2>&1 && break; [ $? -eq 2 ] && break; sleep 1; done
# A throwaway setup (key and token exist only inside this container), then the production snapshot.
docker exec -e BAO_ADDR=http://127.0.0.1:8200 "$tag-bao" sh -c '
  set -e
  init=$(bao operator init -key-shares=1 -key-threshold=1)
  key=$(printf "%s\n" "$init" | sed -n "s/^Unseal Key 1: //p")
  tok=$(printf "%s\n" "$init" | sed -n "s/^Initial Root Token: //p")
  bao operator unseal "$key" > /dev/null
  for i in $(seq 30); do BAO_TOKEN=$tok bao operator raft list-peers > /dev/null 2>&1 && break; sleep 1; done
  BAO_TOKEN=$tok bao operator raft snapshot restore -force /check/openbao.snap
  printf "%s" "$key" > /tmp/throwaway.key
' > /dev/null || die "the snapshot didn't restore"
sleep 3
status=$(b bao status 2>&1 || true)
printf '%s\n' "$status" | grep -q '^Initialized *true' || die "restored OpenBao isn't initialized"
if printf '%s\n' "$status" | grep -q '^Sealed *false'; then
  # Still open with the throwaway key: seal it, and it must refuse that key from now on.
  docker exec -e BAO_ADDR=http://127.0.0.1:8200 "$tag-bao" sh -c 'BAO_TOKEN= bao operator seal' > /dev/null 2>&1 || true
fi
if docker exec -e BAO_ADDR=http://127.0.0.1:8200 "$tag-bao" sh -c 'bao operator unseal "$(cat /tmp/throwaway.key)"' > /dev/null 2>&1 &&
  b bao status 2>&1 | grep -q '^Sealed *false'; then
  die "the restored OpenBao opens with the throwaway key: the snapshot didn't replace its keyring"
fi
ok "the snapshot restored, and OpenBao now needs the production unseal key (the throwaway key is refused)"

step "5. configuration"
cfg=$(ls "$work"/plain/config-*.tar.gz | head -1)
listing=$(tar -tzf "$cfg")
for need in secrets/openbao_token secrets/signer_auth_key secrets/telegram_bot_token secrets/app_db_password \
  secrets/signer_db_password app.env signer.env buybot.env .env docker-compose.yml openbao.hcl data/openbao-tls/openbao.crt data/openbao-tls/openbao.key; do
  printf '%s\n' "$listing" | grep -qx "$need" || die "the configuration lacks $need"
done
ok "the configuration archive holds the secrets, env files, compose and OpenBao TLS a rebuild needs"

if $unseal; then
  step "6. unseal (owner)"
  mkdir -p "$work/cfg"
  tar -xzf "$cfg" -C "$work/cfg" secrets/openbao_token
  docker cp "$(host "$work/cfg/secrets/openbao_token")" "$tag-bao:/tmp/signer.token" > /dev/null
  rm -rf "$work/cfg"
  printf 'Production unseal key (not shown, not stored): '
  read -rs unseal_key < /dev/tty
  printf '\n'
  printf '%s' "$unseal_key" | docker exec -i -e BAO_ADDR=http://127.0.0.1:8200 "$tag-bao" bao operator unseal - > /dev/null || die "that key doesn't unseal this backup"
  unset unseal_key
  # The signer's own token, against the wallet key: encrypt and decrypt a test value.
  docker exec -e BAO_ADDR=http://127.0.0.1:8200 "$tag-bao" sh -c '
    export BAO_TOKEN=$(cat /tmp/signer.token)
    ctx=$(printf restore-check | base64)
    ct=$(bao write -field=ciphertext transit/encrypt/nearkit-wallets plaintext=$(printf restore-check | base64) context=$ctx)
    pt=$(bao write -field=plaintext transit/decrypt/nearkit-wallets ciphertext=$ct context=$ctx | base64 -d)
    [ "$pt" = restore-check ]
  ' || die "the signer's token can't use the wallet key in the restored OpenBao"
  ok "unsealed with the production key; the signer's token encrypts and decrypts with the wallet key"
fi

printf '\nRESTORE CHECK PASSED for %s\n' "$branch"

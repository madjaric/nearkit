#!/usr/bin/env bash
# Off-host copies of the hourly backups (DEPLOYMENT.md §12). Each backup (both database dumps and
# OpenBao's raft snapshot), plus the configuration this stack needs to start again (secrets, env
# files, TLS material, compose files), is encrypted with age to the public keys in
# backup-recipients.txt and pushed to a private Git repository, one branch per backup. Only public
# keys are on this server: the identity that decrypts a backup is kept by the owner, never here and
# never in the repository. What leaves is ciphertext plus a manifest of sizes and checksums. Even
# decrypted, no wallet key opens without OpenBao's unseal key, which only the owner has.
#
# Retention mirrors the local one: every backup for 48 hours, then the midnight (UTC) one of each
# day for 30 days. Success and failure are recorded in backups/.offsite.ok / .offsite.error, which
# bin/monitor checks.
#   /opt/nearkit/bin/backup-offsite <stamp>     (bin/backup runs it after each local backup)
set -euo pipefail
stamp="${1:?usage: backup-offsite <stamp>}"
[[ "$stamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { echo "not a backup stamp: $stamp" >&2; exit 2; }
root=/opt/nearkit
conf="$root/backup-offsite.env"
dir="$root/backups"
status="$dir/.offsite"
umask 077

fail() {
  printf '%s %s %s\n' "$(date -u +%s)" "$stamp" "$1" > "$status.error"
  echo "off-site backup FAILED: $1" >&2
  exit 1
}

# BACKUP_REMOTE (git@github.com:<owner>/<repo>.git), BACKUP_SSH_KEY (a deploy key with write access),
# BACKUP_KNOWN_HOSTS (the host keys of that Git server) and BACKUP_RECIPIENTS (age public keys).
[ -s "$conf" ] || fail "not configured ($conf is missing)"
# shellcheck source=/dev/null
. "$conf"
for v in BACKUP_REMOTE BACKUP_SSH_KEY BACKUP_KNOWN_HOSTS BACKUP_RECIPIENTS; do
  [ -n "${!v:-}" ] || fail "$v is not set in $conf"
done
command -v age > /dev/null || fail "age is not installed (apt-get install age)"
grep -q '^age1' "$BACKUP_RECIPIENTS" 2> /dev/null || fail "$BACKUP_RECIPIENTS holds no age public key"
[ -s "$BACKUP_SSH_KEY" ] || fail "the deploy key $BACKUP_SSH_KEY is missing"
[ -s "$BACKUP_KNOWN_HOSTS" ] || fail "the host keys $BACKUP_KNOWN_HOSTS are missing"

files=()
for f in "$dir/nearkit-$stamp.dump" "$dir/nearkit_signer-$stamp.dump" "$dir/openbao-$stamp.snap"; do
  [ -s "$f" ] && files+=("$f")
done
[ "${#files[@]}" -gt 0 ] || fail "no local backup for $stamp"

work=$(mktemp -d "$dir/.offsite-work.XXXXXX")
trap 'rm -rf "$work"' EXIT
out="$work/repo"
mkdir "$out"

# The configuration to start this stack again, as it is now. Only what exists is packed.
config=()
for p in secrets app.env signer.env buybot.env .env docker-compose.yml Caddyfile openbao.hcl \
  backup-offsite.env backup-recipients.txt github_known_hosts data/openbao-tls data/signer-tls; do
  [ -e "$root/$p" ] && config+=("$p")
done
tar -C "$root" -czf "$work/config-$stamp.tar.gz" "${config[@]}" || fail "packing the configuration"

encrypt() { age --encrypt -R "$BACKUP_RECIPIENTS" -o "$out/$(basename "$1").age" "$1"; }
for f in "${files[@]}" "$work/config-$stamp.tar.gz"; do
  encrypt "$f" || fail "encrypting $(basename "$f")"
done
# Every file that leaves must be age ciphertext: its header says so.
for f in "$out"/*.age; do
  [ "$(head -c 21 "$f")" = "age-encryption.org/v1" ] || fail "$(basename "$f") is not age ciphertext"
done

sum() { sha256sum < "$1" | cut -d' ' -f1; }
{
  echo "nearkits backup $stamp ($(hostname))"
  echo "age recipients: $(grep '^age1' "$BACKUP_RECIPIENTS" | tr '\n' ' ')"
  for f in "${files[@]}" "$work/config-$stamp.tar.gz"; do
    printf 'plain  %s %10s %s\n' "$(sum "$f")" "$(stat -c %s "$f")" "$(basename "$f")"
  done
  for f in "$out"/*.age; do
    printf 'cipher %s %10s %s\n' "$(sum "$f")" "$(stat -c %s "$f")" "$(basename "$f")"
  done
} > "$out/MANIFEST"

export GIT_SSH_COMMAND="ssh -i $BACKUP_SSH_KEY -o IdentitiesOnly=yes -o UserKnownHostsFile=$BACKUP_KNOWN_HOSTS -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=30"
g() { git -C "$out" -c user.name=nearkits-backup -c user.email=backup@nearkits.invalid "$@"; }
branch="b-$stamp"
g init -q
g add -A
g commit -qm "nearkits backup $stamp"
commit=$(g rev-parse HEAD)
g push -q "$BACKUP_REMOTE" "HEAD:refs/heads/$branch" 2> "$work/push.err" || fail "push to the off-site repository: $(tr '\n' ' ' < "$work/push.err" | cut -c1-200)"
# The branch on the server must be exactly this commit (its hash covers every file's content).
remote=$(g ls-remote "$BACKUP_REMOTE" "refs/heads/$branch" | cut -f1)
[ "$remote" = "$commit" ] || fail "the off-site branch $branch doesn't match what was pushed"

# Retention. A failure here keeps more copies than needed, never fewer: it is reported, not fatal.
now=$(date -u +%s)
old=()
while read -r _ ref; do
  b=${ref#refs/heads/}
  [[ "$b" =~ ^b-([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z$ ]] || continue
  [ "$b" = "$branch" ] && continue
  t=$(date -u -d "${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]}T${BASH_REMATCH[4]}:${BASH_REMATCH[5]}:${BASH_REMATCH[6]}Z" +%s) || continue
  hours=$(((now - t) / 3600))
  if { [ "${BASH_REMATCH[4]}" != 00 ] && [ "$hours" -ge 48 ]; } || [ "$hours" -ge $((30 * 24)) ]; then old+=("$b"); fi
done < <(g ls-remote --heads "$BACKUP_REMOTE" 'b-*')
if [ "${#old[@]}" -gt 0 ]; then
  g push -q "$BACKUP_REMOTE" --delete "${old[@]}" 2> /dev/null || echo "off-site retention: couldn't delete ${#old[@]} old branch(es); kept" >&2
fi

printf '%s %s %s\n' "$(date -u +%s)" "$stamp" "$branch" > "$status.ok"
rm -f "$status.error"
echo "off-site copy $branch: ${#files[@]} backup file(s) + configuration, encrypted ($(du -sh "$out" --exclude=.git | cut -f1))"

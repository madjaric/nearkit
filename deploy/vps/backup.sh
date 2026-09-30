#!/usr/bin/env bash
# Hourly logical backups of both NearKit databases (DEPLOYMENT.md §11), run by the
# nearkit-backup timer. Dumps stay on this server, root-only; Hostinger's weekly server
# backups include them. Keeps every dump for 48 hours, then the midnight (UTC) dump of each
# day for 30 days. The signer's dump holds only KMS-sealed keys.
set -euo pipefail
dir=/opt/nearkit/backups
umask 077
install -d -m 700 "$dir"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
cd /opt/nearkit
for spec in app-db:nearkit:nearkit signer-db:nearkit_signer:nearkit_signer; do
  IFS=: read -r service user name <<<"$spec"
  out="$dir/$name-$stamp.dump"
  docker compose exec -T "$service" pg_dump -U "$user" -d "$name" --format=custom --compress=9 > "$out.partial"
  # A dump that can't be listed is not a backup.
  docker compose exec -T "$service" pg_restore --list < "$out.partial" > /dev/null
  mv "$out.partial" "$out"
done
find "$dir" -name '*.dump' -mmin +2880 ! -name '*T00*' -delete
find "$dir" -name '*.dump' -mtime +30 -delete
find "$dir" -name '*.partial' -mmin +60 -delete
echo "backed up at $stamp"

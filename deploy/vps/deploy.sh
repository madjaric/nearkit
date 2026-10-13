#!/usr/bin/env bash
# Builds a commit of NEARKITS on the VPS and installs this directory's scripts, systemd units and
# compose file (DEPLOYMENT.md §11). It restarts NOTHING: it points the named services at the new
# image in .env and prints the command that moves each one, to run once nothing is in flight.
# Each node service has its own image tag in .env (NEARKIT_APP_TAG, NEARKIT_BUYBOT_TAG,
# NEARKIT_SIGNER_TAG), so a build for the app never moves the signer or the buy bot.
#
#   /opt/nearkit/bin/deploy <commit> [app|buybot|signer …]   build <commit>; point the named services (default: app) at it
#   /opt/nearkit/bin/deploy --rollback <service> <tag>       point one service back at an image already on this host
#
# A commit is built only once GitHub's CI passed on it (NEARKIT_DEPLOY_SKIP_CI=1 skips that check,
# for an emergency only).
set -euo pipefail
cd /opt/nearkit
env=.env
upper() { tr '[:lower:]' '[:upper:]' <<< "$1"; }
settag() {
  if grep -q "^$1=" "$env"; then sed -i "s/^$1=.*/$1=$2/" "$env"; else printf '%s=%s\n' "$1" "$2" >> "$env"; fi
}
check_service() {
  case "$1" in app | buybot | signer) ;; *)
    echo "unknown service: $1 (app, buybot or signer)" >&2
    exit 2
    ;;
  esac
}
apply_hint() {
  local profile=
  [ "$1" = signer ] && profile="--profile signer "
  echo "  docker compose ${profile}up -d --no-deps --wait $1"
}

# One tag per service. A host still on the old shared NEARKIT_IMAGE_TAG gets each service's tag from
# the image that service runs now, so nothing changes until a service is deployed on purpose.
for svc in app buybot signer; do
  var="NEARKIT_$(upper "$svc")_TAG"
  grep -q "^$var=" "$env" && continue
  t=$(docker inspect -f '{{.Config.Image}}' "nearkit-$svc-1" 2> /dev/null | sed -n 's/^nearkit-server://p')
  [ -n "$t" ] || t=$(sed -n 's/^NEARKIT_IMAGE_TAG=//p' "$env")
  [ -n "$t" ] || {
    echo "can't tell which image $svc runs; set $var in $env" >&2
    exit 1
  }
  settag "$var" "$t"
  echo "$var=$t (what $svc runs now)"
done
sed -i '/^NEARKIT_IMAGE_TAG=/d' "$env"

if [ "${1:-}" = --rollback ]; then
  svc="${2:?usage: deploy --rollback <app|buybot|signer> <tag>}"
  tag="${3:?usage: deploy --rollback <service> <tag>}"
  check_service "$svc"
  docker image inspect "nearkit-server:$tag" > /dev/null 2>&1 || {
    echo "nearkit-server:$tag is not on this host" >&2
    exit 1
  }
  settag "NEARKIT_$(upper "$svc")_TAG" "$tag"
  echo "$svc is set to nearkit-server:$tag. Apply it once nothing is in flight (DEPLOYMENT.md §11):"
  apply_hint "$svc"
  exit 0
fi

commit="${1:?usage: deploy <commit> [app|buybot|signer …] | deploy --rollback <service> <tag>}"
shift
services=("$@")
[ "${#services[@]}" -gt 0 ] || services=(app)
for svc in "${services[@]}"; do check_service "$svc"; done

[ -d src/.git ] || git clone --quiet https://github.com/madjaric/nearkit.git src
git -C src fetch --quiet origin
git -C src checkout --quiet --detach "$commit"
full=$(git -C src rev-parse HEAD)
sha=${full:0:12}

if [ "${NEARKIT_DEPLOY_SKIP_CI:-}" != 1 ]; then
  # Every check run on the commit completed and passed (the CI workflow's jobs).
  verdict=$(curl -fsS --max-time 20 -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/madjaric/nearkit/commits/$full/check-runs?per_page=100" | python3 -c '
import json, sys
runs = json.load(sys.stdin).get("check_runs", [])
if not runs: print("none"); sys.exit()
bad = [r["name"] for r in runs if r.get("status") != "completed" or r.get("conclusion") not in ("success", "skipped", "neutral")]
print("ok" if not bad else "failing: " + ", ".join(bad))') || verdict="unreachable"
  [ "$verdict" = ok ] || {
    echo "not deploying $sha: CI is $verdict (DEPLOYMENT.md §11)" >&2
    exit 1
  }
fi

# Built first: a build that fails changes nothing on this host.
docker build --quiet --build-arg "NEARKIT_BUILD_SHA=$sha" -f src/server/Dockerfile -t "nearkit-server:$sha" src > /dev/null
cp src/deploy/vps/docker-compose.yml src/deploy/vps/Caddyfile src/deploy/vps/openbao.hcl .
install -m 755 src/deploy/vps/set-secret bin/set-secret
install -m 755 src/deploy/vps/deploy.sh bin/deploy
install -m 755 src/deploy/vps/backup.sh bin/backup
install -m 755 src/deploy/vps/backup-offsite.sh bin/backup-offsite
install -m 755 src/deploy/vps/monitor.sh bin/monitor
install -m 755 src/deploy/vps/openbao-init bin/openbao-init
install -m 755 src/deploy/vps/openbao-unseal bin/openbao-unseal
install -m 644 src/deploy/vps/backup-recipients.txt backup-recipients.txt
[ -s backup-offsite.env ] || install -m 644 src/deploy/vps/backup-offsite.env.example backup-offsite.env
[ -e monitor.env ] || install -m 644 src/deploy/vps/monitor.env.example monitor.env
install -m 644 src/deploy/vps/nearkit-backup.service src/deploy/vps/nearkit-backup.timer \
  src/deploy/vps/nearkit-monitor.service src/deploy/vps/nearkit-monitor.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now nearkit-backup.timer nearkit-monitor.timer > /dev/null
for svc in "${services[@]}"; do settag "NEARKIT_$(upper "$svc")_TAG" "$sha"; done

# Kept: every image a service is set to (the rollback targets among them) and the five newest.
keep=$(sed -n 's/^NEARKIT_[A-Z]*_TAG=//p' "$env")
docker images nearkit-server --format '{{.Tag}}' | tail -n +6 | while read -r t; do
  grep -qx "$t" <<< "$keep" || docker rmi "nearkit-server:$t" > /dev/null 2>&1 || true
done

echo "built nearkit-server:$sha; set for: ${services[*]}. Apply once nothing is in flight (DEPLOYMENT.md §11):"
for svc in "${services[@]}"; do apply_hint "$svc"; done

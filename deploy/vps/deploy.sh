#!/usr/bin/env bash
# Builds a commit of NearKit on the VPS and (re)starts the stack with it.
#   /opt/nearkit/bin/deploy <commit>
set -euo pipefail
commit="${1:?usage: deploy <commit>}"
cd /opt/nearkit
[ -d src/.git ] || git clone --quiet https://github.com/madjaric/nearkit.git src
git -C src fetch --quiet origin
git -C src checkout --quiet --detach "$commit"
sha=$(git -C src rev-parse --short=12 HEAD)
cp src/deploy/vps/docker-compose.yml src/deploy/vps/Caddyfile .
install -m 755 src/deploy/vps/set-secret bin/set-secret
install -m 755 src/deploy/vps/deploy.sh bin/deploy
docker build --quiet -f src/server/Dockerfile -t "nearkit-server:$sha" src >/dev/null
sed -i "s/^NEARKIT_IMAGE_TAG=.*/NEARKIT_IMAGE_TAG=$sha/" .env
echo "built nearkit-server:$sha"

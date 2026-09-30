#!/usr/bin/env bash
# Prepares a fresh Ubuntu 24.04 VPS for NearKit (DEPLOYMENT.md §11). Run once as root; safe
# to run again. It prints no secret: the ones it makes are written straight to files.
#
#   ssh root@<host> 'bash -s' < deploy/vps/bootstrap.sh
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "== packages and security updates"
apt-get update -q
apt-get -y -q -o Dpkg::Options::=--force-confold upgrade
apt-get -y -q install ca-certificates curl gnupg ufw unattended-upgrades git openssl
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "== SSH: keys only"
cat > /etc/ssh/sshd_config.d/10-nearkit.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
X11Forwarding no
EOF
sshd -t
systemctl reload ssh

echo "== firewall: SSH and HTTPS only (Docker publishes 80/443 for Caddy alone)"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

echo "== Docker from Docker's own repository"
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
apt-get update -q
apt-get -y -q install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" },
  "live-restore": true,
  "no-new-privileges": true
}
EOF
systemctl restart docker

echo "== layout under /opt/nearkit"
install -d -m 755 /opt/nearkit /opt/nearkit/bin /opt/nearkit/control
install -d -m 700 /opt/nearkit/secrets
# The signer (uid 1000) keeps its TLS key and certificate here.
install -d -m 700 -o 1000 -g 1000 /opt/nearkit/data /opt/nearkit/data/signer-tls

echo "== secrets made here (never printed)"
secret() { # name, generator
  local f="/opt/nearkit/secrets/$1"
  if [ ! -s "$f" ]; then (umask 077 && eval "$2" > "$f"); echo "made $1"; else echo "kept $1"; fi
  chown 1000:1000 "$f"
  chmod 400 "$f"
}
secret signer_auth_key 'openssl rand -base64 32 | tr -d "\n"'
secret app_db_password 'openssl rand -hex 32 | tr -d "\n"'
secret signer_db_password 'openssl rand -hex 32 | tr -d "\n"'
secret app_database_url 'printf "postgres://nearkit:%s@app-db:5432/nearkit" "$(cat /opt/nearkit/secrets/app_db_password)"'
secret signer_database_url 'printf "postgres://nearkit_signer:%s@signer-db:5432/nearkit_signer" "$(cat /opt/nearkit/secrets/signer_db_password)"'

echo "== done"
docker --version
docker compose version
ufw status | head -3

#!/usr/bin/env bash
# One-time preparation of an Ubuntu 24.04 droplet for MDRS Viewer.
# Run as root on the droplet:  bash setup-droplet.sh <hostname> <basic-auth-user> <basic-auth-password>
# Installs Node 22, nginx, certbot; creates the `mdrs` user, /opt/mdrs-viewer,
# a systemd service on 127.0.0.1:3000 and an nginx reverse proxy with basic auth.
# Then run deploy/publish.sh from your machine and, once DNS points here:
#   certbot --nginx -d <hostname> --redirect -m <email> --agree-tos -n
set -euo pipefail
HOSTNAME_FQDN="${1:?hostname}"; AUTH_USER="${2:?user}"; AUTH_PASS="${3:?password}"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq nginx ufw apache2-utils certbot python3-certbot-nginx rsync >/dev/null
if ! swapon --show | grep -q swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1)" != "v22" ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
id mdrs >/dev/null 2>&1 || useradd -r -m -d /var/lib/mdrs -s /usr/sbin/nologin mdrs
mkdir -p /opt/mdrs-viewer && chown -R mdrs:mdrs /opt/mdrs-viewer
cat > /etc/systemd/system/mdrs-viewer.service <<'UNIT'
[Unit]
Description=MDRS Viewer (Next.js)
After=network.target

[Service]
Type=simple
User=mdrs
Group=mdrs
WorkingDirectory=/opt/mdrs-viewer
Environment=NODE_ENV=production
ExecStart=/usr/bin/node node_modules/next/dist/bin/next start -p 3000 -H 127.0.0.1
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable mdrs-viewer
htpasswd -bc /etc/nginx/.htpasswd "$AUTH_USER" "$AUTH_PASS"
chown root:www-data /etc/nginx/.htpasswd && chmod 640 /etc/nginx/.htpasswd
sed "s/__HOST__/$HOSTNAME_FQDN/" "$(dirname "$0")/nginx.conf" > /etc/nginx/sites-available/mdrs-viewer
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/mdrs-viewer /etc/nginx/sites-enabled/mdrs-viewer
nginx -t && systemctl enable --now nginx && systemctl reload nginx
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw --force enable
echo "ready: node $(node -v)"

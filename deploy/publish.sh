#!/usr/bin/env bash
# Deploy MDRS Viewer (Next.js) to the droplet.
#   ./deploy/publish.sh [host] [samples-dir]
# host         default mdrs.termspace.com (ssh as root)
# samples-dir  folder whose files replace public/samples on the server
#              (must contain manifest.json); default ../mdrs-viewer-site/samples
# Requires the droplet to have been prepared with deploy/setup-droplet.sh.
set -euo pipefail
HOST="${1:-mdrs.termspace.com}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SAMPLES="${2:-$ROOT/../mdrs-viewer-site/samples}"
DEFAULT_PKG="${DEFAULT_PKG:-ES1000122_20260601}"
APP=/opt/mdrs-viewer

[ -f "$SAMPLES/manifest.json" ] || { echo "no manifest.json in $SAMPLES" >&2; exit 1; }

echo ">> sync source"
rsync -az --delete \
  --exclude node_modules --exclude .next --exclude out --exclude standalone \
  --exclude .git --exclude .DS_Store --exclude 'public/samples/' \
  --rsync-path="sudo -u mdrs rsync" \
  "$ROOT/" "root@$HOST:$APP/"

echo ">> sync samples ($(ls "$SAMPLES" | wc -l | tr -d ' ') files)"
rsync -az --delete --exclude .DS_Store --rsync-path="sudo -u mdrs rsync" \
  "$SAMPLES/" "root@$HOST:$APP/public/samples/"

echo ">> build and restart"
ssh "root@$HOST" "set -e; cd $APP
  sudo -u mdrs -H env NEXT_PUBLIC_DEFAULT_PKG='$DEFAULT_PKG' bash -c 'npm ci --no-audit --no-fund && npm run build'
  systemctl restart mdrs-viewer
  sleep 2; systemctl is-active mdrs-viewer"
echo "Published: https://$HOST/"

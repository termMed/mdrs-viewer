# Deploying MDRS Viewer to a droplet

Target: `mdrs-viewer` droplet (DigitalOcean, termMed team, nyc2, 1 vCPU / 2 GB,
Ubuntu 24.04), reachable as https://mdrs.termspace.com behind nginx basic auth.
The Next.js app runs as the `mdrs` system user from `/opt/mdrs-viewer`
(systemd service `mdrs-viewer`, port 3000 on localhost); nginx proxies it and
terminates TLS (Let's Encrypt, auto-renewed by certbot's timer).

## Publish a new version

```bash
./deploy/publish.sh                      # host mdrs.termspace.com, samples from ../mdrs-viewer-site/samples
./deploy/publish.sh mdrs.termspace.com /path/to/samples
DEFAULT_PKG=INT_20260701 ./deploy/publish.sh   # change the package shown on load
```

The script rsyncs the source (not node_modules/.next), replaces `public/samples`
with the given folder (it must contain `manifest.json` listing every file), then
runs `npm ci && npm run build` on the droplet and restarts the service. A build
takes about a minute on the 2 GB droplet (a 2 GB swap file gives it headroom).

## Server operations

```bash
ssh root@mdrs.termspace.com systemctl status mdrs-viewer
ssh root@mdrs.termspace.com journalctl -u mdrs-viewer -n 100 -f
ssh root@mdrs.termspace.com 'htpasswd /etc/nginx/.htpasswd <user>'   # add or change a reviewer login
ssh root@mdrs.termspace.com 'htpasswd -D /etc/nginx/.htpasswd <user>' # remove one
```

To open the site to the public, comment out the two `auth_basic` lines in
`/etc/nginx/sites-available/mdrs-viewer` and `nginx -t && systemctl reload nginx`.

## Rebuilding from scratch

1. Create an Ubuntu 24.04 droplet with your SSH key and point a DNS A record at it
   (`doctl compute domain records create termspace.com --record-type A --record-name mdrs --record-data <ip>`).
2. Copy `deploy/` to the droplet and run
   `bash setup-droplet.sh mdrs.termspace.com <user> <password>` as root.
3. `./deploy/publish.sh <host>` from this folder.
4. `ssh root@<host> certbot --nginx -d mdrs.termspace.com --redirect -m <email> --agree-tos -n`

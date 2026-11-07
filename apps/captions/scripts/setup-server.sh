#!/bin/sh
# One command on your own server (SELF_HOSTING.md): writes .env with your domain and a random APP_SECRET (kept if one
# is already set), readable only by you, then starts the app and Caddy (HTTPS for the domain) with Docker Compose.
# Run it again after a change: it keeps .env and rebuilds.
#   cd apps/captions && scripts/setup-server.sh tools.example.com
set -eu
cd "$(dirname "$0")/.."

domain="${1:-}"
case "$domain" in
  "" | *[!A-Za-z0-9.-]* | .* | *. )
    echo "Give your server's name, e.g.: scripts/setup-server.sh tools.example.com (no https://, no path)" >&2
    exit 1 ;;
esac
if [ "$(uname -m)" != x86_64 ]; then
  echo "The Docker image is for x86_64 (amd64) Linux; this machine is $(uname -m)." >&2
  exit 1
fi
command -v docker >/dev/null || { echo "Install Docker Engine and the Compose plugin first (docs.docker.com/engine/install)." >&2; exit 1; }

umask 077
[ -f .env ] || cp .env.example .env
chmod 600 .env
sed -i "s|^DOMAIN=.*|DOMAIN=$domain|" .env
# the sign-in secret and the first password: made here, never printed
grep -q '^APP_SECRET=.\{16,\}' .env || sed -i "s|^APP_SECRET=.*|APP_SECRET=$(openssl rand -base64 32)|" .env

docker compose up -d --build
echo
echo "Started. Check: curl -fsS https://$domain/api/health"
echo "Sign in at https://$domain as admin; the first password is APP_SECRET in $(pwd)/.env."

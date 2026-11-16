#!/bin/sh
# Keeps a Docker install of your own server up to date (SELF_HOSTING.md, step 10). Run it every few minutes from cron
# on the machine that runs the app:
#   */5 * * * * CT_UPDATE_HOUR=4 /opt/creator-toolset/apps/captions/scripts/server-update.sh >> /var/log/creator-toolset-update.log 2>&1
# Each run tells the app what is waiting (Settings → Storage → Update). It updates when an admin presses Update now
# there, and by itself in the hour CT_UPDATE_HOUR names (0 to 23, this machine's clock; unset = only on the button).
# An update is step 10: pull, build, wait for running work, restart. A build that fails is not tried again until an
# admin presses Retry or a newer change arrives.
# ponytail: no rollback. If the new build does not start, the way back is step 10's: check out the previous commit,
# build, up -d. Add one here when a failed start has cost someone a night.
set -eu
cd "$(dirname "$0")/.."
if command -v flock >/dev/null; then exec 9>"${TMPDIR:-/tmp}/creator-toolset-update.lock"; flock -n 9 || exit 0; fi

app() { docker compose exec -T app "$@"; }
note() { echo "$(date '+%F %T') $*"; }
# the app's own answer on its own port: `idle` also passes while the app is down (nothing to wait for)
ask() { app node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>r.json()).then($1,$2)"; }
idle() { ask "h=>process.exit((h.answering||0)+(h.working||0)?1:0)" "()=>process.exit(0)"; }
up() { ask "h=>process.exit(h.ok?0:1)" "()=>process.exit(1)"; }
status() { # <changes waiting> <true|false: the last update failed>
  printf '{"behind":%s,"nightly":%s,"failed":%s}\n' "$1" "$next" "$2" |
    app sh -c 'd="$DATA_DIR/server-update"; mkdir -p "$d" && cat > "$d/status.part" && mv "$d/status.part" "$d/status.json"'
}
answered() { app sh -c 'rm -f "$DATA_DIR/server-update/request"'; }

hour=""
case "${CT_UPDATE_HOUR:-}" in [0-9] | [01][0-9] | 2[0-3]) hour=$(expr "$CT_UPDATE_HOUR" + 0 || true) ;; esac
now=$(expr "$(date +%H)" + 0 || true)
# when the next nightly update is due, as a moment: the page shows it in its reader's own time zone
next=null
if [ -n "$hour" ]; then
  s=$(date +%s)
  next=$((s - s % 60 + ((hour - now + 24) % 24) * 3600 - $(expr "$(date +%M)" + 0 || true) * 60))
  [ "$next" -gt "$s" ] || next=$((next + 86400))
fi

git fetch -q origin
new=$(git rev-parse -q --verify '@{u}' || git rev-parse origin/main)
running=$(git config --get creatortoolset.running || git rev-parse HEAD)
behind=$(git rev-list --count "$running..$new")
failed=false
[ "$(git config --get creatortoolset.failed || true)" = "$new" ] && failed=true
asked=0
app sh -c 'test -e "$DATA_DIR/server-update/request"' && asked=1

due=$asked # the button also tries a failed build again
[ -n "$hour" ] && [ "$now" = "$hour" ] && [ "$failed" = false ] && due=1
if [ "$behind" = 0 ] || [ "$due" = 0 ]; then
  if [ "$behind" = 0 ] && [ "$asked" = 1 ]; then answered; fi
  status "$behind" "$failed"
  exit 0
fi

note "updating to $(git rev-parse --short "$new")"
status "$behind" false
if ! { git merge -q --ff-only "$new" && docker compose build; }; then
  note "the build failed"
  git config creatortoolset.failed "$new"
  answered
  status "$behind" true
  exit 1
fi
# wait while work is running that the restart would end; after 25 minutes the next run takes it up (the build is kept)
n=0
until idle; do
  n=$((n + 1))
  [ "$n" -lt 100 ] || { note "work is still running, trying again on the next run"; exit 0; }
  sleep "${CT_UPDATE_WAIT:-15}"
done
docker compose up -d
n=0
until up; do
  n=$((n + 1))
  [ "$n" -lt 40 ] || { note "the new build did not start"; git config creatortoolset.failed "$new"; exit 1; }
  sleep 3
done
git config creatortoolset.running "$new"
git config --unset creatortoolset.failed || true
answered
status 0 false
note "updated"

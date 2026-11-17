#!/bin/sh
# Keeps a Docker install of your own server up to date (SELF_HOSTING.md, step 10). Run it every few minutes from cron
# on the machine that runs the app:
#   */5 * * * * CT_UPDATE_HOUR=4 /opt/creator-toolset/apps/captions/scripts/server-update.sh >> /var/log/creator-toolset-update.log 2>&1
# Each run tells the app what is waiting (Settings → Storage → Update). It updates when an admin presses Update now
# there, and each night from the hour CT_UPDATE_HOUR names (0 to 23, this machine's clock; unset = only on the button).
# An update never cuts work the server is doing: it asks the server to take no new job (server-update/drain), and
# restarts only once nothing is running, however long that takes (each run looks again). Then it is step 10: pull,
# build, restart. A build that fails is not tried again until an admin presses Retry or a newer change arrives.
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
status() { # <changes waiting> <true|false: the last update failed> [waiting]
  printf '{"behind":%s,"nightly":%s,"failed":%s,"waiting":%s}\n' "$1" "$next" "$2" "$([ "${3:-}" = waiting ] && echo true || echo false)" |
    app sh -c 'd="$DATA_DIR/server-update"; mkdir -p "$d" && cat > "$d/status.part" && mv "$d/status.part" "$d/status.json"'
}
# in the app's data folder: the request (an admin's, or the night's) and the drain (no new job while it is fresh)
data() { app sh -c "d=\"\$DATA_DIR/server-update\"; mkdir -p \"\$d\" && $1"; }
done_() { data 'rm -f "$d/request" "$d/drain"'; }

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

if [ "$behind" = 0 ]; then
  done_
  status 0 false
  exit 0
fi
# the night asks as an admin would, so an update that has to wait for running work still happens that night
if [ -n "$hour" ] && [ "$now" = "$hour" ] && [ "$failed" = false ]; then data 'touch "$d/request"'; fi
if ! data 'test -e "$d/request"'; then
  status "$behind" "$failed"
  exit 0
fi

# no new job from here on; the running ones finish (the next run looks again)
data 'touch "$d/drain"'
if ! idle; then
  status "$behind" false waiting
  exit 0
fi
note "updating to $(git rev-parse --short "$new")"
status "$behind" false
if ! { git merge -q --ff-only "$new" && docker compose build; }; then
  note "the build failed"
  git config creatortoolset.failed "$new"
  done_
  status "$behind" true
  exit 1
fi
# work that started during the build: wait for it too (the drain is refreshed so it holds)
n=0
until idle; do
  n=$((n + 1))
  [ "$n" -lt 40 ] || { status "$behind" false waiting; exit 0; } # the next run takes it up; the build is kept
  data 'touch "$d/drain"'
  sleep "${CT_UPDATE_WAIT:-15}"
done
# a dated copy of what the new version's migrations may change, on the data disk, before it starts: the library's
# database (a consistent copy while the app runs), Settings → Folders, the server's video work switch, offline lists
stamp=$(date -u +%Y%m%dT%H%M%SZ)
if ! data "b=\"\$DATA_DIR/backups/$stamp\"; mkdir -p \"\$b\" && for f in server-work.json storage offline; do [ ! -e \"\$DATA_DIR/\$f\" ] || cp -R \"\$DATA_DIR/\$f\" \"\$b/\"; done" ||
  ! app node -e "const d=process.env.DATA_DIR,f=d+'/library/library.db';if(require('fs').existsSync(f))new (require('node:sqlite').DatabaseSync)(f).exec(\"VACUUM INTO '\"+d+'/backups/$stamp/library.db'+\"'\")"; then
  note "the backup before the update failed"
  git config creatortoolset.failed "$new"
  done_
  status "$behind" true
  exit 1
fi
# ponytail: the newest 5 backups are kept, by count (never by age); a size cap if a library.db grows past the disk's room
data 'ls -1d "$DATA_DIR"/backups/*/ 2>/dev/null | sort | head -n -5 | while read -r o; do rm -rf "$o"; done'
docker compose up -d
n=0
until up; do
  n=$((n + 1))
  [ "$n" -lt 40 ] || { note "the new build did not start"; git config creatortoolset.failed "$new"; done_; exit 1; }
  sleep 3
done
git config creatortoolset.running "$new"
git config --unset creatortoolset.failed || true
done_
status 0 false
note "updated"

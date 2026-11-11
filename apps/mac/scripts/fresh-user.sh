#!/bin/bash
# The Mac app as a brand-new user gets it, on this Mac, beside the released app and without touching it.
# Builds a copy with its own bundle id (com.creatortoolset.mac.fresh, name "Creator Toolset Fresh") into
# apps/mac/build/fresh (FRESH_DIR=… for another folder), wipes ONLY that copy's state, and opens it. Its server
# listens on 43129, its data is "Creator Toolset (fresh)", and it does not claim creatortoolset:// links.
#   scripts/fresh-user.sh            wipe the copy's state, then open it: the first run
#   scripts/fresh-user.sh --rebuild  rebuild the copy from this tree first (after code changes)
#   scripts/fresh-user.sh --keep     open it as it is, without wiping
# Every path and Keychain service it wipes must contain "fresh"; the script stops before anything else.
# The AI tools installed on this Mac (Claude Code, Codex…) are still found: they belong to the Mac, not to the app.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
ID="com.creatortoolset.mac.fresh"        # AppIdentity (Identity.swift) for this id: tag " (fresh)", port 43129
NAME="Creator Toolset Fresh"
TAG=" (fresh)"
OUT="${FRESH_DIR:-$here/build/fresh}"
APP="$OUT/$NAME.app"
PAT_APP="$APP/Contents/MacOS/CreatorToolsetMac"
PAT_SERVER="$APP/Contents/Resources/server/bin/node"

die() { echo "fresh-user: $*" >&2; exit 1; }
guard() { case "$1" in *fresh*) ;; *) die "refusing to touch '$1': no fresh marker";; esac; }

rebuild=0; wipe=1
for a in "$@"; do
  case "$a" in
    --rebuild) rebuild=1;;
    --keep) wipe=0;;
    -h|--help) sed -n 2,10p "$0"; exit 0;;
    *) die "unknown option $a (see --help)";;
  esac
done
mkdir -p "$OUT"

if [ "$wipe" = 1 ] || [ "$rebuild" = 1 ]; then
  # quit ONLY the copy (matched by its own path), then its server (which exits with it anyway)
  if pgrep -f "$PAT_APP" >/dev/null; then
    echo "Quitting $NAME"
    osascript -e "tell application id \"$ID\" to quit" >/dev/null 2>&1 || true
    for _ in $(seq 1 75); do pgrep -f "$PAT_APP" >/dev/null || break; sleep 0.2; done
    pgrep -f "$PAT_APP" | xargs -r kill -TERM 2>/dev/null || true
  fi
  for _ in $(seq 1 50); do pgrep -f "$PAT_SERVER" >/dev/null || break; sleep 0.2; done
  pgrep -f "$PAT_SERVER" | xargs -r kill -TERM 2>/dev/null || true
  sleep 1
  pgrep -f "$PAT_SERVER" | xargs -r kill -KILL 2>/dev/null || true
fi

if [ "$wipe" = 1 ]; then
  guard "$ID"
  echo "Wiping the fresh identity's state ($ID):"
  if defaults read "$ID" >/dev/null 2>&1; then echo "  defaults domain $ID"; defaults delete "$ID"; fi
  for p in \
    "$HOME/Library/Application Support/Creator Toolset$TAG" \
    "$HOME/Library/WebKit/$ID" \
    "$HOME/Library/HTTPStorages/$ID" \
    "$HOME/Library/HTTPStorages/$ID.binarycookies" \
    "$HOME/Library/Caches/$ID" \
    "$HOME/Library/Saved Application State/$ID.savedState" \
    "$HOME/Library/Containers/$ID" \
    "$HOME/Library/Logs/Creator Toolset$TAG.log" \
    "$HOME/Library/Logs/Creator Toolset$TAG.log.1" \
    "$HOME/Library/Logs/Creator Toolset$TAG Server.log" \
    "$HOME/Library/Logs/Creator Toolset$TAG Server.log.1" \
    "$HOME/Movies/Creator Toolset$TAG"; do
    [ -e "$p" ] || continue
    guard "$p"
    echo "  $p"
    rm -rf -- "$p"
  done
  # the copy's own entry in Claude Code and Codex (api/lib/local-ai.ts mcpName: creator-toolset-fresh), added when
  # Install is pressed in the copy; a login shell finds the tools the way Terminal does
  MCP="creator-toolset-fresh"; guard "$MCP"
  /bin/zsh -lic "command -v claude >/dev/null && claude mcp remove --scope user $MCP; command -v codex >/dev/null && codex mcp remove $MCP" >/dev/null 2>&1 || true
  echo "  $MCP removed from Claude Code and Codex (if it was there)"
  for kind in server account device env plugins; do
    svc="$ID.$kind"; guard "$svc"
    n=0
    while [ "$n" -lt 100 ] && security delete-generic-password -s "$svc" >/dev/null 2>&1; do n=$((n + 1)); done
    echo "  keychain $svc: $n item(s) removed"
  done
fi

if [ "$rebuild" = 1 ] || [ ! -x "$PAT_APP" ]; then
  echo "Building $NAME into $OUT (the first build downloads Node, FFmpeg and more)"
  # BUILD_ENV=/dev/null and the empty settings keep apps/mac/build.env's signing and update feed out of the copy
  BUILD_ENV=/dev/null BUNDLE_ID="$ID" APP_NAME="$NAME" OUT="$APP" \
    SIGN_IDENTITY= SPARKLE_PUBLIC_KEY= FEED_URL= DEFAULT_SERVER= "$here/scripts/build-app.sh"
fi

open "$APP"
echo "Opened $APP (server on 127.0.0.1:43129). The released app is not touched."

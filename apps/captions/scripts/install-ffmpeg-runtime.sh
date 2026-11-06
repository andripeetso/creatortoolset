#!/usr/bin/env bash
# Install the retained, checksum-pinned FFmpeg 7.1 Linux build used by exports.
# The optional second argument is a persistent archive cache across deploys.
set -euo pipefail

DEST=${1:?usage: install-ffmpeg-runtime.sh DEST [CACHE_ARCHIVE]}
CACHE=${2:-/tmp/captions-ffmpeg-7.1.5.tar.xz}
URL=https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-06-30-13-34/ffmpeg-n7.1.5-1-g7d0e842004-linux64-gpl-7.1.tar.xz
SHA=f0c580f5f12af54e8c9c649c70b2d25f264edb35393203d34b20cf4f9c126288

if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo "Pinned production FFmpeg build requires Linux x86_64" >&2
  exit 1
fi

mkdir -p "$(dirname "$CACHE")"
if [ ! -f "$CACHE" ] || ! printf '%s  %s\n' "$SHA" "$CACHE" | sha256sum -c - >/dev/null 2>&1; then
  download=$(mktemp)
  trap 'rm -f "$download"' EXIT
  curl -fL "$URL" -o "$download"
  printf '%s  %s\n' "$SHA" "$download" | sha256sum -c -
  mv "$download" "$CACHE"
  trap - EXIT
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tar -xJf "$CACHE" -C "$work"
binary=$(find "$work" -type f -path '*/bin/ffmpeg' -print -quit)
if [ -z "$binary" ]; then
  echo "Pinned FFmpeg archive did not contain bin/ffmpeg" >&2
  exit 1
fi
mkdir -p "$DEST"
install -m 0755 "$binary" "$DEST/ffmpeg"
"$DEST/ffmpeg" -hide_banner -version | head -n 1 | grep -E 'ffmpeg version n?7\.1'

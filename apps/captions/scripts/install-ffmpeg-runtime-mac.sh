#!/usr/bin/env bash
# Install the checksum-pinned static FFmpeg 7.1 macOS arm64 build (ffmpeg and ffprobe) the Mac app bundles.
# The Linux twin is install-ffmpeg-runtime.sh. CACHE is a folder that keeps the downloads between builds.
#   install-ffmpeg-runtime-mac.sh DEST CACHE
set -euo pipefail

DEST=${1:?usage: install-ffmpeg-runtime-mac.sh DEST CACHE}
CACHE=${2:?usage: install-ffmpeg-runtime-mac.sh DEST CACHE}
BASE=https://ffmpeg.martin-riedl.de/download/macos/arm64/1741000090_7.1.1
SHA_ffmpeg=e18c39a330ad783c33d6d7b47784e82a42f8acdbb497a1f73550f1bc0e830d44
SHA_ffprobe=4eeb4644703bed221eec72107fbe2cc1e1180a3605c53136866cf43886d0499a

if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo "The pinned macOS FFmpeg build is for Apple silicon Macs" >&2
  exit 1
fi

mkdir -p "$CACHE" "$DEST"
for tool in ffmpeg ffprobe; do
  sha_var="SHA_$tool"
  zip="$CACHE/$tool-7.1.1-macos-arm64.zip"
  if [ ! -f "$zip" ] || ! printf '%s  %s\n' "${!sha_var}" "$zip" | shasum -a 256 -c - >/dev/null 2>&1; then
    curl -fL "$BASE/$tool.zip" -o "$zip.part"
    printf '%s  %s\n' "${!sha_var}" "$zip.part" | shasum -a 256 -c -
    mv "$zip.part" "$zip"
  fi
  rm -f "$DEST/$tool"
  ditto -x -k "$zip" "$DEST"
  if [ ! -f "$DEST/$tool" ]; then
    echo "The pinned $tool archive did not contain $tool" >&2
    exit 1
  fi
  chmod 0755 "$DEST/$tool"
  "$DEST/$tool" -hide_banner -version | head -n 1 | grep -E "$tool version n?7\.1"
done

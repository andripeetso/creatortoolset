#!/usr/bin/env bash
# Meta's unmodified reference implementations. No API keys or external uploads.
set -euo pipefail
DEST=${1:-runtime/fingerprints}
CACHE=${2:-/tmp/captions-threatexchange-ec3671b.tar.gz}
REV=ec3671bafc70136c4178ac300b75281ee4c6a0c6
SHA=d7a145d31ce1ab75a2dd8c8483e1bf4a0bd3c680ef4d26d602dfb2195a17c8cd

compiler=${CXX:-c++}
pdq_flags=()
if [ "$(uname -s)" = Darwin ]; then
  # The serial scorer includes omp.h even though it calls no OpenMP functions.
  omp_prefix=$(brew --prefix libomp 2>/dev/null || true)
  if [ ! -f "$omp_prefix/include/omp.h" ]; then
    echo 'Install the build headers with brew install libomp, then rerun.' >&2
    exit 1
  fi
  compiler="$compiler -I$omp_prefix/include"
  # CImg predates Clang's nontrivial-memcall warning; keep other warnings enabled.
  pdq_flags=("WFLAGS=-Wall -Wno-deprecated-declarations -Wno-nontrivial-memcall")
fi

verify() {
  if command -v sha256sum >/dev/null; then
    printf '%s  %s\n' "$SHA" "$1" | sha256sum -c - >/dev/null 2>&1
  else
    printf '%s  %s\n' "$SHA" "$1" | shasum -a 256 -c - >/dev/null 2>&1
  fi
}
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
if [ ! -f "$CACHE" ] || ! verify "$CACHE"; then
  curl -fL "https://codeload.github.com/facebook/ThreatExchange/tar.gz/$REV" -o "$scratch/source.tar.gz"
  verify "$scratch/source.tar.gz"
  mkdir -p "$(dirname "$CACHE")"
  cp "$scratch/source.tar.gz" "$CACHE"
fi
tar -xzf "$CACHE" -C "$scratch"
source_dir="$scratch/ThreatExchange-$REV"
make -C "$source_dir/tmk/cpp" -j2 CXX="$compiler" tmk-hash-video tmk-two-level-score
make -C "$source_dir/pdq/cpp" CXX="$compiler" "${pdq_flags[@]}" pdq-photo-hasher
mkdir -p "$DEST"
install -m 0755 "$source_dir/tmk/cpp/tmk-hash-video" "$DEST/"
install -m 0755 "$source_dir/tmk/cpp/tmk-two-level-score" "$DEST/"
install -m 0755 "$source_dir/pdq/cpp/pdq-photo-hasher" "$DEST/"
cp "$source_dir/LICENSE" "$DEST/THREATEXCHANGE-LICENSE"
# CImg's separate license notice is retained with the binary distribution.
sed -n '1,120p' "$source_dir/pdq/cpp/CImg.h" > "$DEST/CIMG-NOTICE"
printf '{"revision":"%s","archiveSha256":"%s"}\n' "$REV" "$SHA" > "$DEST/manifest.json"
echo "Fingerprint tools installed in $DEST"

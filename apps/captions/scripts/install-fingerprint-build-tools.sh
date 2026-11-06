#!/usr/bin/env bash
# An app-owned compiler for the Ubuntu 22.04 production host. No sudo, system
# package installation, or changes to other services are needed.
set -euo pipefail
DEST=${1:-$HOME/.cache/fingerprint-build-tools}
DEST=$(mkdir -p "$DEST" && cd "$DEST" && pwd)
if [ -x "$DEST/bin/c++" ] && [ -x "$DEST/bin/make" ]; then
  "$DEST/bin/c++" --version >/dev/null
  exit 0
fi
. /etc/os-release
if [ "$ID" != ubuntu ] || [ "$VERSION_ID" != 22.04 ] || [ "$(uname -m)" != x86_64 ]; then
  echo 'Install a C++14 compiler and make for this platform before deploying.' >&2
  exit 1
fi
scratch=$(mktemp -d "$DEST/packages.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$DEST/sysroot" "$DEST/bin"
cd "$scratch"
# apt verifies archive hashes against the host's configured package indexes.
apt-get download make gcc-11 g++-11 cpp-11 gcc-11-base libstdc++-11-dev \
  libgcc-11-dev libc6-dev linux-libc-dev libcrypt-dev libmpc3 libisl23 libgmp10 libmpfr6
for package in ./*.deb; do dpkg-deb -x "$package" "$DEST/sysroot"; done
ln -sfn /lib "$DEST/sysroot/lib"
ln -sfn /lib64 "$DEST/sysroot/lib64"
cat > "$DEST/bin/c++" <<'COMPILER'
#!/usr/bin/env bash
set -euo pipefail
toolchain=$(cd "$(dirname "$0")/../sysroot" && pwd)
export LD_LIBRARY_PATH="$toolchain/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$toolchain/usr/bin/g++-11" --sysroot="$toolchain" "$@"
COMPILER
chmod 0755 "$DEST/bin/c++"
ln -sfn ../sysroot/usr/bin/make "$DEST/bin/make"
printf '#include <iostream>\nint main() { std::cout << "Compiler OK\\n"; }\n' \
  | "$DEST/bin/c++" -x c++ - -o "$scratch/check"
"$scratch/check"
echo "Fingerprint build tools installed in $DEST"

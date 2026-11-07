#!/bin/bash
# Builds "Creator Toolset.app" into apps/mac/build: a release binary from the Swift
# package, Sparkle (the updater), the Info.plist, the icon (AppIcon.png), the server the app runs
# (Resources/server: Node, the built web app, its two external packages, FFmpeg, the fingerprint tools and,
# with SSCD_CACHE, the SSCD model), and a code signature. Ad-hoc by default; SIGN_IDENTITY="Developer ID
# Application: …" signs for other Macs (with the hardened runtime notarization needs). The build number is the
# repo's commit count, so every release is newer than the one before. Apple silicon only.
#   SPARKLE_PUBLIC_KEY=…  the EdDSA public key of your Sparkle signing key (Sparkle's generate_keys)
#   FEED_URL=…            the appcast the app reads (with SPARKLE_PUBLIC_KEY; set both or neither)
#   NOTARY_PROFILE=…      a notarytool keychain profile: with SIGN_IDENTITY, notarizes and staples the app
#   SSCD_CACHE=…          a verified SSCD model folder (see install-sscd-runtime.mjs); unset = no duplicate check model
#   CT_BUILD_CACHE=…      where downloads are kept between builds (default build/cache)
# Without both Sparkle settings, the app is built with no updater: it never checks for or installs updates.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
repo="$(cd "$here/../.." && pwd)"
captions="$repo/apps/captions"
cache="${CT_BUILD_CACHE:-$here/build/cache}"
mkdir -p "$cache"
# the install scripts make temp folders: keep them next to the build, not in the system temp folder
export TMPDIR="$here/build/tmp"
mkdir -p "$TMPDIR"

swift build -c release
bin="$(swift build -c release --show-bin-path)/CreatorToolsetMac"
app="$here/build/Creator Toolset.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$app/Contents/Frameworks"
cp "$bin" "$app/Contents/MacOS/CreatorToolsetMac"
ditto "$(dirname "$bin")/Sparkle.framework" "$app/Contents/Frameworks/Sparkle.framework"
install_name_tool -add_rpath "@executable_path/../Frameworks" "$app/Contents/MacOS/CreatorToolsetMac"
build="${BUILD_NUMBER:-$(git rev-list --count HEAD 2>/dev/null || echo 1)}"  # BUILD_NUMBER: for trying an update locally

sparkle=""
if [ -n "${SPARKLE_PUBLIC_KEY:-}" ] && [ -n "${FEED_URL:-}" ]; then
  sparkle="  <key>SUFeedURL</key><string>$FEED_URL</string>
  <key>SUPublicEDKey</key><string>$SPARKLE_PUBLIC_KEY</string>
  <key>SUEnableAutomaticChecks</key><true/>
  <key>SUAutomaticallyUpdate</key><true/>
  <key>SUScheduledCheckInterval</key><integer>14400</integer>"
elif [ -n "${SPARKLE_PUBLIC_KEY:-}${FEED_URL:-}" ]; then
  echo "Set both SPARKLE_PUBLIC_KEY and FEED_URL for updates, or neither." >&2
  exit 1
fi

# a release (signed with SIGN_IDENTITY) tells its bundled server so (CT_CHANNEL, Server.swift); ad-hoc builds don't
channel=""
[ -z "${SIGN_IDENTITY:-}" ] || channel="  <key>CTChannel</key><string>release</string>"

cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.creatortoolset.mac</string>
  <key>CFBundleName</key><string>Creator Toolset</string>
  <key>CFBundleDisplayName</key><string>Creator Toolset</string>
  <key>CFBundleExecutable</key><string>CreatorToolsetMac</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.$build</string>
  <key>CFBundleVersion</key><string>$build</string>
$sparkle
$channel
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleURLTypes</key><array><dict>
    <key>CFBundleURLName</key><string>Creator Toolset link</string>
    <key>CFBundleURLSchemes</key><array><string>creatortoolset</string></array>
  </dict></array>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>LSUIElement</key><false/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST

# AppIcon.png (1024 px, the macOS squircle with its margin; made by the iPhone app icon script)
# becomes the .icns; skipped if it is missing.
src="$here/AppIcon.png"
if [ -f "$src" ]; then
  set_dir="$here/build/AppIcon.iconset"   # build output, not the system temp folder
  rm -rf "$set_dir" && mkdir -p "$set_dir"
  for s in 16 32 128 256 512; do
    sips -z "$s" "$s" "$src" --out "$set_dir/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) "$src" --out "$set_dir/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns -o "$app/Contents/Resources/AppIcon.icns" "$set_dir"
  rm -rf "$set_dir"
fi

# ---- the server the app runs (Server.swift starts server/bin/node dist/boot.js in server/) ----
NODE_VERSION=v22.23.4
NODE_SHA=c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428
server="$app/Contents/Resources/server"
mkdir -p "$server/bin" "$server/runtime"

(cd "$repo" && pnpm --filter @creator-toolset/captions build)
ditto "$captions/dist" "$server/dist"
ditto "$captions/packs" "$server/packs"   # the shipped packs (api/official-packs.ts reads ../packs from dist/)
printf '{"private":true,"type":"module"}\n' > "$server/package.json"   # dist/boot.js is an ES module

node_tar="$cache/node-$NODE_VERSION-darwin-arm64.tar.gz"
if [ ! -f "$node_tar" ] || ! printf '%s  %s\n' "$NODE_SHA" "$node_tar" | shasum -a 256 -c - >/dev/null 2>&1; then
  curl -fL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-darwin-arm64.tar.gz" -o "$node_tar.part"
  printf '%s  %s\n' "$NODE_SHA" "$node_tar.part" | shasum -a 256 -c -
  mv "$node_tar.part" "$node_tar"
fi
tar -xzf "$node_tar" -C "$server/bin" --strip-components 2 "node-$NODE_VERSION-darwin-arm64/bin/node"
tar -xzf "$node_tar" -C "$server" --strip-components 1 "node-$NODE_VERSION-darwin-arm64/LICENSE"
mv "$server/LICENSE" "$server/NODE-LICENSE"

# the two packages the bundle leaves outside (package.json "build"), at the versions the app pins.
# --ignore-scripts: playwright-chromium's install would download Chromium (the server does that on the first export)
pin() { node -p "require('$captions/package.json').dependencies['$1']"; }
npm install --prefix "$server" --omit=dev --no-package-lock --no-save --ignore-scripts --no-audit --no-fund \
  "onnxruntime-node@$(pin onnxruntime-node)" "playwright-chromium@$(pin playwright-chromium)"
[ -f "$server/node_modules/playwright-core/cli.js" ] || { echo "playwright-core is missing" >&2; exit 1; }
ort="$server/node_modules/onnxruntime-node/bin/napi-v6"
[ -d "$ort/darwin/arm64" ] || { echo "onnxruntime-node has no darwin/arm64 build at $ort" >&2; exit 1; }
find "$ort" -mindepth 1 -maxdepth 1 ! -name darwin -exec rm -rf {} +
find "$ort/darwin" -mindepth 1 -maxdepth 1 ! -name arm64 -exec rm -rf {} +

bash "$captions/scripts/install-ffmpeg-runtime-mac.sh" "$server/runtime" "$cache"
bash "$captions/scripts/install-fingerprint-runtime.sh" "$server/runtime/fingerprints" "$cache/threatexchange-ec3671b.tar.gz"
if [ -n "${SSCD_CACHE:-}" ]; then
  node "$captions/scripts/install-sscd-runtime.mjs" "$server/runtime/sscd" "$SSCD_CACHE"
else
  echo "SSCD_CACHE unset: the app ships without the SSCD model (the duplicate check skips it)"
fi

# inside out: the server's programs, Sparkle's helpers, Sparkle, then the app (Sparkle's documented order)
id="${SIGN_IDENTITY:--}"
opts=(--force --sign "$id")
[ "$id" != "-" ] && opts+=(--options runtime --timestamp)
while IFS= read -r -d '' f; do
  if file -b "$f" | grep -q Mach-O; then
    if [ "$f" = "$server/bin/node" ] && [ "$id" != "-" ]; then
      # V8 compiles at run time: the hardened runtime needs the JIT entitlement for node
      codesign "${opts[@]}" --entitlements "$here/scripts/node.entitlements" "$f"
    else
      codesign "${opts[@]}" "$f"
    fi
  fi
done < <(find "$server" -type f \( -perm -u+x -o -name '*.node' -o -name '*.dylib' \) -print0)
fw="$app/Contents/Frameworks/Sparkle.framework/Versions/B"
codesign "${opts[@]}" "$fw/XPCServices/Installer.xpc"
codesign "${opts[@]}" --preserve-metadata=entitlements "$fw/XPCServices/Downloader.xpc"
codesign "${opts[@]}" "$fw/Autoupdate"
codesign "${opts[@]}" "$fw/Updater.app"
codesign "${opts[@]}" "$app/Contents/Frameworks/Sparkle.framework"
codesign "${opts[@]}" "$app"

if [ -n "${NOTARY_PROFILE:-}" ]; then
  [ "$id" != "-" ] || { echo "NOTARY_PROFILE needs SIGN_IDENTITY" >&2; exit 1; }
  zip="$here/build/Creator Toolset.zip"
  ditto -c -k --keepParent "$app" "$zip"
  xcrun notarytool submit "$zip" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$app"
  rm -f "$zip"
fi
rm -rf "$TMPDIR"
echo "Built: $app"

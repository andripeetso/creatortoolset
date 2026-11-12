#!/bin/bash
# Builds "Creator Toolset.app" into apps/mac/build: a release binary from the Swift
# package, Sparkle (the updater), the Info.plist, the icon (AppIcon.png), the server the app runs
# (Resources/server: Node, the built web app, its two external packages, the plug-in builder with the app's own
# source, FFmpeg and the fingerprint tools), and a code signature. Ad-hoc by default; SIGN_IDENTITY="Developer ID
# Application: …" signs for other Macs (with the hardened runtime notarization needs). The build number is the
# repo's commit count, so every release is newer than the one before; VERSION=… sets the version people see
# (default 1.0.<build>). Apple silicon only.
#   SPARKLE_PUBLIC_KEY=…  the EdDSA public key of your Sparkle signing key (Sparkle's generate_keys)
#   FEED_URL=…            the appcast the app reads (with SPARKLE_PUBLIC_KEY; set both or neither)
#   NOTARY_PROFILE=…      a notarytool keychain profile: with SIGN_IDENTITY, notarizes and staples the app
#   CT_BUILD_CACHE=…      where downloads are kept between builds (default build/cache)
#   BUNDLE_ID=…           the bundle id (default com.creatortoolset.mac); an installed build keeps its id to keep updating
#   APP_NAME=…            the name in the menu bar and Dock (default Creator Toolset)
#   DEFAULT_SERVER=…      a server added to the Servers list on first launch (https, or localhost); default none
#   OUT=…                 the .app to write (default apps/mac/build/Creator Toolset.app); scripts/fresh-user.sh uses it
#   BUILD_ENV=…           another settings file in place of apps/mac/build.env (/dev/null: none)
#   apps/mac/build.env    the same settings in a git-ignored file (see build.env.example); the file is read first and
#                         any setting already in the environment wins, so release.sh's FEED_URL still applies
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

# this build's own settings (build.env): read it, then put back what the environment already set
given="$(env | grep -E '^(BUNDLE_ID|APP_NAME|DEFAULT_SERVER|SPARKLE_PUBLIC_KEY|FEED_URL|VERSION)=' || true)"
if [ -f "${BUILD_ENV:-$here/build.env}" ]; then set -a; . "${BUILD_ENV:-$here/build.env}"; set +a; fi
while IFS= read -r kv; do [ -z "$kv" ] || export "$kv"; done <<< "$given"
# values go into the XML Info.plist, so & and < are escaped
xml_escape() { printf "%s" "$1" | sed -e "s/&/\\&amp;/g" -e "s/</\\&lt;/g" -e "s/>/\\&gt;/g"; }
bundle_id="$(xml_escape "${BUNDLE_ID:-com.creatortoolset.mac}")"
app_name="$(xml_escape "${APP_NAME:-Creator Toolset}")"

swift build -c release
bin="$(swift build -c release --show-bin-path)/CreatorToolsetMac"
app="${OUT:-$here/build/Creator Toolset.app}"
mkdir -p "$(dirname "$app")"
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
  <key>SUScheduledCheckInterval</key><integer>3600</integer>"
elif [ -n "${SPARKLE_PUBLIC_KEY:-}${FEED_URL:-}" ]; then
  echo "Set both SPARKLE_PUBLIC_KEY and FEED_URL for updates, or neither." >&2
  exit 1
fi

# a release (signed with SIGN_IDENTITY) tells its bundled server so (CT_CHANNEL, Server.swift); ad-hoc builds don't
channel=""
[ -z "${SIGN_IDENTITY:-}" ] || channel="  <key>CTChannel</key><string>release</string>"

# the server the Servers list gets once on first launch (Shell.swift reads CTDefaultServer)
default_server=""
[ -z "${DEFAULT_SERVER:-}" ] || default_server="  <key>CTDefaultServer</key><string>$(xml_escape "$DEFAULT_SERVER")</string>"

# a copy beside the released app (com.creatortoolset.mac.<name>, Identity.swift) does not claim creatortoolset:// links:
# they stay the released app's
url_types="  <key>CFBundleURLTypes</key><array><dict>
    <key>CFBundleURLName</key><string>Creator Toolset link</string>
    <key>CFBundleURLSchemes</key><array><string>creatortoolset</string></array>
  </dict></array>"
case "${BUNDLE_ID:-}" in com.creatortoolset.mac.?*) url_types="";; esac

cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>$bundle_id</string>
  <key>CFBundleName</key><string>$app_name</string>
  <key>CFBundleDisplayName</key><string>$app_name</string>
  <key>CFBundleExecutable</key><string>CreatorToolsetMac</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION:-1.0.$build}</string>
  <key>CFBundleVersion</key><string>$build</string>
$sparkle
$channel
$default_server
  <key>CFBundleIconFile</key><string>AppIcon</string>
$url_types
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>LSUIElement</key><false/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>So you can talk to the assistant instead of typing, and your voice is in your screen recordings.</string>
  <key>NSCameraUsageDescription</key><string>So your camera can be in your screen recordings, and to record the screen of an iPhone or iPad on a cable.</string>
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

cp "$repo/LICENSE" "$repo/THIRD_PARTY_NOTICES.md" "$app/Contents/Resources/"   # the licences travel with the app

# ---- the server the app runs (Server.swift starts server/bin/node dist/boot.js in server/) ----
NODE_VERSION=v22.23.4
NODE_SHA=c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428
server="$app/Contents/Resources/server"
mkdir -p "$server/bin" "$server/runtime"

# CT_PLUGIN_HOST=1: the build lists every module of the app (scripts/plugins.mjs), so a plug-in from the person's own
# plug-ins folder, built by itself on their Mac, can use the app's one copy of each (api/lib/folder-plugins.ts)
(cd "$repo" && CT_PLUGIN_HOST=1 pnpm --filter @creator-toolset/captions build)
ditto "$captions/dist" "$server/dist"
# that build wrote the two lists into the checkout (api/ and src/plugin-host.gen.ts): the empty ones go back, so a test
# run that follows in this checkout is not the Mac build's by accident (a web build writes them again itself)
(cd "$captions" && node scripts/plugins.mjs >/dev/null)
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

# the two packages the bundle leaves outside (package.json "build"), at the versions the app pins, and the plug-in
# builder's four (esbuild, Tailwind and what it needs), at the versions this checkout has installed.
# --ignore-scripts: playwright-chromium's install would download Chromium (the server does that on the first export)
pin() { node -p "require('$captions/package.json').dependencies['$1']"; }
has() { node -p "require('$captions/node_modules/$1/package.json').version"; }
npm install --prefix "$server" --omit=dev --no-package-lock --no-save --ignore-scripts --no-audit --no-fund \
  "onnxruntime-node@$(pin onnxruntime-node)" "playwright-chromium@$(pin playwright-chromium)" \
  "esbuild@$(has esbuild)" "tailwindcss@$(has tailwindcss)" "tailwindcss-animate@$(has tailwindcss-animate)" "postcss@$(has postcss)"
[ -x "$server/node_modules/@esbuild/darwin-arm64/bin/esbuild" ] || { echo "esbuild's program is missing" >&2; exit 1; }
rm -rf "$server/node_modules/fsevents"   # a file watcher's native part: the builder never watches

# the app's own source, for two readers: the plug-in builder (source/scripts/plugin-build.mjs reads which modules the
# app has, its page paths and its Tailwind theme) and the AI that writes a plug-in (the files this very build was made
# from, with PLUGINS.md). Listed by name, so nothing else in a checkout (plugins/, .env, runtime/) can ride along.
src_out="$server/source"
mkdir -p "$src_out/scripts"
# HELD_STEPS: steps that are in the repo but not offered by a released app yet (the app lists the folders it finds
# here), by folder name, space-separated. A step's name comes out in the commit that brings its two real edits (one with
# no step on, one with it on). Empty is fine: the list below is read so that bash 3.2 with set -u takes an empty one.
HELD_STEPS=""
held=(); for s in $HELD_STEPS; do held+=(--exclude "/$s"); done
for d in api src contracts db plugin-examples editor-steps; do   # editor-steps: the AI Editor's steps, put in on Turn on
  more=(); [ "$d" = editor-steps ] && more=(${held[@]+"${held[@]}"})
  rsync -a --exclude '*.test.*' --exclude '*.spec.*' --exclude '*.gen.ts' --exclude 'node_modules' ${more[@]+"${more[@]}"} "$captions/$d/" "$src_out/$d/"
done
cp "$captions/scripts/plugin-build.mjs" "$captions/scripts/plugin-host.mjs" "$src_out/scripts/"
cp "$captions/package.json" "$captions/tailwind.config.js" "$captions/index.html" "$captions/render.html" "$src_out/"
cp "$repo/PLUGINS.md" "$repo/AGENTS.md" "$src_out/"
# the build's own check: the example plug-in builds with what is inside the app, and nothing else
"$server/bin/node" "$src_out/scripts/plugin-build.mjs" check "$src_out/plugin-examples/hello"
[ -f "$server/node_modules/playwright-core/cli.js" ] || { echo "playwright-core is missing" >&2; exit 1; }
ort="$server/node_modules/onnxruntime-node/bin/napi-v6"
[ -d "$ort/darwin/arm64" ] || { echo "onnxruntime-node has no darwin/arm64 build at $ort" >&2; exit 1; }
find "$ort" -mindepth 1 -maxdepth 1 ! -name darwin -exec rm -rf {} +
find "$ort/darwin" -mindepth 1 -maxdepth 1 ! -name arm64 -exec rm -rf {} +

bash "$captions/scripts/install-ffmpeg-runtime-mac.sh" "$server/runtime" "$cache"
bash "$captions/scripts/install-fingerprint-runtime.sh" "$server/runtime/fingerprints" "$cache/threatexchange-ec3671b.tar.gz"

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
codesign "${opts[@]}" --entitlements "$here/scripts/app.entitlements" "$app"

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

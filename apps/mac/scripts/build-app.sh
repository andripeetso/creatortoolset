#!/bin/bash
# Builds "Creator Toolset.app" into apps/mac/build: a release binary from the Swift
# package, Sparkle (the updater), the Info.plist, the icon (AppIcon.png), and a
# code signature. Ad-hoc by default; SIGN_IDENTITY="Developer ID Application: …" signs for other Macs
# (with the hardened runtime notarization needs). The build number is the repo's commit count, so every
# release is newer than the one before.
#   SPARKLE_PUBLIC_KEY=…  the EdDSA public key of your Sparkle signing key (Sparkle's generate_keys)
#   FEED_URL=…            the appcast the app reads (with SPARKLE_PUBLIC_KEY; set both or neither)
# Without both, the app is built with no updater: it never checks for or installs updates.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"

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
  <key>CFBundleIconFile</key><string>AppIcon</string>
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

# inside out: Sparkle's helpers, Sparkle, then the app (Sparkle's documented order)
id="${SIGN_IDENTITY:--}"
opts=(--force --sign "$id")
[ "$id" != "-" ] && opts+=(--options runtime --timestamp)
fw="$app/Contents/Frameworks/Sparkle.framework/Versions/B"
codesign "${opts[@]}" "$fw/XPCServices/Installer.xpc"
codesign "${opts[@]}" --preserve-metadata=entitlements "$fw/XPCServices/Downloader.xpc"
codesign "${opts[@]}" "$fw/Autoupdate"
codesign "${opts[@]}" "$fw/Updater.app"
codesign "${opts[@]}" "$app/Contents/Frameworks/Sparkle.framework"
codesign "${opts[@]}" "$app"
echo "Built: $app"

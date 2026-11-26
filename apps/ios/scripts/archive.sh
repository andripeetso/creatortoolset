#!/usr/bin/env bash
# Archives the app and uploads it to App Store Connect (TestFlight), signed with your own team:
#   DEVELOPMENT_TEAM=<your team id> apps/ios/scripts/archive.sh
# The bundle id (com.creatortoolset.ios) needs an App Store Connect record under that team; a fork changes
# PRODUCT_BUNDLE_IDENTIFIER in the project first. BUILD_DIR moves the output (default apps/ios/build).
set -euo pipefail
cd "$(dirname "$0")/.."
here=$PWD
: "${DEVELOPMENT_TEAM:?set DEVELOPMENT_TEAM to your Apple team id}"
out="${BUILD_DIR:-build}"
build=$(git rev-list --count HEAD)
# BUNDLE_ID=<id> (and MARKETING_VERSION=<x.y>) archives a scratch copy of the project under that id (the extension
# becomes <id>.share), so a store record under another id can be fed without editing the project.
if [ -n "${BUNDLE_ID:-}" ] || [ -n "${MARKETING_VERSION:-}" ]; then
  scratch=$(cd "$out" 2>/dev/null && pwd || { mkdir -p "$out"; cd "$out" && pwd; })/project
  rm -rf "$scratch" && mkdir -p "$scratch/apps" && cp -R . "$scratch/apps/ios" && cp -R ../swift-shared "$scratch/apps/"
  rm -rf "$scratch/apps/ios/build"
  pbx="$scratch/apps/ios/CreatorToolset.xcodeproj/project.pbxproj"
  [ -z "${BUNDLE_ID:-}" ] || sed -i '' "s/PRODUCT_BUNDLE_IDENTIFIER = com\.creatortoolset\.ios\.share;/PRODUCT_BUNDLE_IDENTIFIER = $BUNDLE_ID.share;/; s/PRODUCT_BUNDLE_IDENTIFIER = com\.creatortoolset\.ios;/PRODUCT_BUNDLE_IDENTIFIER = $BUNDLE_ID;/" "$pbx"
  [ -z "${MARKETING_VERSION:-}" ] || sed -i '' "s/MARKETING_VERSION = [0-9.]*;/MARKETING_VERSION = $MARKETING_VERSION;/" "$pbx"
  out=$(cd "$out" && pwd)
  cd "$scratch/apps/ios"
fi
xcodebuild -quiet -project CreatorToolset.xcodeproj -scheme CreatorToolset -configuration Release \
  -destination generic/platform=iOS -archivePath "$out/CreatorToolset.xcarchive" -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" CURRENT_PROJECT_VERSION="$build" archive
# Readable crash reports: the Sentry CLI (logged in, with its default org and project set) uploads the build's debug symbols.
if command -v sentry >/dev/null; then
  # from the checkout, so its .sentryclirc decides the project even when the build folder is elsewhere
  dsyms=$(cd "$out/CreatorToolset.xcarchive/dSYMs" && pwd)
  (cd "$here" && sentry debug-files upload "$dsyms") || echo "Sentry: debug symbols not uploaded"
fi
plist="$out/ExportOptions.plist"
cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>$DEVELOPMENT_TEAM</string>
</dict></plist>
PLIST
xcodebuild -exportArchive -archivePath "$out/CreatorToolset.xcarchive" -exportOptionsPlist "$plist" \
  -exportPath "$out/export" -allowProvisioningUpdates
echo "Uploaded build $build. It shows in TestFlight once App Store Connect has processed it."

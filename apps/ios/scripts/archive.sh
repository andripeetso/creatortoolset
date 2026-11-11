#!/usr/bin/env bash
# Archives the app and uploads it to App Store Connect (TestFlight), signed with your own team:
#   DEVELOPMENT_TEAM=<your team id> apps/ios/scripts/archive.sh
# The bundle id (com.creatortoolset.ios) needs an App Store Connect record under that team; a fork changes
# PRODUCT_BUNDLE_IDENTIFIER in the project first. BUILD_DIR moves the output (default apps/ios/build).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DEVELOPMENT_TEAM:?set DEVELOPMENT_TEAM to your Apple team id}"
out="${BUILD_DIR:-build}"
build=$(git rev-list --count HEAD)
xcodebuild -quiet -project CreatorToolset.xcodeproj -scheme CreatorToolset -configuration Release \
  -destination generic/platform=iOS -archivePath "$out/CreatorToolset.xcarchive" -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" CURRENT_PROJECT_VERSION="$build" archive
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

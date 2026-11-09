#!/bin/bash
# Publishes a Mac app release on GitHub Releases. Builds the app from a clean checkout of the current commit
# (never the working tree), signs and notarizes it, packs it in a disk image, and uploads three files:
#   CreatorToolset-<version>.dmg   the download (also what the updater installs)
#   appcast.xml                    the update feed every installed copy reads, at releases/latest/download/appcast.xml
#   ffmpeg-<v>.tar.xz              the source of the GPL FFmpeg the app bundles (see THIRD_PARTY_NOTICES.md)
# The release is made as a draft: nothing is public and no tag exists until you try the DMG and publish it with
#   gh release edit v<version> --draft=false
# Usage, from a commit that is already on origin/main:
#   SIGN_IDENTITY="Developer ID Application: …" NOTARY_PROFILE=… apps/mac/scripts/release.sh 0.1.0
#   NOTES=notes.md        release notes (default: the commit subjects since the last release)
#   CT_RELEASE_DIR=…      where the build happens (default apps/mac/build/release)
# Needs gh (signed in, with push access), Xcode's command line tools, pnpm, and the Sparkle EdDSA key in this
# Mac's login Keychain (Sparkle's generate_keys). Lose that key and installed copies can't be updated again.
set -euo pipefail
version="${1:?usage: release.sh <version, e.g. 0.1.0>}"
: "${SIGN_IDENTITY:?Set SIGN_IDENTITY to a Developer ID Application identity}"
: "${NOTARY_PROFILE:?Set NOTARY_PROFILE to a notarytool keychain profile}"
root="$(git rev-parse --show-toplevel)"
cd "$root"
repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
tag="v$version"
sha="$(git rev-parse HEAD)"

git fetch -q origin --tags
git merge-base --is-ancestor "$sha" origin/main || { echo "Push $sha to main first: a release is built from a pushed commit" >&2; exit 1; }
! git rev-parse -q --verify "refs/tags/$tag" >/dev/null || { echo "$tag already exists" >&2; exit 1; }

work="${CT_RELEASE_DIR:-$root/apps/mac/build/release}/$tag"
rm -rf "$work" && mkdir -p "$work"
git worktree add --detach "$work/src" "$sha"
# every built app copy shares the bundle id, and macOS's permission lists get confused by them: on exit, the copies
# under build/ are unregistered from Launch Services and renamed .app-build (the installed copy in /Applications is untouched)
retire_copies() {
  local lsr=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
  while IFS= read -r app; do
    "$lsr" -u "$app" >/dev/null 2>&1 || true
    mv "$app" "${app%.app}.app-build"
  done < <(find "$root/apps/mac/build" -name "*.app" -type d -not -path "*/Contents/*" 2>/dev/null)
}
trap 'git -C "$root" worktree remove --force "$work/src"; retire_copies' EXIT
(cd "$work/src" && pnpm install --frozen-lockfile)
(cd "$work/src/apps/mac" && swift package resolve)
sparkle="$work/src/apps/mac/.build/artifacts/sparkle/Sparkle/bin"

(cd "$work/src" && SPARKLE_PUBLIC_KEY="$("$sparkle/generate_keys" -p)" \
  FEED_URL="https://github.com/$repo/releases/latest/download/appcast.xml" VERSION="$version" \
  CT_BUILD_CACHE="$root/apps/mac/build/cache" apps/mac/scripts/build-app.sh)
app="$work/src/apps/mac/build/Creator Toolset.app"
build="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$app/Contents/Info.plist")"

# the disk image: a window with the app, an arrow and a link to Applications (dmgbuild lays it out without Finder,
# apps/mac/scripts/dmg/), signed, notarized and stapled like the app inside it
dmg="$work/CreatorToolset-$version.dmg"
python3 -m venv "$work/dmgbuild" && "$work/dmgbuild/bin/pip" -q install dmgbuild==1.6.7
dmgdir="$work/src/apps/mac/scripts/dmg"
"$work/dmgbuild/bin/dmgbuild" -s "$dmgdir/settings.py" -D app="$app" -D here="$dmgdir" "Creator Toolset" "$dmg"
codesign --force --sign "$SIGN_IDENTITY" --timestamp "$dmg"
xcrun notarytool submit "$dmg" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$dmg"

# the feed lists only the newest version: that is all the updater needs
sig="$("$sparkle/sign_update" "$dmg")"   # sparkle:edSignature="…" length="…"
cat > "$work/appcast.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Creator Toolset</title>
    <item>
      <title>$version</title>
      <pubDate>$(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S +0000')</pubDate>
      <link>https://github.com/$repo/releases/tag/$tag</link>
      <sparkle:version>$build</sparkle:version>
      <sparkle:shortVersionString>$version</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>
      <enclosure url="https://github.com/$repo/releases/download/$tag/$(basename "$dmg")" type="application/octet-stream" $sig />
    </item>
  </channel>
</rss>
XML

# FFmpeg is GPL: its source goes out with every binary that bundles it
ffv="$("$app/Contents/Resources/server/runtime/ffmpeg" -hide_banner -version | sed -nE '1s/^ffmpeg version n?([0-9.]+).*/\1/p')"
ffsrc="$root/apps/mac/build/cache/ffmpeg-$ffv.tar.xz"
[ -f "$ffsrc" ] || curl -fL "https://ffmpeg.org/releases/ffmpeg-$ffv.tar.xz" -o "$ffsrc"

notes="${NOTES:-$work/notes.md}"
if [ -z "${NOTES:-}" ]; then
  prev="$(git describe --tags --abbrev=0 "$sha^" 2>/dev/null || true)"
  { echo "Download **$(basename "$dmg")** below, open it and drag Creator Toolset to Applications (Apple silicon, macOS 14 or newer). Installed copies update themselves."
    echo
    if [ -n "$prev" ]; then echo "## Changes since $prev"; git log --format='- %s' "$prev..$sha" -- apps/captions apps/mac; fi
  } > "$notes"
fi
gh release create "$tag" --draft --repo "$repo" --target "$sha" --title "Creator Toolset $version" --notes-file "$notes" \
  "$dmg" "$work/appcast.xml" "$ffsrc"
echo "Draft made. Try $dmg, then publish it: gh release edit $tag --repo $repo --draft=false"

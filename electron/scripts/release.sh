#!/usr/bin/env bash
# Cut a release: bump version, build signed+notarized mac and windows installers, upload them
# plus the auto-update manifests to GitHub Releases.
#   scripts/release.sh patch|minor|major|<version>
#
# One-time setup on the Mac that cuts releases:
#   1. Xcode > Settings > Accounts > Manage Certificates > + > Developer ID Application
#   2. scripts/apple-login.sh <apple-id-email>   (stores an app-specific password in the keychain)
set -euo pipefail
cd "$(dirname "$0")/.."
BUMP="${1:-patch}"
PROFILE="${APPLE_KEYCHAIN_PROFILE:-opentrench}"

export GH_TOKEN="${GH_TOKEN:-$(gh auth token)}"

if ! security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application"; then
  echo "!! no 'Developer ID Application' certificate in the keychain; create one in Xcode > Settings > Accounts" >&2
  exit 1
fi
if [ -z "${APPLE_ID:-}" ] && ! xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then
  echo "!! no notarization credentials: run scripts/apple-login.sh <apple-id-email> once" >&2
  exit 1
fi
[ -n "${APPLE_ID:-}" ] || export APPLE_KEYCHAIN_PROFILE="$PROFILE"

# Patch notes are mandatory: the Unreleased section of CHANGELOG.md becomes this version's notes.
NOTES_BODY=$(node -e '
  const s = require("fs").readFileSync("../CHANGELOG.md", "utf8");
  const m = /## Unreleased\n([\s\S]*?)(?=\n## |$)/.exec(s);
  process.stdout.write(m ? m[1].trim() : "");
')
if [ -z "$NOTES_BODY" ]; then
  echo "!! CHANGELOG.md has an empty 'Unreleased' section — write the patch notes first" >&2
  exit 1
fi
npm version "$BUMP" --no-git-tag-version >/dev/null
VERSION=$(node -p "require('./package.json').version")
echo "==> opentrench v$VERSION (signed, notarized)"
node -e '
  const fs = require("fs"); const v = process.argv[1]; const d = new Date().toISOString().slice(0, 10);
  fs.writeFileSync("../CHANGELOG.md", fs.readFileSync("../CHANGELOG.md", "utf8").replace("## Unreleased\n", `## Unreleased\n\n## v${v} — ${d}\n`));
' "$VERSION"
NOTES_FILE=$(mktemp)
printf "%s\n" "$NOTES_BODY" > "$NOTES_FILE"
( cd .. && npm run build )
npm run prepare-vencord
npm run prepare-backend
# Build without publishing: electron-builder's own GitHub uploader stalls silently from here.
# The assets go up through the GitHub CLI (with retries) into a DRAFT, so the updater never sees
# a half-uploaded release; the manifests are written by scripts/manifests.js; then the release
# is flipped live only once every asset is verified on GitHub.
npx electron-builder --mac --win --x64 --arm64 --publish never
node scripts/manifests.js "$VERSION"
ASSETS=(
  "dist/latest.yml" "dist/latest-mac.yml"
  "dist/opentrench-Setup-$VERSION.exe" "dist/opentrench-Setup-$VERSION.exe.blockmap"
  "dist/opentrench-$VERSION-mac.zip" "dist/opentrench-$VERSION-mac.zip.blockmap"
  "dist/opentrench-$VERSION-arm64-mac.zip" "dist/opentrench-$VERSION-arm64-mac.zip.blockmap"
  "dist/opentrench-$VERSION.dmg" "dist/opentrench-$VERSION.dmg.blockmap"
  "dist/opentrench-$VERSION-arm64.dmg" "dist/opentrench-$VERSION-arm64.dmg.blockmap"
)
for f in "${ASSETS[@]}"; do [ -f "$f" ] || { echo "!! missing build output $f" >&2; exit 1; }; done
if ! gh release view "v$VERSION" --repo frogeth/opentrench >/dev/null 2>&1; then
  gh release create "v$VERSION" --repo frogeth/opentrench --draft --title "opentrench v$VERSION" --notes-file "$NOTES_FILE"
fi
echo "==> uploading $((${#ASSETS[@]})) assets"
for f in "${ASSETS[@]}"; do
  for attempt in 1 2 3; do
    if gh release upload "v$VERSION" --repo frogeth/opentrench --clobber "$f"; then break; fi
    echo "   retry $attempt for $f" >&2
    [ "$attempt" = 3 ] && { echo "!! upload failed: $f — release left as draft" >&2; exit 1; }
    sleep 5
  done
done
echo "==> verifying assets"
names=$(gh release view "v$VERSION" --repo frogeth/opentrench --json assets --jq '.assets[] | "\(.name) \(.size)"')
for f in "${ASSETS[@]}"; do
  n=$(basename "$f"); want=$(stat -f %z "$f")
  echo "$names" | grep -qx "$n $want" || { echo "!! $n missing or wrong size on GitHub — release left as draft" >&2; exit 1; }
done
gh release edit "v$VERSION" --repo frogeth/opentrench --title "opentrench v$VERSION" --notes-file "$NOTES_FILE" --draft=false --latest
rm -f "$NOTES_FILE"
echo "==> release is live"

APP=$(ls -d dist/mac-arm64/*.app 2>/dev/null | head -1 || true)
if [ -n "$APP" ]; then
  echo "==> gatekeeper check"
  spctl --assess --type execute -vv "$APP"
fi

( cd .. && git add electron/package.json package-lock.json CHANGELOG.md && git commit -qm "release: opentrench v$VERSION" && git tag -f "v$VERSION" && git push && git push --force origin "v$VERSION" )
echo "==> published https://github.com/frogeth/opentrench/releases/tag/v$VERSION"

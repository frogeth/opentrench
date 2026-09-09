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

npm version "$BUMP" --no-git-tag-version >/dev/null
VERSION=$(node -p "require('./package.json').version")
echo "==> opentrench v$VERSION (signed, notarized)"
( cd .. && npm run build )
npm run prepare-backend
npx electron-builder --mac --win --x64 --arm64 --publish always

APP=$(ls -d dist/mac-arm64/*.app 2>/dev/null | head -1 || true)
if [ -n "$APP" ]; then
  echo "==> gatekeeper check"
  spctl --assess --type execute -vv "$APP"
fi

( cd .. && git add electron/package.json package-lock.json && git commit -qm "release: opentrench v$VERSION" && git tag -f "v$VERSION" && git push && git push --force origin "v$VERSION" )
echo "==> published https://github.com/frogeth/opentrench/releases/tag/v$VERSION"

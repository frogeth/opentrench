#!/usr/bin/env bash
# Cut a release: bump version, build mac + windows, upload installers + update manifests to GitHub Releases.
#   scripts/release.sh patch|minor|major|<version>
# Signing/notarization happens automatically when a "Developer ID Application" cert is in the keychain
# and APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID are set; otherwise the mac build is unsigned.
set -euo pipefail
cd "$(dirname "$0")/.."
BUMP="${1:-patch}"
export GH_TOKEN="${GH_TOKEN:-$(gh auth token)}"
npm version "$BUMP" --no-git-tag-version >/dev/null
VERSION=$(node -p "require('./package.json').version")
echo "==> opentrench v$VERSION"
( cd .. && npm run build )
npm run prepare-backend
NOTARIZE=false
if security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application" && [ -n "${APPLE_ID:-}" ]; then NOTARIZE=true; fi
npx electron-builder --mac --win --x64 --arm64 --publish always --config.mac.notarize="$NOTARIZE"
( cd .. && git add electron/package.json && git commit -qm "release: opentrench v$VERSION" && git tag "v$VERSION" && git push && git push --tags )
echo "==> published https://github.com/frogeth/opentrench/releases/tag/v$VERSION"

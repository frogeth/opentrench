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
npm run prepare-backend
# Publish as a DRAFT so the updater never sees a half-uploaded release, then flip it live
# only once every asset (both manifests included) is on GitHub.
npx electron-builder --mac --win --x64 --arm64 --publish always
echo "==> verifying assets"
# GitHub's asset list can lag the upload by a little; give it up to two minutes.
for want in latest.yml latest-mac.yml "opentrench-Setup-$VERSION.exe" "opentrench-$VERSION-arm64-mac.zip" "opentrench-$VERSION-mac.zip"; do
  ok=false
  for _ in $(seq 1 24); do
    if gh release view "v$VERSION" --repo frogeth/opentrench --json assets --jq '.assets[].name' | grep -qx "$want"; then ok=true; break; fi
    sleep 5
  done
  [ "$ok" = true ] || { echo "!! missing asset $want — release left as draft" >&2; exit 1; }
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

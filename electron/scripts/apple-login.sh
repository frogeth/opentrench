#!/usr/bin/env bash
# One-time: store notarization credentials in the login keychain under the profile "opentrench".
#   scripts/apple-login.sh <apple-id-email>
# You will be prompted for an app-specific password: create one at https://account.apple.com
# under Sign-In and Security > App-Specific Passwords. Your account password will NOT work.
set -euo pipefail
APPLE_ID="${1:?usage: scripts/apple-login.sh <apple-id-email>}"
TEAM_ID=$(security find-identity -v -p codesigning | sed -n 's/.*Developer ID Application: .* (\([A-Z0-9]*\))".*/\1/p' | head -1)
[ -n "$TEAM_ID" ] || { echo "no Developer ID Application certificate found" >&2; exit 1; }
echo "Apple ID: $APPLE_ID   Team ID: $TEAM_ID"
xcrun notarytool store-credentials opentrench --apple-id "$APPLE_ID" --team-id "$TEAM_ID"
echo "==> stored. scripts/release.sh will notarize automatically from now on."

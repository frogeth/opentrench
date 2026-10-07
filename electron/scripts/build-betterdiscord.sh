#!/usr/bin/env bash
# Build what the desktop app ships for one-click Discord setup with BetterDiscord: a pinned
# BetterDiscord release (checked against the hash below) plus the opentrench bridge plugin,
# bundled into one OpentrenchBridge.plugin.js (../betterdiscord/build.mjs).
# Output: electron/resources/betterdiscord/{betterdiscord.asar,OpentrenchBridge.plugin.js,LICENSE,VERSION}.
#   scripts/build-betterdiscord.sh
# To move to a newer BetterDiscord: set BD_TAG and BD_SHA256 from that release's checksums.txt.
# BetterDiscord is Apache-2.0: its LICENSE ships next to the asar.
set -euo pipefail
cd "$(dirname "$0")/.."
BD_TAG="v1.14.1"
BD_SHA256="8595fffc8a8339f01cdf80b4a34c641cb96cf567732c5227f5c4c6779edff6f6"
OUT="resources/betterdiscord"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
echo "==> BetterDiscord $BD_TAG"
curl -fsSL --retry 3 -o "$WORK/betterdiscord.asar" "https://github.com/BetterDiscord/BetterDiscord/releases/download/$BD_TAG/betterdiscord.asar"
curl -fsSL --retry 3 -o "$WORK/LICENSE" "https://raw.githubusercontent.com/BetterDiscord/BetterDiscord/$BD_TAG/LICENSE"
GOT=$(shasum -a 256 "$WORK/betterdiscord.asar" | cut -d' ' -f1)
if [ "$GOT" != "$BD_SHA256" ]; then
  echo "!! betterdiscord.asar $BD_TAG hash $GOT, expected $BD_SHA256" >&2
  exit 1
fi
node ../betterdiscord/build.mjs "$WORK"
rm -rf "$OUT"
mkdir -p "$OUT"
cp "$WORK/betterdiscord.asar" "$WORK/OpentrenchBridge.plugin.js" "$WORK/LICENSE" "$OUT/"
printf 'betterdiscord %s\nplugin %s\nbuilt %s\n' "$BD_TAG" "$(git -C .. rev-parse --short HEAD)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$OUT/VERSION"
echo "==> $OUT: betterdiscord $BD_TAG + plugin"

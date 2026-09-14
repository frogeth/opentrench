#!/usr/bin/env bash
# Build the Vencord that the desktop app ships for its one-click Discord setup: upstream Vencord
# at a pinned commit plus the opentrench bridge plugin, built with Vencord's own toolchain.
# Output: electron/resources/vencord/{dist,VERSION,LICENSE}. Needs git, node and pnpm.
#   scripts/build-vencord.sh                 # VENCORD_REF below (a commit, tag or branch)
#   VENCORD_REF=main scripts/build-vencord.sh
# Vencord is GPL-3.0: the LICENSE ships next to the build, and VERSION names the exact commit so
# the corresponding source is always identifiable (https://github.com/Vendicated/Vencord).
set -euo pipefail
cd "$(dirname "$0")/.."
REF="${VENCORD_REF:-main}"
WORK="${VENCORD_WORK:-$(mktemp -d)}"
OUT="resources/vencord"
PLUGIN="$(pwd)/../vencord/opentrench-bridge"
echo "==> Vencord @ $REF in $WORK"
if [ ! -d "$WORK/Vencord/.git" ]; then
  git clone --quiet --depth 50 https://github.com/Vendicated/Vencord "$WORK/Vencord"
fi
cd "$WORK/Vencord"
git fetch --quiet --depth 50 origin "$REF" && git checkout --quiet FETCH_HEAD
COMMIT=$(git rev-parse --short HEAD)
mkdir -p src/userplugins
rm -rf src/userplugins/opentrench-bridge
cp -r "$PLUGIN" src/userplugins/
pnpm install --frozen-lockfile --silent
pnpm build --silent
cd "$OLDPWD"
rm -rf "$OUT"
mkdir -p "$OUT"
cp -r "$WORK/Vencord/dist" "$OUT/dist"
cp "$WORK/Vencord/LICENSE" "$OUT/LICENSE"
printf 'vencord %s\nplugin %s\nbuilt %s\n' "$COMMIT" "$(git -C .. rev-parse --short HEAD)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$OUT/VERSION"
echo "==> $OUT: $(du -sh "$OUT/dist" | cut -f1), vencord $COMMIT"

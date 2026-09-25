#!/usr/bin/env bash
#
# build-app.sh — build the self-contained macOS app (DSH.app) and its DMG.
#
#   pnpm build-app [--skip-pack] [--no-dmg] [--no-prune] [--with-office] [--build N] [--update-feed URL] [--name "DSH Canary"] [--glyph-color "#E5484D"] [--port 3090] [--sign IDENTITY]
#
# Three steps, each its own script under tools/bundle/ (run them by hand to iterate on one):
#   1. fetch-node.mjs  — official Node 24 LTS macOS build, sha256-verified, trimmed to bin/node
#   2. stage-dsh.mjs   — pack every fork workspace package + the plugins in tools/bundle/plugins.txt,
#                        install the production closure with pnpm overrides pinning first-party
#                        packages to those tarballs (--skip-pack reuses the fork tarballs)
#   3. build-app.mjs   — DSH.app (Swift wrapper in embedded-server mode + node + dsh tree +
#                        profile template), ad-hoc or Developer ID signed, then the DMG
#
# Needs: a BUILT fork checkout (deepseek-harness/, `pnpm run build`), built client plugins
# (`pnpm build` in each plugins/<client plugin>), pnpm, Command Line Tools (swiftc), network
# (nodejs.org, registry.npmjs.org). Output: dist/bundle/DSH.app and dist/bundle/DSH-<version>.dmg.
# hdiutil cannot run inside the DSH file sandbox (diskimages-helper): build from a terminal, or
# `--no-dmg` and run the hdiutil line build-app.mjs prints yourself.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
STAGE_ARGS=(); APP_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-pack) STAGE_ARGS+=("$1"); shift ;;
    --no-dmg|--no-prune|--with-office|--name|--glyph-color|--port|--sign|--version|--build|--update-feed|--update-repo) if [[ "$1" == --no-dmg || "$1" == --no-prune || "$1" == --with-office ]]; then APP_ARGS+=("$1"); shift; else APP_ARGS+=("$1" "$2"); shift 2; fi ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
export npm_config_manage_package_manager_versions=false
node "$HERE/tools/bundle/fetch-node.mjs" >/dev/null
node "$HERE/tools/bundle/stage-dsh.mjs" ${STAGE_ARGS[@]+"${STAGE_ARGS[@]}"}
node "$HERE/tools/bundle/build-app.mjs" ${APP_ARGS[@]+"${APP_ARGS[@]}"}

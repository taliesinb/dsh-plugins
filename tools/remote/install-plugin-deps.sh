#!/bin/bash
# Runs ON the remote host. Install a plugin's third-party runtime deps with npm
# into ~/dsh/deps/<plugin> (pnpm's symlinked layout does not survive rsync),
# then expose them to the plugin via symlinks in its node_modules. Workspace
# (@deepseek-ai) links are handled separately by the deploy.
#   usage: install-plugin-deps.sh <plugin> '<deps json>'
set -euo pipefail
export PATH="$HOME/.local/node/bin:$PATH"
P="$1"; DEPS="$2"
T="$HOME/dsh/deps/$P"; PL="$HOME/dsh/plugins/$P"
mkdir -p "$T" "$PL/node_modules"
cd "$T"
printf '{"private":true,"dependencies":%s}\n' "$DEPS" > package.json
if ! npm ls --depth=0 >/dev/null 2>&1; then
  npm install --no-audit --no-fund >/dev/null 2>&1
  echo "  $P: deps installed"
fi
for d in "$T"/node_modules/*/ "$T"/node_modules/@*/; do
  [ -d "$d" ] || continue
  n="$(basename "$d")"
  case "$n" in
    @deepseek-ai) continue ;;
    @*) mkdir -p "$PL/node_modules/$n"
        for sd in "$d"*/; do [ -d "$sd" ] && ln -sfn "${sd%/}" "$PL/node_modules/$n/$(basename "$sd")"; done ;;
    *)  ln -sfn "${d%/}" "$PL/node_modules/$n" ;;
  esac
done

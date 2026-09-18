#!/usr/bin/env bash
#
# install-plugins.sh — install every live-profile plugin of this repo into a
# DSH profile as bundles, in one command (the "tali-plugins superplugin").
#
#   pnpm install-plugins [--profile web] [--checkout DIR] [--remove] [--dry-run]
#
# Each plugin under plugins/ that is meant for a live profile declares
# `dsh.bundle.patch` (its cordis.patch.yml inserts its own `tali-*` row by
# package name), so `dsh plugin --profile <p> add <dir>...` pnpm-links the
# directories into $DSH_HOME/profiles/<p> and appends one bundle per plugin to
# dsh.profile.bundles. Rows resolve by package name from the profile's hoisted
# node_modules — no absolute paths in any patch file. Row configs are the
# plugins' schema defaults, which equal Tali's live settings; override by id
# in the profile's cordis.patch.yml when needed (a patch replaces the whole
# `config`).
#
# Why not a package whose dependencies list the plugins: pnpm does not install
# the dependencies of a `link:`-installed package into the profile, and the
# loader resolves every row from the profile directory, so such a package's
# rows would not resolve (measured 2026-09-18). Deep imports through it
# (`tali-plugins/plugins/x/index.js`) break the client-module scan, which
# attributes the row to the bare specifier's package.
#
# Idempotent: pnpm reports "Already up to date" and dsh does not duplicate a
# bundle already listed. A profile that ALSO inserts these rows by absolute
# path (the pre-2026-09-18 layout) must drop those inserts first: duplicate
# ids fail the boot.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE=web
CHECKOUT="${DSH_CHECKOUT:-$HERE/deepseek-harness}"
ACTION=add
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --profile=*) PROFILE="${1#--profile=}"; shift ;;
    --checkout) CHECKOUT="$2"; shift 2 ;;
    --checkout=*) CHECKOUT="${1#--checkout=}"; shift ;;
    --remove) ACTION=remove; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# The live set. Deliberately absent: agent-status-indicator (not in Tali's
# live profile) and preview-identity (dev-overlay only; never in a live profile).
PLUGINS=(
  dsh-tailscale-remote
  enforce-model-preset
  browser-automation
  dash-docsets
  local-model-supervisor
  wolfram-kernel-supervisor
  foreign-link-opener
  session-introspect
  fs-tools
  settings-shortcut
  session-title-slug
  dsh-remote-workspaces
)

log() { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✖\033[0m %s\n' "$*" >&2; exit 1; }

[ -f "$CHECKOUT/apps/cli/lib/bin.js" ] || [ -f "$CHECKOUT/apps/cli/src/bin.ts" ] \
  || die "DSH checkout not found at $CHECKOUT (set DSH_CHECKOUT or --checkout)"

DIRS=(); NAMES=()
for p in "${PLUGINS[@]}"; do
  dir="$HERE/plugins/$p"
  [ -f "$dir/package.json" ] || die "missing plugin directory: $dir"
  name="$(node -p "require('$dir/package.json').name")"
  bundle="$(node -p "require('$dir/package.json').dsh?.bundle?.patch ?? ''")"
  [ -n "$bundle" ] || die "$p declares no dsh.bundle.patch — it cannot be installed as a bundle"
  if [ "$ACTION" = add ]; then
    client="$(node -p "require('$dir/package.json').dsh?.client ? 'yes' : ''")"
    [ -z "$client" ] || [ -f "$dir/lib/client.js" ] || die "$p is a client plugin but lib/client.js is not built — run: (cd $dir && pnpm install && pnpm build)"
    [ -d "$dir/node_modules" ] || [ "$(node -p "Object.keys(require('$dir/package.json').dependencies ?? {}).length")" = 0 ] \
      || die "$p has dependencies but no node_modules — run: (cd $dir && pnpm install)"
  fi
  DIRS+=("$dir"); NAMES+=("$name")
done

log "$ACTION ${#PLUGINS[@]} plugins → profile '$PROFILE' (DSH_HOME=${DSH_HOME:-~/.dsh}) via $CHECKOUT"
if [ "$ACTION" = add ]; then
  CMD=(pnpm dsh plugin --profile "$PROFILE" add "${DIRS[@]}")
else
  CMD=(pnpm dsh plugin --profile "$PROFILE" remove "${NAMES[@]}")
fi
if [ "$DRY" = 1 ]; then printf '  %q' "${CMD[@]}"; echo; exit 0; fi
(cd "$CHECKOUT" && "${CMD[@]}")

log "composed rows in profile '$PROFILE':"
(cd "$CHECKOUT" && pnpm dsh --profile "$PROFILE" --dump-config 2>/dev/null | grep -E '^- id: tali-' | sed 's/^/  /') || true
if [ "$ACTION" = add ]; then
  n="$(cd "$CHECKOUT" && pnpm dsh --profile "$PROFILE" --dump-config 2>/dev/null | grep -cE '^- id: tali-' || true)"
  [ "$n" -ge "${#PLUGINS[@]}" ] || log "warning: expected ${#PLUGINS[@]} tali- rows, dump shows $n"
fi
log "done"

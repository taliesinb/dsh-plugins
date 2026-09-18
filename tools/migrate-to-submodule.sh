#!/usr/bin/env bash
#
# migrate-to-submodule.sh — one-time migration of THIS machine to the
# "one repo" layout: the live DSH fork checkout becomes the git submodule
# `deepseek-harness/` of this repo, the plugins link into it relatively
# (`link:../../deepseek-harness/...`), and the live web profile gets the
# plugins as bundles (`pnpm install-plugins`) instead of absolute-path inserts.
#
#   tools/migrate-to-submodule.sh [--dry-run] [--old DIR] [--branch NAME] [--no-compat-link]
#
# Stops the live `dsh web` (relay bootout), so run it at a restart moment.
# The relay is reinstalled with the new cwd and cold-starts DSH again at the
# end; sessions persist under ~/.dsh and resume.
#
# Why the checkout must MOVE rather than be cloned a second time: every plugin
# resolves @deepseek-ai/cordis and schemastery through its link: into the
# checkout, and the hoisted-profile design relies on plugins sharing the
# running installation's single cordis instance. A second copy would hand the
# plugins a different cordis than the host they run in.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"                      # tali-dash-plugins
OLD="${DSH_CHECKOUT:-$HOME/github/deepseek-harness}"
NEW="$HERE/deepseek-harness"
BRANCH=feat/embed-session
URL="git@github.com:taliesinb/deepseek-harness.git"
DRY=0; COMPAT=1
RELAY=io.github.taliesinb.dsh-web-relay
PROFILE_PATCH="${DSH_HOME:-$HOME/.dsh}/profiles/web/cordis.patch.yml"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --old) OLD="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --no-compat-link) COMPAT=0; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

log() { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✖\033[0m %s\n' "$*" >&2; exit 1; }
run() { if [ "$DRY" = 1 ]; then printf '  \033[2m$ %s\033[0m\n' "$*"; else "$@"; fi; }

# ── pre-flight (always runs, also under --dry-run) ──────────────────────────
log "pre-flight"
[ -d "$OLD/.git" ] || die "no git checkout at $OLD (set DSH_CHECKOUT / --old)"
[ ! -e "$NEW" ] || die "$NEW already exists"
[ -z "$(git -C "$OLD" status --porcelain)" ] || die "fork working tree is not clean: $OLD"
[ "$(git -C "$OLD" branch --show-current)" = "$BRANCH" ] || die "fork is on $(git -C "$OLD" branch --show-current), expected $BRANCH"
git -C "$OLD" fetch -q origin
[ "$(git -C "$OLD" rev-parse HEAD)" = "$(git -C "$OLD" rev-parse "origin/$BRANCH")" ] \
  || die "fork HEAD is not pushed to origin/$BRANCH — push first (the gitlink must point at a public commit)"
[ -z "$(git -C "$HERE" status --porcelain --untracked-files=no -- plugins tools package.json .gitmodules 2>/dev/null)" ] \
  || die "this repo has uncommitted changes under plugins/ tools/ package.json — commit or stash first"
[ -f "$OLD/apps/cli/lib/bin.js" ] || die "fork is not built ($OLD/apps/cli/lib/bin.js missing)"
[ -f "$PROFILE_PATCH" ] || die "no live profile patch at $PROFILE_PATCH"
grep -q "link:../../../deepseek-harness/" "$HERE/plugins/dsh-tailscale-remote/package.json" || die "plugins do not use the sibling link: layout — already migrated?"
command -v pnpm >/dev/null || die "pnpm not on PATH"
echo "  fork:     $OLD @ $(git -C "$OLD" rev-parse --short HEAD) ($BRANCH, pushed)"
echo "  new path: $NEW"
echo "  relay:    $(launchctl print "gui/$(id -u)/$RELAY" >/dev/null 2>&1 && echo loaded || echo 'not loaded')"
DSH_PID="$(lsof -nP -iTCP:3080 -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
echo "  dsh web:  $([ -n "$DSH_PID" ] && echo "running (pid $DSH_PID, cwd $(lsof -a -p "$DSH_PID" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'))" || echo 'not running') — will be stopped"
echo "  profile:  $PROFILE_PATCH ($(grep -c "^\s*- id: tali-" "$PROFILE_PATCH") tali- rows; the 12 plugin inserts become bundles)"
[ "$DRY" = 1 ] && log "dry run — plan follows, nothing is changed"

# ── 1. stop the live server ─────────────────────────────────────────────────
log "1. stop the relay (takes its dsh web down with it)"
run launchctl bootout "gui/$(id -u)/$RELAY" || true
if [ "$DRY" = 0 ]; then
  for i in $(seq 1 30); do lsof -nP -iTCP:3080 -sTCP:LISTEN -t >/dev/null 2>&1 || break; sleep 1; done
  if P="$(lsof -nP -iTCP:3080 -sTCP:LISTEN -t 2>/dev/null | head -1)" && [ -n "$P" ]; then
    die "something still listens on :3080 (pid $P — a dsh web started by hand?) — quit it, then rerun"
  fi
  [ -z "$(lsof -nP -iTCP:3084 -sTCP:LISTEN -t 2>/dev/null)" ] || die "the tailscale-remote proxy still listens on :3084 — dsh web has not exited"
fi

# ── 2. move the checkout, register it as the submodule ──────────────────────
log "2. move $OLD → $NEW and add it as submodule (branch $BRANCH)"
run mv "$OLD" "$NEW"
[ "$COMPAT" = 1 ] && run ln -s "$NEW" "$OLD"     # old path keeps working for recipes, shells, notes
run git -C "$HERE" submodule add -b "$BRANCH" "$URL" deepseek-harness
run git -C "$HERE" config -f .gitmodules submodule.deepseek-harness.ignore dirty

# ── 3. relink the plugins ───────────────────────────────────────────────────
log "3. rewrite link: paths (../../../ → ../../) and reinstall each plugin"
if [ "$DRY" = 0 ]; then
  for f in "$HERE"/plugins/*/package.json; do
    sed -i '' 's#link:\.\./\.\./\.\./deepseek-harness/#link:../../deepseek-harness/#g' "$f"
  done
  for p in "$HERE"/plugins/*/; do
    [ -f "$p/package.json" ] || continue
    (cd "$p" && pnpm install --silent) || die "pnpm install failed in $p"
  done
  grep -rl "link:../../../deepseek-harness" "$HERE"/plugins/*/pnpm-lock.yaml && die "stale lockfile paths remain" || true
else
  echo "  \$ sed -i '' 's#link:../../../deepseek-harness/#link:../../deepseek-harness/#g' plugins/*/package.json; pnpm install in each plugin"
fi

# ── 4. tooling defaults ─────────────────────────────────────────────────────
log "4. tooling defaults point at the submodule"
if [ "$DRY" = 0 ]; then
  sed -i '' 's#^CHECKOUT="\${DSH_CHECKOUT:-\$HOME/github/deepseek-harness}".*#CHECKOUT="${DSH_CHECKOUT:-$HERE/deepseek-harness}"  # the fork, as the submodule of this repo#' "$HERE/tools/deploy-remote.sh"
  sed -i '' 's#^CHECKOUT="\${DSH_CHECKOUT:-\$(dirname "\$HERE")/deepseek-harness}"#CHECKOUT="${DSH_CHECKOUT:-$HERE/deepseek-harness}"#' "$HERE/tools/install-plugins.sh"
  grep -q 'DSH_CHECKOUT:-$HERE/deepseek-harness' "$HERE/tools/deploy-remote.sh" || die "deploy-remote.sh default not rewritten"
  grep -q 'DSH_CHECKOUT:-$HERE/deepseek-harness' "$HERE/tools/install-plugins.sh" || die "install-plugins.sh default not rewritten"
  bash -n "$HERE/tools/deploy-remote.sh" && bash -n "$HERE/tools/install-plugins.sh"
else
  echo "  deploy-remote.sh / install-plugins.sh: CHECKOUT default → \$HERE/deepseek-harness"
fi

# ── 5. live profile: bundles instead of absolute-path inserts ───────────────
log "5. rewrite $PROFILE_PATCH (backup alongside) and install the plugins as bundles"
if [ "$DRY" = 0 ]; then
  cp "$PROFILE_PATCH" "$PROFILE_PATCH.pre-submodule.bak"
  cat > "$PROFILE_PATCH" <<YML
# Your patch layer for this dsh profile, applied after every bundle layer.
#
# The tali-dash-plugins plugins are installed as BUNDLES (pnpm install-plugins
# in ~/github/tali-dash-plugins; see dsh.profile.bundles in package.json), so
# their rows come from the plugins' own cordis.patch.yml files and resolve by
# package name. Entries below only override those rows by id — a patch
# replaces a row's whole config, so every key is restated.

- id: tali-tailscale-remote
  config:
    listenPort: 3084
    publishPort: 3083
    relayCwd: $NEW
    relayStart: pnpm dsh web --no-open

- id: tali-browser-automation
  config:
    subagents: true
    idleMinutes: 30
    chrome:
      headless: false
    traceFile: /tmp/browser-automation-trace.log

- id: tali-dash-docsets
  config:
    traceFile: /tmp/dash-docsets-trace.log

- id: tali-wolfram-kernel-supervisor
  config:
    subagents: true
    idleMinutes: 60
    theme: auto
    traceFile: /tmp/wolfram-kernel-supervisor-trace.log

- id: tali-session-introspect
  config:
    scope: all
    traceFile: /tmp/session-introspect-trace.log

# Notion's hosted MCP server over the mcp-remote stdio bridge (not a
# tali-dash-plugins plugin). Recipe: recipes/notion-mcp.md
- insert:
    - id: tali-notion-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: notion
        transport: stdio
        command: /opt/homebrew/bin/npx
        args: ['-y', 'mcp-remote', 'https://mcp.notion.com/mcp']
        cwd: !!js process.cwd()

# Session titles as slugs (foo-bar-baz), matching the hand-typed slug: convention.
- id: session-title-llm
  config:
    targetWords: 5
    targetCjkCharacters: 10
    maxInputBytes: 4096
    maxOutputTokens: 64
    timeoutMs: 60000
    style: slug

# dsh-import-agents stays installed but unmounted.
- id: import-pi-opencode
  disabled: true
YML
  "$HERE/tools/install-plugins.sh" --checkout "$NEW"
else
  echo "  overrides kept: tailscale-remote (relayCwd=$NEW), traceFiles, notion mcp row, session-title-llm, import-pi-opencode"
  echo "  \$ tools/install-plugins.sh --checkout $NEW"
fi

# ── 6. relay back up with the new cwd (cold-starts dsh web on first request) ─
log "6. reinstall the relay LaunchAgent with --cwd $NEW and wake DSH"
run bash -c "cd '$HERE/plugins/dsh-tailscale-remote' && pnpm relay:install --cwd '$NEW' --start 'pnpm dsh web --no-open'"
if [ "$DRY" = 0 ]; then
  curl -s -o /dev/null http://127.0.0.1:3083/ || true
  for i in $(seq 1 60); do
    code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3080/ || true)"; [ "$code" = 401 ] && break; sleep 1
  done
  [ "$code" = 401 ] || { tail -20 "${DSH_HOME:-$HOME/.dsh}/logs/dsh-web.log"; die "dsh web did not come up (HTTP $code)"; }
  echo "  dsh web is up on :3080 from $NEW"
  (cd "$NEW" && pnpm dsh --profile web --dump-config 2>/dev/null | grep -cE '^- id: tali-' | sed 's/^/  tali- rows composed: /')
fi

# ── 7. commit the repo side ─────────────────────────────────────────────────
log "7. commit"
if [ "$DRY" = 0 ]; then
  git -C "$HERE" add .gitmodules deepseek-harness plugins/*/package.json plugins/*/pnpm-lock.yaml tools/deploy-remote.sh tools/install-plugins.sh
  git -C "$HERE" commit -q -m "feat: deepseek-harness fork as a submodule; plugins link into it relatively

The fork (branch $BRANCH) is now the submodule deepseek-harness/ of this
repo: one clone (--recurse-submodules) gives the plugins and the exact fork
commit they were tested against. Plugin link: paths are ../../deepseek-harness;
deploy-remote and install-plugins default to the submodule."
  echo "  committed $(git -C "$HERE" rev-parse --short HEAD) — review, then: git -C $HERE push"
else
  echo "  git add .gitmodules deepseek-harness plugins/*/package.json plugins/*/pnpm-lock.yaml tools/*.sh && git commit"
fi
log "done"

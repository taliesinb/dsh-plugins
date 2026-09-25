#!/usr/bin/env bash
#
# bootstrap-mac.sh — bring a fresh Apple Silicon Mac from nothing to a running
# DSH (the custom fork + plugins) in one sitting: INSTALLING.md Part A + C1–C5,
# in order, interactively, in a Terminal.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/taliesinb/dsh-plugins/main/tools/bootstrap-mac.sh)"
#   # or, from a clone:  tools/bootstrap-mac.sh [flags]
#
# Flags
#   --checkout-parent DIR the directory your git checkouts live in; the clone goes to DIR/tali-dash-plugins
#                         (asked otherwise; default ~/github)
#   --dir DIR             the clone's full path instead (default ~/github/tali-dash-plugins); overrides --checkout-parent
#   --yes                 take every default without asking (headless / VM runs)
#   --dry-run             print what each step would do, change nothing
#   --skip STEP[,STEP]    leave steps out;  --only STEP[,STEP]  run just these
#   --no-apps             do not offer to install Safari Technology Preview / Chrome (Tailscale is always required)
#   --no-tailnet          skip the relay LaunchAgent, the tailnet route and the Dock app
#   --no-apple            skip afm + the Apple on-device provider/preset
#   --without NAME,NAME   leave these plugins out of the bundle install (on top of the paid-app gating),
#                         e.g. --without dsh-remote-workspaces on a shared server whose instances must not
#                         act as remote-workspace clients themselves (no tunnel inside the tunnel)
#   --rebuild             rebuild the fork and the plugins even if built artifacts exist
#   --tailscale-timeout S give up waiting for the Tailscale login after S seconds (default 10: the login is a
#                         precondition, not something this script waits around for)
#   --no-replace          do NOT take over an existing DSH: abort when one is found (fresh-machine gate; see below),
#                         unless this is a resume of an earlier run (marker) or --force is given
#   --force               with --no-replace: proceed even though DSH already seems installed or running on this Mac
#   --replace             (the default since 2026-09-23) take over ANY existing DSH on this Mac (stock Desktop app /
#                         global CLI / our Dock apps / relay / Serve route / foreign profile), keeping sessions,
#                         settings and credentials; then install. Also: REDEPLOY: stop the existing DSH (both
#                         LaunchAgents, the listeners), delete the deploy-remote.sh tree (~/dsh, ~/.dsh/deploy) and
#                         reinstall from scratch, keeping ~/.dsh (settings, credentials, sessions,
#                         tailscale-remote.json) and any clone at --dir. Nothing found → nothing to take over.
#   --thin-client HOST    also build a Dock app "DSH <Host>" that opens a DSH on ANOTHER Mac over the tailnet
#                         (pnpm remote-app HOST/dsh/USER; blue whale, identity admission). Without the flag the
#                         thin-client step asks for a host; an empty answer skips it. The lighter sister script
#                         tools/bootstrap-mac-thin-client.sh builds ONLY that app (no fork, no plugin builds).
#   --thin-client-user U  the instance on HOST to open (mounted at /dsh/U); asked otherwise, default = the local
#                         part of your tailnet login (jo@example.com → jo)
#   --instance NAME       one DSH per macOS user on a shared machine: this user's install gets its own ports
#                         (a free decade ≥ 3090: web/relay/proxy = base/base+3/base+4; --port-base N to pick),
#                         Serve path /dsh-NAME and Dock app DSH-NAME, written as a row override into
#                         ~/.dsh/profiles/web/cordis.patch.yml. Everything else is per-user already.
#   --port-base N         web port (relay = N+3, proxy = N+4); default 3080, or auto-picked with --instance
#   --mount PATH          Serve path for this install (default /dsh, or /dsh-NAME with --instance)
#   --allow LOGIN[,LOGIN] tailnet logins admitted to this instance by identity (besides the node's own); e.g. the
#                         person a --instance is for, when the Mac is logged in to Tailscale as someone else
#   --repo URL            clone URL (default https://github.com/taliesinb/dsh-plugins)
#   --ref REF             check out this branch / tag / commit of the repo instead of the current default branch
#                         (a dev branch on one instance, a known-good commit). A branch becomes a local tracking
#                         branch so later ff-only updates follow it; a tag/commit is detached. Without --ref a
#                         clone found on another branch is moved back to the default branch. The fork is always
#                         the submodule pin of the checked-out commit.
#   --list                list the step names and exit
#
# Steps (in order): preflight clt brew tools apps tailscale clone fork plugins
#                   home install-plugins preset apple tailnet thin-client verify
#
# Two hard gates. (1) Preflight looks for an existing DSH (a dsh process or
# listener on :3080/:3083/:3084, an existing $DSH_HOME/profiles, a DSH
# LaunchAgent, a DSH Dock/Desktop app, a global `dsh`, a deploy-remote tree, a
# built checkout at the target directory). By default it then TAKES IT OVER
# (--replace: stop it, remove the apps/CLI/route, keep ~/.dsh) after one
# confirmation; with --no-replace it aborts instead, unless it is a resume of
# this very script (marker $DSH_HOME/bootstrap-mac.json, written once preflight
# passes) or --force is given. (2) Tailscale must be installed,
# connected and reporting a tailnet login before anything is cloned: the
# `tailscale` step installs the cask if you agree, reconnects a stopped
# backend with `tailscale up`, and drives a login (prints/opens the auth URL,
# waits) — and refuses to continue otherwise.
#
# Why a shell script and not a .pkg: Installer.app runs postinstall as root
# with no terminal — it cannot ask where the checkout goes, cannot wait for a
# Tailscale login or a sudo password, hides ten minutes of build output behind
# "Running package scripts…", and Homebrew refuses to run as root anyway. A
# Terminal script does all of that natively, and `curl | bash` sidesteps
# Gatekeeper (no quarantine flag), which an unsigned .pkg would not.
#
# Idempotent: every step checks its own postcondition first (app present,
# artifact built, file written, service answering) and skips when satisfied,
# so re-running after fixing a failure resumes where it stopped. Steps that
# only a human can finish (Apple Intelligence toggle, STP licence, provider
# keys in the GUI, tailnet ACL) are collected into a to-do list at the end.
# The way back is tools/uninstall-mac.sh (stops, unloads and trashes all of
# this, keeps ~/.dsh and the checkouts; no checkout needed to run it).
set -euo pipefail

REPO="https://github.com/taliesinb/dsh-plugins"
REF=""
DIR=""
PARENT=""
YES=0
DRY=0
APPS=1
TAILNET=1
APPLE=1
USER_WITHOUT=""
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
REBUILD=0
FORCE=0
REPLACE=1
THIN_HOST=""
THIN_USER=""
INSTANCE=""
PORT_BASE=""
ALLOW=""
MOUNT_OPT=""
TS_TIMEOUT=""
SKIP=""
ONLY=""
STEPS=(preflight clt brew tools apps tailscale clone fork plugins home install-plugins preset apple tailnet thin-client verify)

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --dir=*) DIR="${1#--dir=}"; shift ;;
    --checkout-parent) PARENT="$2"; shift 2 ;;
    --checkout-parent=*) PARENT="${1#--checkout-parent=}"; shift ;;
    --yes|-y) YES=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --skip) SKIP="$SKIP,$2"; shift 2 ;;
    --skip=*) SKIP="$SKIP,${1#--skip=}"; shift ;;
    --only) ONLY="$ONLY,$2"; shift 2 ;;
    --only=*) ONLY="$ONLY,${1#--only=}"; shift ;;
    --no-apps) APPS=0; shift ;;
    --no-tailnet) TAILNET=0; shift ;;
    --no-apple) APPLE=0; shift ;;
    --without) USER_WITHOUT="$2"; shift 2 ;;
    --without=*) USER_WITHOUT="${1#--without=}"; shift ;;
    --rebuild) REBUILD=1; shift ;;
    --force) FORCE=1; shift ;;
    --replace) REPLACE=1; shift ;;
    --no-replace) REPLACE=0; shift ;;
    --thin-client) THIN_HOST="$2"; shift 2 ;;
    --thin-client=*) THIN_HOST="${1#--thin-client=}"; shift ;;
    --thin-client-user) THIN_USER="$2"; shift 2 ;;
    --thin-client-user=*) THIN_USER="${1#--thin-client-user=}"; shift ;;
    --instance) INSTANCE="$2"; shift 2 ;;
    --instance=*) INSTANCE="${1#--instance=}"; shift ;;
    --port-base) PORT_BASE="$2"; shift 2 ;;
    --allow) ALLOW="$ALLOW,$2"; shift 2 ;;
    --mount) MOUNT_OPT="$2"; shift 2 ;;
    --mount=*) MOUNT_OPT="${1#--mount=}"; shift ;;
    --allow=*) ALLOW="$ALLOW,${1#--allow=}"; shift ;;
    --port-base=*) PORT_BASE="${1#--port-base=}"; shift ;;
    --tailscale-timeout) TS_TIMEOUT="$2"; shift 2 ;;
    --tailscale-timeout=*) TS_TIMEOUT="${1#--tailscale-timeout=}"; shift ;;
    --repo) REPO="$2"; shift 2 ;;
    --repo=*) REPO="${1#--repo=}"; shift ;;
    --ref) REF="$2"; shift 2 ;;
    --ref=*) REF="${1#--ref=}"; shift ;;
    --list) printf '%s\n' "${STEPS[@]}"; exit 0 ;;
    -h|--help) sed -n "2,80p" "$0"; exit 0 ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
done
[ -n "$TS_TIMEOUT" ] || TS_TIMEOUT=10
case "$INSTANCE" in ""|[a-z0-9]*) ;; *) echo "--instance must be lowercase alphanumeric (got '$INSTANCE')" >&2; exit 2 ;; esac
if [ -n "$INSTANCE" ]; then MOUNT="/dsh-$INSTANCE"; DOCK_NAME="DSH-$INSTANCE"; else MOUNT="/dsh"; DOCK_NAME="DSH"; fi
[ -z "$MOUNT_OPT" ] || MOUNT="/${MOUNT_OPT#/}"; MOUNT="${MOUNT%/}"
# Ports are fixed in set_ports (after the marker is consulted) so a resumed run keeps the same decade.
WEB_PORT=""; RELAY_PORT=""; PROXY_PORT=""

# ---------------------------------------------------------------------------
# helpers
BOLD=$'\033[1m'; BLUE=$'\033[1;34m'; GREEN=$'\033[1;32m'; YELLOW=$'\033[1;33m'; RED=$'\033[1;31m'; DIM=$'\033[2m'; NC=$'\033[0m'
LOGDIR="${TMPDIR:-/tmp}/dsh-bootstrap"; mkdir -p "$LOGDIR"
LOG="$LOGDIR/bootstrap-$(date +%Y%m%d-%H%M%S).log"
TODO=()
step_no=0

log()  { printf '%s▸%s %s\n' "$BLUE" "$NC" "$*" | tee -a "$LOG"; }
ok()   { printf '%s✓%s %s\n' "$GREEN" "$NC" "$*" | tee -a "$LOG"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$NC" "$*" | tee -a "$LOG"; }
die()  { printf '%s✖%s %s\n' "$RED" "$NC" "$*" | tee -a "$LOG" >&2; echo "   log: $LOG" >&2; exit 1; }
todo() { TODO+=("$*"); warn "to do by hand: $*"; }
banner() { step_no=$((step_no+1)); printf '\n%s━━ %d. %s ━━%s\n' "$BOLD" "$step_no" "$*" "$NC" | tee -a "$LOG"; }

# run CMD...: execute (streamed, indented, logged) unless --dry-run, in which case print it.
run() {
  if [ "$DRY" = 1 ]; then printf '  %swould run:%s %s\n' "$DIM" "$NC" "$*" | tee -a "$LOG"; return 0; fi
  printf '  $ %s\n' "$*" >>"$LOG"
  "$@" 2>&1 | tee -a "$LOG" | sed 's/^/    │ /'
}
# run_in DIR CMD...: `run` from another directory (dry-run prints even when DIR does not exist yet).
run_in() {
  local d="$1"; shift
  if [ "$DRY" = 1 ]; then printf '  %swould run (in %s):%s %s\n' "$DIM" "$d" "$NC" "$*" | tee -a "$LOG"; return 0; fi
  (cd "$d" && run "$@")
}
# quiet variant: log only, print the tail on failure.
runq() {
  if [ "$DRY" = 1 ]; then printf '  %swould run:%s %s\n' "$DIM" "$NC" "$*" | tee -a "$LOG"; return 0; fi
  printf '  $ %s\n' "$*" >>"$LOG"
  local out; out="$(mktemp)"
  local rc=0
  "$@" >"$out" 2>&1 || rc=$?        # not `if cmd; then …; fi; rc=$?` — that reads the if's status (0) and masks failures
  cat "$out" >>"$LOG"
  [ "$rc" = 0 ] || tail -25 "$out" | sed 's/^/    │ /'
  rm -f "$out"; return $rc
}
# ask VAR "prompt" default  — reads an answer from the terminal (/dev/tty, so it
# works under `curl | bash`); takes the default with --yes or without a terminal.
has_tty() { { : </dev/tty; } 2>/dev/null; }
ask() {
  local __var="$1" prompt="$2" default="$3" answer=""
  if [ "$YES" = 1 ] || ! has_tty; then answer="$default"; printf '  %s [%s] %s(auto)%s\n' "$prompt" "$default" "$DIM" "$NC"
  else read -r -p "  $prompt [$default] " answer </dev/tty; answer="${answer:-$default}"; fi
  printf -v "$__var" '%s' "$answer"
}
# confirm "question" y|n → 0 for yes
confirm() { local a; ask a "$1 (y/n)" "$2"; case "$a" in y|Y|yes) return 0 ;; *) return 1 ;; esac; }
wants() { # wants STEP → should the step run?
  local s="$1"
  [ -n "$ONLY" ] && { case ",$ONLY," in *",$s,"*) ;; *) return 1 ;; esac; }
  case ",$SKIP," in *",$s,"*) return 1 ;; esac
  return 0
}
wait_http() { # wait_http URL CODE SECONDS
  local i code=000
  for _ in $(seq 1 "$3"); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$1" || true)"
    [ "$code" = "$2" ] && return 0
    sleep 1
  done
  return 1
}
macos_major() { sw_vers -productVersion | cut -d. -f1; }
# port_busy PORT: something listens on 127.0.0.1:PORT (any user — lsof only shows our own processes).
port_busy() { nc -z -G 1 127.0.0.1 "$1" >/dev/null 2>&1; }
# set_ports: fix WEB/RELAY/PROXY from --port-base, else the marker, else 3080 (no instance) or the first
# free decade ≥ 3090 (instance) — several macOS users on one Mac must not share TCP ports.
set_ports() {
  local base="$PORT_BASE"
  [ -n "$base" ] || base="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("portBase",""))' "$1" 2>/dev/null || true)"
  if [ -z "$base" ]; then
    if [ -z "$INSTANCE" ]; then base=3080
    else
      base=3090
      while port_busy "$base" || port_busy $((base+3)) || port_busy $((base+4)); do base=$((base+10)); [ "$base" -lt 3300 ] || die "no free port decade between 3090 and 3300"; done
    fi
  fi
  WEB_PORT="$base"; RELAY_PORT=$((base+3)); PROXY_PORT=$((base+4))
}
write_marker() { # write_marker STARTED
  printf '{ "tool": "tali-dash-plugins/tools/bootstrap-mac.sh", "started": "%s", "dir": "%s", "instance": "%s", "portBase": %s }\n' \
    "$1" "${DIR:-}" "$INSTANCE" "${WEB_PORT:-null}" >"$MARKER"
}
# my_dsh_pids RE: this user's processes matching RE, minus this script's own shells (its text contains every
# pattern; under `bash -c "$(curl …)"` the text is the argv — macOS ps/pgrep hide such long argvs, but do not rely on it).
my_dsh_pids() {
  local pid
  for pid in $(pgrep -a -u "$(id -u)" -f "$1" 2>/dev/null || true); do   # -a: ancestors too (a DSH agent running this)
    [ "$pid" = "$$" ] && continue
    cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    case "$cmd" in ""|*bootstrap-mac*) continue ;; esac   # "": an argv too long for ps = a `bash -c "<script>"` shell, never a DSH process
    echo "$pid"
  done
}
have_brew() { [ -x /opt/homebrew/bin/brew ]; }
# Homebrew: install exactly what we ask for. No `brew update` on first use (a fresh tap sync prints pages
# of unrelated new formulae/casks and can take a minute), no upgrading of already-installed dependents,
# no post-install cleanup of unrelated versions, no env hints. These are environment variables, not
# flags — Homebrew has no per-command switch for the auto-update.
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1 HOMEBREW_NO_INSTALL_CLEANUP=1 \
       HOMEBREW_NO_ENV_HINTS=1 HOMEBREW_NO_ANALYTICS=1
# The fork's pnpm postinstall (scripts/install-lefthook.mjs) refuses to run when the user's ~/.gitconfig sets a
# global core.hooksPath (a common setup: a personal hooks dir). With this variable it installs a WORKTREE-scoped
# hooksPath inside the fork checkout instead — the user's global config is never touched. pnpm re-runs that
# postinstall before every `pnpm dsh …`, so it has to be set for the whole run, not just the first install.
export DSH_LEFTHOOK_ALLOW_HOOKS_PATH_OVERRIDE=1
brew_env() { have_brew && eval "$(/opt/homebrew/bin/brew shellenv)"; }
pkg_field() { node -p "const p=require('$1/package.json'); $2" 2>/dev/null; }
# patch_set_row FILE ID JSON — replace (or add) the top-level `- id: ID` row of a profile patch with the JSON
# object. Parses with the checkout's own `yaml` package because the fresh template is a literal `[]` (a text
# append would be invalid YAML); only the file's leading `#` header survives a rewrite. Returns 1 when the
# yaml package is missing so the caller can decide between die and warn.
patch_set_row() {
  local file="$1" id="$2" json="$3" yamlpkg
  yamlpkg="$(ls -d "$CK"/node_modules/.pnpm/yaml@*/node_modules/yaml 2>/dev/null | sort -V | tail -1 || true)"
  [ -n "$yamlpkg" ] || return 1
  node - "$file" "$yamlpkg" "$id" "$json" <<'JS'
const fs = require('fs'); const [file, yamlPath, id, json] = process.argv.slice(2);
const YAML = require(yamlPath);
const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const header = text.split('\n').filter(l => /^\s*#/.test(l)).join('\n');
let rows = YAML.parse(text) ?? []; if (!Array.isArray(rows)) rows = [];
rows = rows.filter(r => !(r && r.id === id));
rows.push({ id, ...JSON.parse(json) });
fs.writeFileSync(file, (header ? header + '\n' : '') + YAML.stringify(rows));
JS
}

# ---------------------------------------------------------------------------
echo "${BOLD}DSH bootstrap${NC} — log: $LOG"; [ "$DRY" = 1 ] && warn "dry run: nothing will be changed"

# ===========================================================================
if wants preflight; then
  banner "Preflight"
  [ "$(uname -s)" = Darwin ] || die "macOS only"
  [ "$(uname -m)" = arm64 ] || die "Apple Silicon only (the fork, afm and the Dock app are built for arm64)"
  [ "$(id -u)" != 0 ] || die "run as your normal user, not root (Homebrew refuses root; ~/.dsh must be yours)"
  MAJOR="$(macos_major)"
  if [ "$MAJOR" -lt 26 ]; then warn "macOS $(sw_vers -productVersion): Safari Technology Preview (cask needs ≥ 26) and afm will be skipped"; fi
  dseditgroup -o checkmember -m "$USER" admin >/dev/null 2>&1 || warn "$USER is not an admin — Homebrew and the Command Line Tools install will fail without sudo"
  ok "macOS $(sw_vers -productVersion) on $(uname -m), user $USER"

  # Existing-DSH gate. Detection first (always); then, by default, take whatever was found over (--replace),
  # or with --no-replace refuse unless resuming (marker) or --force.
  DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
  MARKER="$DSH_HOME_DIR/bootstrap-mac.json"
  [ -n "$DIR" ] && DIR="${DIR/#\~/$HOME}"
  set_ports "$MARKER"
  [ -z "$INSTANCE" ] || ok "instance '$INSTANCE': ports web $WEB_PORT / relay $RELAY_PORT / proxy $PROXY_PORT, route $MOUNT, Dock app $DOCK_NAME"
  marker_dir() { node -p "require('$MARKER').dir" 2>/dev/null || python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["dir"])' "$MARKER" 2>/dev/null || true; }
  FOUND=()
  for port in "$WEB_PORT" "$RELAY_PORT" "$PROXY_PORT"; do
    port_busy "$port" && FOUND+=("a server is listening on 127.0.0.1:$port$(pid="$(lsof -ti tcp:$port -sTCP:LISTEN 2>/dev/null | head -1 || true)"; [ -n "$pid" ] && echo " (pid $pid: $(ps -o comm= -p "$pid" 2>/dev/null))")")
  done
  # This user's dsh processes only: on a shared machine other accounts legitimately run their own.
  dsh_running="$(my_dsh_pids 'apps/cli/(lib/bin\.js|src/bin\.ts)' | tr '\n' ' ')"   # never `| head -1`: SIGPIPE + pipefail inside an assignment exits the script
  [ -z "$dsh_running" ] || FOUND+=("a dsh process of yours is running (${dsh_running%% *})")
  [ -z "$(my_dsh_pids 'dsh (web|serve)|@deepseek-ai/dsh|DSH\.app/Contents/MacOS/')" ] || FOUND+=("a stock dsh / DSH.app process of yours is running")
  [ -d "$DSH_HOME_DIR/profiles" ] && FOUND+=("$DSH_HOME_DIR/profiles exists (DSH home already initialised)")
  for la in io.github.taliesinb.dsh-web-relay ai.symbolica.dsh-remote; do
    [ -f "$HOME/Library/LaunchAgents/$la.plist" ] && FOUND+=("LaunchAgent $la is installed")
  done
  [ -d "$HOME/Applications/$DOCK_NAME.app" ] && FOUND+=("$HOME/Applications/$DOCK_NAME.app exists")
  [ -d /Applications/DSH.app ] && FOUND+=("/Applications/DSH.app exists (stock Desktop app)")
  [ -f "$HOME/dsh/checkout/apps/cli/lib/bin.js" ] && FOUND+=("a deploy-remote.sh tree exists at ~/dsh")
  command -v dsh >/dev/null 2>&1 && FOUND+=("a 'dsh' command is on PATH ($(command -v dsh))")
  CAND="${DIR:-${PARENT:-$HOME/github}/tali-dash-plugins}"; CAND="${CAND/#\~/$HOME}"
  [ -f "$CAND/deepseek-harness/apps/cli/lib/bin.js" ] && FOUND+=("a built DSH checkout exists at $CAND")
  for f in "${FOUND[@]-}"; do [ -n "$f" ] && warn "$f"; done

  if [ ${#FOUND[@]} = 0 ]; then
    ok "no existing DSH found on this Mac"
    if [ -f "$MARKER" ]; then ok "resuming an earlier bootstrap run ($MARKER)"; [ -n "$DIR" ] || DIR="$(marker_dir)"; fi
  elif [ "$REPLACE" = 1 ]; then
    # Take over: stop whatever DSH runs here and remove the deploy-remote.sh (Path B) tree, the apps, a global
    # CLI and this instance's Serve path; ~/.dsh stays. A previous run's marker only lends its --dir default.
    banner "Take over the existing DSH (the default; --no-replace to refuse instead)"
    if [ -f "$MARKER" ]; then [ -n "$DIR" ] || DIR="$(marker_dir)"; rm -f "$MARKER"; fi
    if [ "$DRY" = 0 ]; then
      confirm "Take over this Mac's DSH (found above): stop every dsh web, remove DSH Dock/Desktop apps and a global dsh CLI, reset the Tailscale Serve route, drop a foreign ~/.dsh/profiles, then (re)install? Sessions, settings and credentials are kept" y \
        || die "aborted (re-run with --no-replace --force to layer on top instead)"
    fi
    for la in ai.symbolica.dsh-remote io.github.taliesinb.dsh-web-relay; do
      if [ -f "$HOME/Library/LaunchAgents/$la.plist" ] || launchctl print "gui/$(id -u)/$la" >/dev/null 2>&1; then
        log "stopping LaunchAgent $la"
        [ "$DRY" = 1 ] || { launchctl bootout "gui/$(id -u)/$la" 2>/dev/null || true; rm -f "$HOME/Library/LaunchAgents/$la.plist"; }
      fi
    done
    for port in "$WEB_PORT" "$RELAY_PORT" "$PROXY_PORT"; do
      pids="$(lsof -ti tcp:$port -sTCP:LISTEN 2>/dev/null || true)"
      [ -z "$pids" ] || { log "stopping listener on :$port (pid $pids)"; [ "$DRY" = 1 ] || { echo "$pids" | xargs kill 2>/dev/null || true; }; }
    done
    if [ "$DRY" = 0 ]; then
      for _ in $(seq 1 20); do lsof -ti tcp:"$WEB_PORT" -sTCP:LISTEN >/dev/null 2>&1 || lsof -ti tcp:"$PROXY_PORT" -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 1; done
      my_dsh_pids 'apps/cli/(lib/bin\.js|src/bin\.ts)' | xargs kill 2>/dev/null || true   # this user's only
    fi
    if [ -f "$HOME/dsh/checkout/apps/cli/lib/bin.js" ]; then
      log "removing the deploy-remote.sh tree: ~/dsh (checkout, plugins, deps, logs) and ~/.dsh/deploy"
      [ "$DRY" = 1 ] || rm -rf "$HOME/dsh" "$DSH_HOME_DIR/deploy"
    fi
    # ---- take over ANY other DSH on this Mac (a colleague's manual install), not just our own shapes ----
    # Every `dsh web` of this user, whatever started it (stock CLI, Desktop app, a terminal).
    for pid in $(my_dsh_pids 'dsh (web|serve)|@deepseek-ai/dsh|dsh/(lib|src)/bin\.(js|ts)|DSH\.app/Contents/MacOS/'); do
      log "stopping dsh process $pid ($(ps -o command= -p "$pid" 2>/dev/null | cut -c1-80))"
      [ "$DRY" = 1 ] || kill "$pid" 2>/dev/null || true
    done
    # Listeners across the whole DSH port range (a stock install may sit on 3080..3089 or the next free one).
    for port in $(seq 3080 3099); do
      pids="$(lsof -ti tcp:$port -sTCP:LISTEN 2>/dev/null || true)"
      [ -z "$pids" ] || { log "stopping listener on :$port (pid $pids: $(ps -o comm= -p "$(echo "$pids" | head -1)" 2>/dev/null))"; [ "$DRY" = 1 ] || { echo "$pids" | xargs kill 2>/dev/null || true; }; }
    done
    # Our Dock apps (any instance: DSH, DSH Preview, DSH <Host>…) by bundle-id prefix, and the stock Desktop app.
    for app in "$HOME"/Applications/*.app /Applications/DSH.app; do
      [ -d "$app" ] || continue
      bid="$(defaults read "$app/Contents/Info.plist" CFBundleIdentifier 2>/dev/null || true)"
      # Ours by bundle-id prefix; the stock Desktop app by name (its id is set at release time, not in-tree).
      # Thin clients (…dsh-dock-app.remote-<host>-…, `pnpm remote-app`) open OTHER Macs' DSH and hold no local
      # state — they stay.
      case "$bid" in
        io.github.taliesinb.dsh-dock-app.remote-*) log "keeping $(basename "$app") (thin client for another Mac)"; continue ;;
        io.github.taliesinb.dsh-dock-app*|*deepseek*) ;;
        *) case "$(basename "$app")" in DSH.app) ;; *) continue ;; esac ;;
      esac
      log "removing $(basename "$app") ($bid)"
      [ "$DRY" = 1 ] || { osascript -e "tell application id \"$bid\" to quit" >/dev/null 2>&1 || true; pkill -f "$app/Contents/MacOS/" 2>/dev/null || true; sleep 1; rm -rf "$app"; }
    done
    # A globally installed stock CLI (npm/pnpm/bun/Homebrew), so the gate and PATH are clean afterwards.
    if command -v dsh >/dev/null 2>&1; then
      DSH_BIN="$(command -v dsh)"
      log "removing the global dsh CLI at $DSH_BIN"
      if [ "$DRY" = 0 ]; then
        npm uninstall -g @deepseek-ai/dsh >/dev/null 2>&1 || true
        pnpm remove -g @deepseek-ai/dsh >/dev/null 2>&1 || true
        bun remove -g @deepseek-ai/dsh >/dev/null 2>&1 || true
        brew uninstall dsh >/dev/null 2>&1 || true
        [ -e "$DSH_BIN" ] && { rm -f "$DSH_BIN" || warn "could not remove $DSH_BIN — remove it by hand"; }
      fi
    fi
    # The tailnet route for THIS instance's mount only (the plugin re-publishes it below). Never `serve reset`:
    # Serve config is per node, so on a shared machine that would take every other account's route down
    # (it did, once, 2026-09-22 — restored by restarting their instances).
    if [ -x "$TS" ] && [ "$DRY" = 0 ]; then
      if "$TS" serve status 2>/dev/null | grep -qE "[|]--[[:space:]]+${MOUNT}[[:space:]]"; then
        log "removing the Tailscale Serve path $MOUNT (re-published by the plugin below)"
        "$TS" serve --https=443 --set-path="$MOUNT" off >/dev/null 2>&1 || warn "tailscale serve … off failed for $MOUNT — check 'tailscale serve status'"
      fi
    fi
    # A profile assembled by another DSH version cannot be layered on; sessions, settings and credentials stay.
    if [ -d "$DSH_HOME_DIR/profiles" ] && [ ! -f "$DSH_HOME_DIR/bootstrap-mac.json" ] && [ ! -f "$DSH_HOME_DIR/tailscale-remote.json" ]; then
      log "moving the foreign $DSH_HOME_DIR/profiles aside (→ profiles.stock-backup); sessions/settings/credentials kept"
      [ "$DRY" = 1 ] || { rm -rf "$DSH_HOME_DIR/profiles.stock-backup"; mv "$DSH_HOME_DIR/profiles" "$DSH_HOME_DIR/profiles.stock-backup"; }
    fi
    if [ "$DRY" = 0 ]; then
      for port in $(seq 3080 3099); do [ -n "$(lsof -u "$(id -u)" -a -ti tcp:$port -sTCP:LISTEN 2>/dev/null || true)" ] && die "a process of yours still listens on :$port after the teardown"; done
      [ -z "$(my_dsh_pids 'apps/cli/(lib/bin\.js|src/bin\.ts)')" ] || die "a dsh process survived the teardown"
    fi
    ok "old install stopped and removed; ~/.dsh kept$( [ -d "$HOME/Applications/$DOCK_NAME.app" ] && echo '; the Dock app will be rebuilt' )"
  elif [ -f "$MARKER" ]; then
    ok "resuming an earlier bootstrap run ($MARKER; --no-replace: nothing is torn down)"
    [ -n "$DIR" ] || DIR="$(marker_dir)"
  elif [ "$FORCE" = 1 ]; then warn "--no-replace --force: continuing anyway (every step still skips what is already in place)"
  elif [ "$DRY" = 1 ]; then warn "a real run would ABORT here: DSH already appears to be installed or running on this Mac and --no-replace was given (drop it to take over, or add --force to layer on top); continuing the dry run"
  else die "DSH already appears to be installed or running on this Mac and --no-replace was given. Drop --no-replace to take it over (sessions, settings and credentials are kept), use the existing setup (INSTALLING.md day-to-day commands), or add --force to layer on top."; fi

  if [ "$DRY" = 0 ] && { ! have_brew || ! xcode-select -p >/dev/null 2>&1; }; then
    log "some steps need sudo (Homebrew install, Command Line Tools); asking for your password once now"
    if ! sudo -n -v 2>/dev/null; then
      has_tty || die "sudo needs a password but there is no terminal — run 'sudo -v' first, then re-run"
      sudo -v </dev/tty || die "sudo failed"
    fi
  fi
  # Resume marker (so a re-run after a mid-way failure passes the gate above).
  if [ "$DRY" = 0 ] && [ ! -f "$MARKER" ]; then
    mkdir -p "$DSH_HOME_DIR"
    write_marker "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  fi
fi

# ===========================================================================
if wants clt; then
  banner "Xcode Command Line Tools (git, swiftc for the Dock app)"
  if xcode-select -p >/dev/null 2>&1 && xcrun --find swiftc >/dev/null 2>&1; then
    ok "present at $(xcode-select -p) — $(xcrun swift --version 2>/dev/null | head -1)"
  else
    log "installing headlessly through softwareupdate (~500 MB)"
    if [ "$DRY" = 0 ]; then
      touch /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
      LABEL="$(softwareupdate -l 2>&1 | grep -o 'Label: Command Line Tools for Xcode.*' | sed 's/^Label: //' | sort -V | tail -1 || true)"
      if [ -n "$LABEL" ]; then
        run sudo softwareupdate -i "$LABEL" --verbose || warn "softwareupdate failed"
      fi
      rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
      if ! xcode-select -p >/dev/null 2>&1; then
        warn "falling back to the GUI installer; finish the dialog, then this script continues"
        xcode-select --install 2>/dev/null || true
        until xcode-select -p >/dev/null 2>&1; do sleep 5; done
      fi
    fi
    xcode-select -p >/dev/null 2>&1 && ok "installed at $(xcode-select -p)" || [ "$DRY" = 1 ] || die "Command Line Tools still missing"
  fi
fi

# ===========================================================================
if wants brew; then
  banner "Homebrew"
  if have_brew; then ok "present: $(/opt/homebrew/bin/brew --version | head -1)"
  else
    log "installing Homebrew (official installer, non-interactive; needs sudo)"
    [ "$DRY" = 1 ] || NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" 2>&1 | tee -a "$LOG" | sed 's/^/    │ /'
    have_brew || [ "$DRY" = 1 ] || die "Homebrew did not install"
  fi
  # The relay LaunchAgent starts DSH through `zsh -lc "pnpm dsh web"`, so brew must be on the LOGIN-shell PATH
  # even when Homebrew was already here (a bare install leaves ~/.zprofile untouched).
  if ! grep -qs 'brew shellenv' "$HOME/.zprofile" "$HOME/.zshenv" 2>/dev/null; then
    [ "$DRY" = 1 ] || echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >>"$HOME/.zprofile"
    ok "added brew shellenv to ~/.zprofile (login-shell PATH for the relay)"
  fi
  brew_env || true
fi
brew_env || true

# ===========================================================================
if wants tools; then
  banner "node, pnpm, git"
  have_brew || die "Homebrew missing (run the brew step)"
  # node/pnpm come from brew; Apple's git (Command Line Tools) is fine.
  MISSING=()
  for f in node pnpm; do brew list --formula "$f" >/dev/null 2>&1 || MISSING+=("$f"); done
  command -v git >/dev/null 2>&1 || MISSING+=(git)
  if [ ${#MISSING[@]} -gt 0 ]; then run brew install "${MISSING[@]}" || die "brew install failed"; fi
  brew_env
  if command -v node >/dev/null 2>&1 && command -v pnpm >/dev/null 2>&1; then
    NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
    [ "$NODE_MAJOR" -ge 24 ] || die "node $(node --version) is too old (the fork needs ^22.19 || >=24)"
    ok "node $(node --version), pnpm $(pnpm --version), git $(git --version | awk '{print $3}')"
  fi
fi

# ===========================================================================
if wants apps && [ "$APPS" = 1 ]; then
  banner "Third-party apps (Homebrew casks)"
  have_brew || die "Homebrew missing (run the brew step)"
  # app name | cask | why | minimum macOS major   (Tailscale is handled by the mandatory `tailscale` step)
  APP_TABLE=(
    "Safari Technology Preview|safari-technology-preview|safari_* tools (only STP ships safaridriver --mcp)|26"
    "Google Chrome|google-chrome|chrome_* tools (chrome-devtools-mcp)|13"
  )
  # Not offered: Dash is a paid app — its plugin is installed only when the app
  # is already there (see the exclusions below); extras plugins gate themselves
  # through the manifest's `requires:`.
  for row in "${APP_TABLE[@]}"; do
    IFS='|' read -r app cask why minmac <<<"$row"
    if [ -d "/Applications/$app.app" ] || [ -d "$HOME/Applications/$app.app" ]; then ok "$app.app present"; continue; fi
    if [ "$(macos_major)" -lt "$minmac" ]; then warn "$app: cask needs macOS ≥ $minmac — skipped"; continue; fi
    if confirm "Install $app ($why)?" y; then
      run brew install --cask "$cask" || warn "$cask failed to install (continuing)"
    else
      todo "install $app yourself (or: brew install --cask $cask)"
    fi
  done
  if [ -d "/Applications/Google Chrome.app" ] && [ ! -d "$HOME/Library/Application Support/Google/Chrome" ]; then
    # Chrome's first launch has to complete once per macOS user before chrome-devtools-mcp can drive it
    # (the plugin otherwise reports "automation session closed immediately on first launch"). Headless in
    # the background, no first-run/default-browser prompts, quit after the profile exists.
    if [ "$DRY" = 1 ]; then log "would first-launch Google Chrome once (creates the profile)"
    else
      open -ga "Google Chrome" --args --no-first-run --no-default-browser-check || true
      for i in 1 2 3 4 5 6 7 8 9 10; do [ -d "$HOME/Library/Application Support/Google/Chrome" ] && break; sleep 1; done
      osascript -e 'tell application "Google Chrome" to quit' >/dev/null 2>&1 || true
      [ -d "$HOME/Library/Application Support/Google/Chrome" ] && ok "Google Chrome first launch done (profile created)" || warn "Google Chrome did not create a profile — open it once by hand"
    fi
  fi
  if [ -d "/Applications/Safari Technology Preview.app" ]; then
    # STP must be launched once to accept its licence before safaridriver --mcp works.
    if [ ! -d "$HOME/Library/Containers/com.apple.SafariTechnologyPreview" ] && [ ! -d "$HOME/Library/Safari Technology Preview" ]; then
      [ "$DRY" = 1 ] || open -ga "Safari Technology Preview" || true
      todo "Safari Technology Preview was launched in the background — accept its licence once, then quit it"
    fi
    # "Allow Remote Automation" (Develop ▸ Developer Settings) is what safaridriver needs; Apple's
    # command-line switch for it is `safaridriver --enable` (needs an admin password once, per user).
    # Verified 2026-09-21: without it every safari_* call fails with WebDriverErrorDomain Code=6.
    SD="/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver"
    if [ "$DRY" = 1 ]; then log "would run: sudo safaridriver --enable (Allow Remote Automation)"
    elif sudo -n true 2>/dev/null || [ -t 0 ]; then
      if sudo "$SD" --enable; then ok "Allow Remote Automation enabled for this user (safaridriver --enable)"
      else warn "safaridriver --enable failed — enable Develop ▸ Developer Settings ▸ Allow Remote Automation in STP by hand"; fi
    else
      todo "run: sudo \"$SD\" --enable   (Allow Remote Automation; needed by the safari_* tools)"
    fi
  fi
fi

# Plugins that only make sense with a paid app already on the Mac: left out of
# the build and the bundle install when the app is absent (re-run
# `pnpm install-plugins` after installing the app to add them).
# Detect by bundle id through LaunchServices, not by path: Dash may live in
# /Applications/Setapp/Dash.app (com.kapeli.dash-setapp) or come from the App
# Store / a direct download (com.kapeli.dashdoc) — the plugin accepts both.
# Plugins of the optional extras layer carry their own gate in the manifest
# (`requires:`), evaluated by tools/extras-manifest.mjs — nothing about them is
# hardcoded here.
app_by_id()   { local b; for b in "$@"; do osascript -e "id of application id \"$b\"" >/dev/null 2>&1 && return 0; done; return 1; }
has_dash()    { app_by_id com.kapeli.dash-setapp com.kapeli.dashdoc || [ -d /Applications/Dash.app ] || [ -d /Applications/Setapp/Dash.app ]; }
EXCLUDED=()
has_dash    || EXCLUDED+=(dash-docsets)
excluded() { case " ${EXCLUDED[*]-} " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }   # ${arr[*]-}: bash 3.2 + set -u treats an empty array as unbound

# ===========================================================================
# ts_field state|login|dns over `tailscale status --self --json` (empty on any failure). python3 (Command Line
# Tools) rather than node: this runs before brew node exists on a fresh machine.
ts_field() {
  "$TS" status --self --json 2>/dev/null | python3 -c '
import json,sys
try:
    j=json.load(sys.stdin); w=sys.argv[1]; s=j.get("Self") or {}
    if w=="state": v=j.get("BackendState")
    elif w=="login": v=((j.get("User") or {}).get(str(s.get("UserID"))) or {}).get("LoginName")
    else: v=(s.get("DNSName") or "").rstrip(".")
    sys.stdout.write(v or "")
except Exception: pass' "$1" 2>/dev/null || true
}
ts_state() { ts_field state; }                                              # Running | Stopped | NeedsLogin | NeedsMachineAuth | NoState | ""
ts_login() { ts_field login; }                                              # e.g. user@example.com
ts_dns()   { ts_field dns; }
ts_ready() { [ "$(ts_state)" = Running ] && [ -n "$(ts_login)" ] && [ -n "$(ts_dns)" ]; }

if wants tailscale; then
  banner "Tailscale (required): installed, connected, logged in"
  # 1. Installed?
  if [ ! -x "$TS" ]; then
    warn "Tailscale.app is not installed. DSH's tailnet route, the Dock app and the remotes all depend on it."
    if have_brew && confirm "Install Tailscale now (brew install --cask tailscale-app)?" y; then
      run brew install --cask tailscale-app || die "Tailscale install failed — install it from https://tailscale.com/download/mac, log in, then re-run"
    else
      die "Install Tailscale (https://tailscale.com/download/mac or: brew install --cask tailscale-app), log in as the same tailnet user as your other DSH Macs, then re-run this script."
    fi
    [ -x "$TS" ] || [ "$DRY" = 1 ] || die "Tailscale.app still missing after the install"
  fi
  if [ "$DRY" = 1 ] && [ ! -x "$TS" ]; then log "would connect/log in Tailscale and require a tailnet login"
  else
    # 2. The GUI app must be running for its CLI to talk to the backend (it is a network extension owned by the app).
    pgrep -xq Tailscale || { [ "$DRY" = 1 ] || { open -ga Tailscale 2>/dev/null || true; sleep 4; }; }
    state="$(ts_state)"
    log "backend state: ${state:-unknown} $( [ -n "$(ts_login)" ] && echo "(login $(ts_login))" )"
    if [ "$DRY" = 0 ] && ! ts_ready; then
      case "$state" in
        Stopped)
          # Logged in but disconnected: reconnect on the command line.
          log "Tailscale is logged in but disconnected — connecting (tailscale up)"
          "$TS" up --timeout 60s 2>&1 | sed 's/^/    │ /' || true ;;
        NeedsLogin|NoState|""|*)
          warn "Tailscale is not logged in. Log in as the SAME tailnet user as your other DSH Macs (the ACL only lets a user reach their own devices)."
          # `tailscale up` prints the auth URL and blocks until the browser login completes; run it in the
          # background, surface (and open) the URL, and poll the backend state.
          UPLOG="$LOGDIR/tailscale-up.log"; : >"$UPLOG"
          ( "$TS" up >"$UPLOG" 2>&1 ) &
          UP_PID=$!
          waited=0; shown=0
          until ts_ready; do
            if [ "$shown" = 0 ]; then
              url="$(grep -o 'https://login.tailscale.com/[^[:space:]]*' "$UPLOG" 2>/dev/null | head -1 || true)"
              if [ -n "$url" ]; then
                printf '    %slog in here:%s %s\n' "$BOLD" "$NC" "$url" | tee -a "$LOG"
                has_tty && open "$url" 2>/dev/null || true
                shown=1
              fi
            fi
            kill -0 "$UP_PID" 2>/dev/null || { sleep 2; ts_ready && break; ( "$TS" up >"$UPLOG" 2>&1 ) & UP_PID=$!; }
            sleep 5; waited=$((waited+5))
            if [ "$TS_TIMEOUT" -gt 0 ] && [ "$waited" -ge "$TS_TIMEOUT" ]; then break; fi
            [ $((waited % 60)) = 0 ] && log "still waiting for the Tailscale login (${waited}s; state $(ts_state))…"
          done
          kill "$UP_PID" 2>/dev/null || true ;;
      esac
      # NeedsMachineAuth: the tailnet admin must approve this device first.
      [ "$(ts_state)" = NeedsMachineAuth ] && warn "this device needs approval by the tailnet admin (Machines → Approve) before it is usable"
    fi
    if ts_ready; then ok "Tailscale connected: $(ts_dns) as $(ts_login)"
    elif [ "$DRY" = 1 ]; then warn "a real run would ABORT here: Tailscale is not connected with a tailnet login (state: ${state:-unknown})"
    else die "Tailscale is not connected with a tailnet login (state: $(ts_state), login: '$(ts_login)'). Open Tailscale.app, log in as the same user as your other DSH Macs, wait until it shows Connected, then re-run this script."; fi
  fi
fi

# ===========================================================================
if wants clone; then
  banner "Clone tali-dash-plugins (fork inside as the submodule deepseek-harness/)"
  # The repo name is fixed; only WHERE the checkouts live is a choice (~/github, ~/code, ~/src…). --dir names the
  # full path for the rare other layout.
  if [ -z "$DIR" ]; then
    [ -n "$PARENT" ] || ask PARENT "Directory your git checkouts live in (the clone goes to <it>/tali-dash-plugins)" "$HOME/github"
    DIR="${PARENT/#\~/$HOME}/tali-dash-plugins"
  fi
  DIR="${DIR/#\~/$HOME}"
  # stash_local_edits: park uncommitted edits (this is an installer, not a dev checkout) so a checkout/reset can proceed.
  stash_local_edits() {
    local dirty; dirty="$(git -C "$DIR" status --short 2>/dev/null | head -5)"
    [ -n "$dirty" ] || return 0
    log "local edits in $DIR (saved as a stash):"; echo "$dirty" | sed 's/^/    /'
    [ "$DRY" = 1 ] || git -C "$DIR" stash push -q -u -m "bootstrap-mac $(date +%F)" >/dev/null 2>&1 || true
  }
  if [ -d "$DIR/.git" ] || [ -f "$DIR/.git" ]; then
    ok "existing clone at $DIR — adopting it"
  else
    log "cloning $REPO → $DIR (a few minutes; the fork comes next as a submodule)"
    [ "$DRY" = 1 ] || mkdir -p "$(dirname "$DIR")"
    run git clone "$REPO" "$DIR" || die "clone failed"
  fi
  if [ "$DRY" = 0 ]; then
    git -C "$DIR" fetch -q --tags origin 2>>"$LOG" || warn "could not fetch origin — continuing with what is checked out"
    DEFAULT_BRANCH="$(git -C "$DIR" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"; DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"
    CUR_BRANCH="$(git -C "$DIR" symbolic-ref -q --short HEAD 2>/dev/null || echo detached)"
    if [ -n "$REF" ]; then
      # --ref: a branch on origin becomes a local tracking branch (later ff-only pulls — this script's or
      # sync-host's — follow THAT branch); a tag or commit is checked out detached. The fork follows the pin
      # recorded in that commit, so a branch that needs fork changes bumps the submodule gitlink.
      if git -C "$DIR" rev-parse -q --verify "refs/remotes/origin/$REF" >/dev/null 2>&1; then
        [ "$CUR_BRANCH" = "$REF" ] || { stash_local_edits; log "checking out branch $REF (tracking origin/$REF)"; }
        git -C "$DIR" checkout -q -B "$REF" "origin/$REF" 2>>"$LOG" || die "could not check out branch $REF"
      elif git -C "$DIR" rev-parse -q --verify "$REF^{commit}" >/dev/null 2>&1; then
        stash_local_edits; log "checking out $REF (detached; later runs without --ref return to $DEFAULT_BRANCH)"
        git -C "$DIR" checkout -q --detach "$REF" 2>>"$LOG" || die "could not check out $REF"
      else die "--ref $REF is neither a branch on origin, a tag nor a commit of $REPO (pushed?)"; fi
    else
      # No --ref: the default branch, current. A clone left on another branch or detached (an earlier --ref, a
      # manual checkout) is moved back — an installer deploys "the current main" unless told otherwise.
      if [ "$CUR_BRANCH" != "$DEFAULT_BRANCH" ]; then
        stash_local_edits; log "clone is on '$CUR_BRANCH' — back to $DEFAULT_BRANCH (no --ref given)"
        git -C "$DIR" checkout -q -B "$DEFAULT_BRANCH" "origin/$DEFAULT_BRANCH" 2>>"$LOG" || die "could not check out $DEFAULT_BRANCH"
      elif ! git -C "$DIR" pull --ff-only -q 2>>"$LOG"; then
        # Diverged (a local commit, or a clone from before one of the history rewrites) or a conflicting edit:
        # nothing here is worth keeping over origin — stash and reset.
        stash_local_edits
        log "resetting $DIR onto origin/$DEFAULT_BRANCH (history diverged — likely a clone from before a rewrite)"
        git -C "$DIR" reset -q --hard "origin/$DEFAULT_BRANCH" 2>>"$LOG" || die "could not reset $DIR onto origin/$DEFAULT_BRANCH"
      fi
    fi
    ok "$DIR at $(git -C "$DIR" log -1 --format='%h %s' 2>/dev/null | cut -c1-70) [$(git -C "$DIR" symbolic-ref -q --short HEAD 2>/dev/null || echo "detached${REF:+ at $REF}")]"
  elif [ -n "$REF" ]; then log "would check out --ref $REF"; fi
  # .gitmodules points at the fork over ssh (git@github.com:…), which needs a GitHub key on this Mac —
  # a fresh machine has none ("Host key verification failed" on the first remote). The fork is public, so fetch the
  # submodule over https by overriding the URL in this clone's config only; .gitmodules stays as is.
  if [ "$DRY" = 0 ] || [ -d "$DIR/.git" ]; then
    [ "$DRY" = 1 ] || git -C "$DIR" submodule init >/dev/null 2>&1 || true
    for name in $(git -C "$DIR" config -f .gitmodules --name-only --get-regexp 'submodule\..*\.url' 2>/dev/null | sed -E 's/^submodule\.(.*)\.url$/\1/'); do
      [ "$name" = extras ] && continue   # private: stays on ssh (an https fetch would prompt for credentials)
      # The EFFECTIVE url (this clone's config, seeded from .gitmodules by `submodule init`): an override someone
      # already put there (https, a mirror, a local path) is respected; only an ssh url is rewritten.
      cururl="$(git -C "$DIR" config --get "submodule.$name.url" 2>/dev/null || git -C "$DIR" config -f .gitmodules --get "submodule.$name.url" || true)"
      case "$cururl" in
        git@github.com:*)
          https="https://github.com/${cururl#git@github.com:}"
          log "submodule $name: fetching over https ($https) instead of ssh"
          [ "$DRY" = 1 ] || git -C "$DIR" config "submodule.$name.url" "$https" ;;
      esac
    done
  fi
  # The fork is pinned by SHA (detached), so a rebased/force-pushed fork is no problem: `submodule update`
  # fetches whatever is missing and checks the pin out. What DOES fail: (a) local edits in the submodule
  # that the checkout would overwrite — stash them (tracked first, then untracked too) and retry; (b) a
  # leftover deepseek-harness/ that is not a git worktree (a clone that died half-way) — move it aside.
  SUB="$DIR/deepseek-harness"
  # "not a git checkout" = its git toplevel is not itself (a bare subdirectory of the parent clone reports the parent).
  if [ "$DRY" = 0 ] && [ -d "$SUB" ] && [ -n "$(ls -A "$SUB" 2>/dev/null)" ] && [ "$(git -C "$SUB" rev-parse --show-toplevel 2>/dev/null || true)" != "$(cd "$SUB" && pwd -P)" ]; then
    aside="$SUB.broken-$(date +%Y%m%d-%H%M%S)"
    warn "$SUB exists but is not a git checkout (an earlier clone died half-way?) — moving it to $aside"
    mv "$SUB" "$aside" || die "could not move $SUB aside"
  fi
  if ! run git -C "$DIR" submodule update --init deepseek-harness; then
    [ "$DRY" = 1 ] && die "submodule checkout failed"
    git -C "$SUB" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "submodule checkout failed (see $LOG)"
    dirty="$(git -C "$SUB" status --short 2>/dev/null | head -8)"
    [ -n "$dirty" ] || die "submodule checkout failed and the fork checkout is clean — a network or permission problem? (see $LOG)"
    log "local edits in the fork checkout $SUB block the pinned commit (saved as a stash there):"; echo "$dirty" | sed 's/^/    /'
    git -C "$SUB" stash push -q -m "bootstrap-mac $(date +%F)" >>"$LOG" 2>&1 || true
    if ! run git -C "$DIR" submodule update --init deepseek-harness; then
      git -C "$SUB" stash push -q -u -m "bootstrap-mac $(date +%F) (untracked)" >>"$LOG" 2>&1 || true
      run git -C "$DIR" submodule update --init deepseek-harness || die "submodule checkout still fails after stashing local edits (see $LOG; git -C $SUB stash list)"
    fi
    ok "fork checkout at the pinned commit; your edits: git -C $SUB stash list"
  fi
  # `extras/` is an OPTIONAL private layer (symbolica-ai/dsh-extras: deployment inventory, pins of private
  # plugins). Its existence is public, its contents need org access over ssh. Absent access → warn and
  # continue; the public plugin set is complete on its own. Inside it, nested pins are fetched recursively.
  if git -C "$DIR" config -f .gitmodules --get submodule.extras.url >/dev/null 2>&1; then
    if [ "$DRY" = 1 ]; then log "would try: git submodule update --init extras (optional; skipped without GitHub org access)"
    elif git -C "$DIR" submodule update --init extras >>"$LOG" 2>&1 && git -C "$DIR/extras" submodule update --init --recursive >>"$LOG" 2>&1; then
      ok "extras layer checked out ($(git -C "$DIR/extras" log --oneline -1 | cut -c1-7)); private plugins will be layered on"
    else
      git -C "$DIR" submodule deinit -f extras >/dev/null 2>&1 || true
      warn "extras layer not reachable (no access to symbolica-ai/dsh-extras from this Mac?) — continuing with the public plugin set only"
    fi
  fi
  # A freshly cloned submodule keeps `core.worktree` in its common config (.git/modules/<name>/config).
  # The fork's pnpm postinstall (scripts/install-lefthook.mjs) refuses that layout — and pnpm re-runs the
  # postinstall before EVERY `pnpm dsh …` (verify-deps-before-run), so nothing in the fork would work.
  # Do the migration its error message asks for: repository format 1, extensions.worktreeConfig, and
  # core.worktree moved into config.worktree. (the maintainer's own submodule has an embedded .git dir and no
  # core.worktree, which is why this never showed up there.)
  if [ "$DRY" = 0 ]; then
    for sub in $(git -C "$DIR" submodule --quiet foreach 'echo $sm_path' 2>/dev/null); do
      gd="$(git -C "$DIR/$sub" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
      [ -n "$gd" ] || continue
      wt="$(git config --file "$gd/config" core.worktree 2>/dev/null || true)"
      if [ -n "$wt" ]; then
        git config --file "$gd/config" core.repositoryFormatVersion 1
        git config --file "$gd/config" extensions.worktreeConfig true
        git config --file "$gd/config" --unset core.worktree
        git config --file "$gd/config.worktree" core.worktree "$wt"
        ok "submodule $sub: core.worktree moved to config.worktree (repository format 1, extensions.worktreeConfig)"
      fi
    done
  fi
else
  [ -n "$DIR" ] || DIR="${PARENT:-$HOME/github}/tali-dash-plugins"; DIR="${DIR/#\~/$HOME}"
fi
CK="$DIR/deepseek-harness"
[ "$DRY" = 1 ] || [ -f "$CK/package.json" ] || die "fork submodule not present at $CK (run the clone step)"
# The marker is written before the directory is known; record it now so a bare re-run finds the clone.
MARKER="${DSH_HOME:-$HOME/.dsh}/bootstrap-mac.json"
[ -n "$WEB_PORT" ] || set_ports "$MARKER"
if [ "$DRY" = 0 ] && [ -f "$MARKER" ] && ! grep -q "\"dir\": \"$DIR\"" "$MARKER"; then
  write_marker "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("started",""))' "$MARKER" 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
fi

# ===========================================================================
# Built artifacts are only as fresh as the commit they were built from: after an adopt-and-update (the pin moved,
# `git pull` brought new plugin sources) `apps/cli/lib/bin.js` / `lib/client.js` still exist but are STALE. The
# commit each build came from is recorded in $DSH_HOME/bootstrap-built.json ({fork, plugins}); a mismatch
# rebuilds. No record (an install from before 2026-09-23) rebuilds once.
BUILT="${DSH_HOME:-$HOME/.dsh}/bootstrap-built.json"
built_sha() { grep -o "\"$1\": *\"[0-9a-f]*\"" "$BUILT" 2>/dev/null | grep -o '[0-9a-f]\{7,\}' || true; }
record_built() { # record_built fork|plugins SHA
  local f p; f="$(built_sha fork)"; p="$(built_sha plugins)"
  case "$1" in fork) f="$2" ;; plugins) p="$2" ;; esac
  [ "$DRY" = 1 ] || { mkdir -p "$(dirname "$BUILT")"; printf '{ "fork": "%s", "plugins": "%s" }\n' "$f" "$p" >"$BUILT"; }
}
FORK_SHA="$(git -C "$CK" rev-parse HEAD 2>/dev/null || true)"
PLUGINS_SHA="$(git -C "$DIR" rev-parse HEAD 2>/dev/null || true)"

if wants fork; then
  banner "Build the DSH fork ($CK)"
  if [ "$REBUILD" = 0 ] && [ -f "$CK/apps/cli/lib/bin.js" ] && [ -d "$CK/node_modules" ] && [ -n "$FORK_SHA" ] && [ "$(built_sha fork)" = "$FORK_SHA" ]; then
    ok "already built from ${FORK_SHA:0:10} (apps/cli/lib/bin.js exists; --rebuild to force)"
  else
    if [ -f "$CK/apps/cli/lib/bin.js" ] && [ "$REBUILD" = 0 ]; then
      prev="$(built_sha fork)"
      [ -n "$prev" ] && log "fork checkout moved ${prev:0:10} → ${FORK_SHA:0:10} since the last build — rebuilding" || log "existing build of unknown provenance (no $BUILT record) — rebuilding once"
    fi
    log "pnpm install (the fork pins pnpm via packageManager; pnpm fetches that version itself)"
    if [ "$DRY" = 1 ] && [ ! -d "$CK" ]; then log "would run pnpm install && pnpm run build in $CK"; else
    (cd "$CK" && runq pnpm install) || die "pnpm install failed in $CK"
    log "pnpm run build (~2 minutes)"
    (cd "$CK" && runq pnpm run build) || die "fork build failed"
    [ -f "$CK/apps/cli/lib/bin.js" ] || [ "$DRY" = 1 ] || die "build reported success but $CK/apps/cli/lib/bin.js is missing"
    fi
    record_built fork "$FORK_SHA"
    ok "built from ${FORK_SHA:0:10}"
  fi
fi

# ===========================================================================
if wants plugins; then
  banner "Install + build the plugins ($DIR/plugins)"
  RB="$REBUILD"
  if [ "$RB" = 0 ] && [ -n "$PLUGINS_SHA" ] && [ "$(built_sha plugins)" != "$PLUGINS_SHA" ] && ls "$DIR"/plugins/*/lib/client.js >/dev/null 2>&1; then
    prev="$(built_sha plugins)"
    [ -n "$prev" ] && log "plugin sources moved ${prev:0:10} → ${PLUGINS_SHA:0:10} since the last build — rebuilding all plugins" || log "existing plugin builds of unknown provenance (no $BUILT record) — rebuilding once"
    RB=1
  fi
  # The dev overlay needs absolute paths: generate cordis.dev.local.yml from the committed template.
  if [ -x "$DIR/tools/dev-overlay.sh" ]; then
    if [ "$DRY" = 1 ]; then log "would write cordis.dev.local.yml (pnpm dev-overlay)"; else "$DIR/tools/dev-overlay.sh" >>"$LOG" 2>&1 && ok "cordis.dev.local.yml written for $DIR" || warn "dev-overlay failed (preview overlay only)"; fi
  fi
  # Extras plugins: the manifest reader evaluates each `requires` gate (`ok` / `-` / `missing:<what>`) and
  # names an optional `check` hook; skipped ones are reported with the manifest's own words. Rows are
  # "path|status|check" (spaces are impossible in the paths, `|` is not a manifest character).
  EXTRA_ROWS=""; EXTRA_CHECKS=""
  if [ -f "$DIR/extras/dsh-extras.yml" ] && [ -f "$DIR/tools/extras-manifest.mjs" ]; then
    EXTRA_ROWS="$(node "$DIR/tools/extras-manifest.mjs" "$DIR" 2>/dev/null | while IFS=$'\t' read -r epath ebundle einstall estatus echeck; do
      case "$estatus" in missing:*) echo "SKIP|$epath|${estatus#missing:}" ;; *) echo "$epath/|$estatus|$echeck" ;; esac
    done)"
  fi
  for row in "$DIR"/plugins/*/ $EXTRA_ROWS; do
    pdir="${row%%|*}"
    case "$row" in SKIP\|*) warn "extras plugin $(basename "$(echo "$row" | cut -d'|' -f2)") skipped — requires $(echo "$row" | cut -d'|' -f3), not on this Mac"; continue;; esac
    p="$(basename "$pdir")"; [ -f "$pdir/package.json" ] || continue
    case "$pdir" in "$DIR"/extras/*) p="extras:${pdir#"$DIR"/extras/}"; p="${p%/}"; c="$(echo "$row" | cut -d'|' -f3)"; [ "$c" = "-" ] || [ -z "$c" ] || EXTRA_CHECKS="$EXTRA_CHECKS $c" ;; esac
    if excluded "$p"; then
      case "$p" in
        dash-docsets) warn "$p skipped — Dash.app (paid) is not installed" ;;
        *) log "$p skipped (not a live-profile plugin)" ;;
      esac
      continue
    fi
    ndeps="$(pkg_field "$pdir" 'Object.keys({...(p.dependencies??{}),...(p.devDependencies??{})}).length' || echo 0)"
    isclient="$(pkg_field "$pdir" 'p.dsh?.client ? "yes" : ""' || true)"
    hasbuild="$(pkg_field "$pdir" 'p.scripts?.build ? "yes" : ""' || true)"
    if [ "$ndeps" != 0 ] && { [ ! -d "$pdir/node_modules" ] || [ "$RB" = 1 ]; }; then
      # Dependency build scripts (esbuild, sharp, ripgrep, chrome-devtools-mcp) are approved declaratively in each
      # plugin's pnpm-workspace.yaml (`allowBuilds`). No CLI flag: --dangerously-allow-all-builds conflicts with
      # allowBuilds on pnpm 10.32 ("Cannot have both neverBuiltDependencies and onlyBuiltDependencies").
      (cd "$pdir" && runq pnpm install) || die "pnpm install failed in plugins/$p"
    fi
    if [ -n "$hasbuild" ] && { [ ! -f "$pdir/lib/client.js" ] || [ "$RB" = 1 ]; }; then
      (cd "$pdir" && runq pnpm build) || die "build failed in plugins/$p"
    fi
    if [ -n "$isclient" ] && [ ! -f "$pdir/lib/client.js" ] && [ "$DRY" = 0 ]; then die "plugins/$p is a client plugin without lib/client.js"; fi
    ok "$p"
  done
  # Post-build hooks named by the extras manifest (`check:`): every line one prints is something only a
  # human can finish (a per-user licence, a login), so it goes on the to-do list.
  for c in $EXTRA_CHECKS; do
    [ -x "$c" ] || { warn "extras check hook not executable: $c"; continue; }
    if [ "$DRY" = 1 ]; then log "would run extras check hook $(basename "$c")"; continue; fi
    while IFS= read -r line; do [ -n "$line" ] && todo "$line"; done < <("$c" 2>>"$LOG" || true)
  done
  [ -z "$PLUGINS_SHA" ] || record_built plugins "$PLUGINS_SHA"
fi

# ===========================================================================
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
if wants home; then
  banner "Initialise the DSH home ($DSH_HOME_DIR)"
  if [ -f "$DSH_HOME_DIR/profiles/web/cordis.patch.yml" ]; then ok "web profile exists"
  elif [ "$DRY" = 1 ]; then log "would launch dsh web once to create $DSH_HOME_DIR/profiles/web"
  else
    if port_busy "$WEB_PORT"; then die "something already listens on :$WEB_PORT — stop it, then re-run (--only home)"; fi
    log "first launch of dsh web on :$WEB_PORT (creates profiles/web/cordis.patch.yml and .credentials.yaml), then stopping it"
    (cd "$CK" && pnpm dsh web --no-open --port "$WEB_PORT" >>"$LOG" 2>&1 &)
    wait_http "http://127.0.0.1:$WEB_PORT/" 401 90 || die "dsh web did not come up within 90 s (see $LOG)"
    # Stop exactly the process listening on our port (never a pkill by name — another DSH may be running).
    lsof -ti tcp:"$WEB_PORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
    sleep 2
    [ -f "$DSH_HOME_DIR/profiles/web/cordis.patch.yml" ] || die "profile not created"
    ok "home initialised"
  fi
  # Model-generated session titles as slugs (foo-bar-baz), the shape the hand-typed `slug:` convention of
  # session-title-slug produces: the fork's `style: slug` on the in-tree session-title-llm row. The base bundle
  # leaves `style` unset (natural-language titles), so every new home needs this override — the remote instances shipped
  # without it (recipes/model-titles-not-slugs-on-new-instance.md). A patch row replaces the whole config, so
  # the bundle's other keys are restated.
  PATCH="$DSH_HOME_DIR/profiles/web/cordis.patch.yml"
  TITLE_ROW='{"config":{"targetWords":5,"targetCjkCharacters":10,"maxInputBytes":4096,"maxOutputTokens":64,"timeoutMs":60000,"style":"slug"}}'
  if grep -q 'style: slug' "$PATCH" 2>/dev/null; then ok "session-title-llm override present (slug titles)"
  elif [ "$DRY" = 1 ]; then log "would set the session-title-llm row (style: slug) in $PATCH"
  elif patch_set_row "$PATCH" session-title-llm "$TITLE_ROW"; then ok "$PATCH: session-title-llm → style: slug (model titles come out as foo-bar-baz)"
  else warn "no yaml package in the checkout; add the session-title-llm row (style: slug) to $PATCH by hand (INSTALLING.md C4)"; fi
  # A fresh home's .credentials.yaml holds only the browser-session grant the first launch writes; provider keys
  # are further `records:` entries. A --replace host keeps its keys.
  if [ "$(grep -E '^  [^ ]' "$DSH_HOME_DIR/.credentials.yaml" 2>/dev/null | grep -vc 'client-connection/' || true)" = 0 ]; then
    todo "add at least one cloud provider + key in the GUI (Settings → Providers); keys go to $DSH_HOME_DIR/.credentials.yaml"
  else ok "credentials present in $DSH_HOME_DIR/.credentials.yaml"; fi
fi

# ===========================================================================
if wants install-plugins; then
  banner "Install the plugins into the web profile as bundles"
  [ -x "$DIR/tools/install-plugins.sh" ] || [ "$DRY" = 1 ] || die "tools/install-plugins.sh missing in $DIR"
  WITHOUT=""
  for p in "${EXCLUDED[@]-}"; do [ -n "$p" ] && WITHOUT="$WITHOUT,$p"; done
  [ -z "${USER_WITHOUT:-}" ] || WITHOUT="$WITHOUT,$USER_WITHOUT"
  WITHOUT="${WITHOUT#,}"
  IP_ARGS=(--checkout "$CK"); [ -z "$WITHOUT" ] || IP_ARGS+=(--without "$WITHOUT")
  if [ "$DRY" = 1 ] && [ ! -d "$DIR" ]; then log "would run tools/install-plugins.sh ${IP_ARGS[*]}"
  else (cd "$DIR" && run tools/install-plugins.sh "${IP_ARGS[@]}") || die "install-plugins failed"; fi
  has_dash    || todo "if you buy Dash later: install it, then re-run: pnpm install-plugins (adds the dash_* tools)"
  # Extras plugins skipped by their `requires` gate are listed by install-plugins.sh itself ("skipped (requires …)");
  # the same re-run adds them once the requirement is met.
fi

# ===========================================================================
if wants preset; then
  banner "User preset minimal-no-tools (used by the Apple rule; harmless otherwise)"
  PRESET="$DSH_HOME_DIR/.agent-presets/minimal-no-tools"
  NGT="$DIR/plugins/no-global-tools/index.js"
  if [ -f "$PRESET/agent.cordis.yml" ]; then
    ok "present"
    # Older presets lack the row that hides host plugins' global tools (see plugins/no-global-tools/README.md).
    if [ -f "$NGT" ] && ! grep -q 'id: no-global-tools' "$PRESET/agent.cordis.yml"; then
      [ "$DRY" = 1 ] || printf '\n# Hide the host plugins'"'"' globally registered tools too (62 schemas do not fit a 4K window).\n- id: no-global-tools\n  name: %s\n' "$NGT" >>"$PRESET/agent.cordis.yml"
      ok "added the no-global-tools row to the preset"
    fi
  elif [ "$DRY" = 1 ]; then log "would write $PRESET/{preset.yml,agent.cordis.yml}"
  else
    mkdir -p "$PRESET"
    cat >"$PRESET/preset.yml" <<'EOF'
name: Minimal (no tools)
description: Chat-only composition for tiny local models — a one-line persona, no tools, no runtime context. Pairs with small context windows (e.g. Apple Foundation on-device).
order: 4
EOF
    cat >"$PRESET/agent.cordis.yml" <<'EOF'
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: You are a helpful, concise assistant.
    complete: true
    includeRuntimeContext: false
EOF
    if [ -f "$NGT" ]; then
      printf '\n# Hide the host plugins'"'"' globally registered tools too: the preset only omits the in-tree tool\n# groups, and 62 schemas do not fit a 4K window. Preset rows run in the agent scope, where\n# ctx.tools.restrict({ allow: [] }) is allowed (plugins/no-global-tools/README.md).\n- id: no-global-tools\n  name: %s\n' "$NGT" >>"$PRESET/agent.cordis.yml"
    fi
    ok "written"
  fi
fi

# ===========================================================================
if wants apple && [ "$APPLE" = 1 ]; then
  banner "Apple on-device model: afm + the apple provider"
  MAJOR="$(macos_major)"
  if [ "$MAJOR" -lt 26 ]; then warn "macOS < 26: no FoundationModels — skipped"
  else
    have_brew || die "Homebrew missing"
    if command -v afm >/dev/null 2>&1; then ok "afm present: $(afm --version 2>/dev/null | head -1)"
    else
      # Homebrew ≥ 6 refuses untrusted third-party taps.
      brew trust scouzi1966/afm >/dev/null 2>&1 || true
      if [ "$MAJOR" -ge 27 ]; then
        run brew install scouzi1966/afm/afm || warn "afm install failed"
      else
        # macOS 26.x: stable ≥ 0.9.17 needs the Swift 6.4 runtime → pin 0.9.10 and fix its metallib packaging bug.
        run brew install scouzi1966/afm/afm@0.9.10 || warn "afm@0.9.10 install failed"
        if [ "$DRY" = 0 ] && [ -d /opt/homebrew/Cellar/afm@0.9.10/0.9.10 ]; then
          brew link afm@0.9.10 >/dev/null 2>&1 || true
          KEG=/opt/homebrew/Cellar/afm@0.9.10/0.9.10
          ln -sfn "$KEG/libexec/MacLocalAPI_MacLocalAPI.bundle" /opt/homebrew/bin/mlx-swift_Cmlx.bundle
          ln -sfn ../libexec/MacLocalAPI_MacLocalAPI.bundle "$KEG/bin/mlx-swift_Cmlx.bundle"
        fi
      fi
    fi
    # settings.yaml: add the apple provider under llm-pi-ai.providers (merge, never overwrite other keys).
    SETTINGS="$DSH_HOME_DIR/settings.yaml"
    YAMLPKG="$(ls -d "$CK"/node_modules/.pnpm/yaml@*/node_modules/yaml 2>/dev/null | sort -V | tail -1 || true)"   # `|| true`: under set -e a failing substitution in an assignment exits silently
    if [ "$DRY" = 1 ]; then log "would merge the apple provider into $SETTINGS"
    elif [ -z "$YAMLPKG" ]; then warn "no yaml package in the checkout; add the apple provider to $SETTINGS by hand (INSTALLING.md C3)"
    else
      node - "$SETTINGS" "$YAMLPKG" <<'JS'
const fs = require('fs'); const [file, yamlPath] = process.argv.slice(2);
const YAML = require(yamlPath);
const doc = fs.existsSync(file) ? (YAML.parse(fs.readFileSync(file, 'utf8')) ?? {}) : {};
doc['llm-pi-ai'] ??= {}; doc['llm-pi-ai'].providers ??= {};
if (doc['llm-pi-ai'].providers.apple) { console.log('    apple provider already configured'); process.exit(0); }
doc['llm-pi-ai'].providers.apple = {
  displayName: 'Apple Foundation', api: 'openai-completions', baseURL: 'http://127.0.0.1:9997/v1',
  headers: { Authorization: 'Bearer x' },
  compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
  models: [{ id: 'foundation', name: 'Apple Foundation (on-device)', contextWindow: 16384, maxTokens: 1024 }],
};
fs.writeFileSync(file, YAML.stringify(doc)); console.log('    apple provider written to ' + file);
JS
    fi
    if command -v afm >/dev/null 2>&1 && [ "$DRY" = 0 ]; then
      log "smoke test: afm --port 9997"
      (afm --port 9997 >"$LOGDIR/afm-smoke.log" 2>&1 &)
      sleep 4
      if curl -s --max-time 5 http://127.0.0.1:9997/v1/models >/dev/null; then
        R="$(curl -s --max-time 30 http://127.0.0.1:9997/v1/chat/completions -H 'content-type: application/json' -H 'authorization: Bearer x' \
          -d '{"model":"foundation","messages":[{"role":"user","content":"Reply with exactly: ok"}],"max_tokens":20}' || true)"
        case "$R" in
          *"not enabled"*) todo "System Settings → Apple Intelligence & Siri → enable, and wait for the model download (afm says: Apple Intelligence is not enabled)" ;;
          *'"content"'*) ok "afm answers" ;;
          *) warn "afm answered unexpectedly: ${R:0:200}" ;;
        esac
      else warn "afm did not start (see $LOGDIR/afm-smoke.log)"; fi
      pkill -f 'afm --port 9997' 2>/dev/null || true
    fi
  fi
fi

# ===========================================================================
RELAY_LABEL=io.github.taliesinb.dsh-web-relay
if wants tailnet && [ "$TAILNET" = 1 ]; then
  banner "Tailnet layer: relay LaunchAgent, tailscale serve route, Dock app"
  if [ "$DRY" = 0 ] && ! ts_ready; then
    die "Tailscale is no longer connected (state: $(ts_state)) — reconnect, then re-run: $0 --dir $DIR --only tailnet"
  fi
  if [ "$DRY" = 1 ]; then log "would install the relay, enable the route, build the Dock app"; fi
  {
      PLUG="$DIR/plugins/dsh-tailscale-remote"
      START="pnpm dsh web --no-open --port $WEB_PORT"
      # 1. Non-default ports / route / Dock app name: override the bundle row's config in the profile patch
      #    (a patch row replaces the whole config; unset keys fall back to the plugin's schema defaults).
      if [ "$WEB_PORT" != 3080 ] || [ -n "$INSTANCE" ] || [ "$MOUNT" != /dsh ]; then
        PATCH="$DSH_HOME_DIR/profiles/web/cordis.patch.yml"
        TSR_ROW="$(node -e 'const [l,p,m,d,s]=process.argv.slice(1); process.stdout.write(JSON.stringify({config:{listenPort:Number(l),publishPort:Number(p),mountPath:m,dockAppName:d,relayStart:s}}))' "$PROXY_PORT" "$RELAY_PORT" "$MOUNT" "$DOCK_NAME" "$START")"
        if [ "$DRY" = 1 ]; then log "would set tali-tailscale-remote {listenPort $PROXY_PORT, publishPort $RELAY_PORT, mountPath $MOUNT, dockAppName $DOCK_NAME} in $PATCH"
        elif patch_set_row "$PATCH" tali-tailscale-remote "$TSR_ROW"; then ok "$PATCH: tali-tailscale-remote → proxy :$PROXY_PORT, relay :$RELAY_PORT, route $MOUNT, Dock app $DOCK_NAME"
        else die "no yaml package in the checkout to edit $PATCH"; fi
      fi
      # 2. Relay LaunchAgent (relay → proxy; starts `dsh web` on demand). A LaunchAgent needs this account's GUI
      #    login session to load into; an ssh-only install on a shared machine has none, so there the plist is
      #    written unloaded (it loads at the account's first login, or the host's administrator turns it into a
      #    per-user LaunchDaemon) and the checks that need a running relay below are skipped.
      GUI_SESSION=1; launchctl print "gui/$(id -u)" >/dev/null 2>&1 || GUI_SESSION=0
      if launchctl print "gui/$(id -u)/$RELAY_LABEL" >/dev/null 2>&1; then ok "relay LaunchAgent present"
      elif [ "$GUI_SESSION" = 1 ]; then run_in "$PLUG" pnpm relay:install --cwd "$CK" --listen "127.0.0.1:$RELAY_PORT" --backend "127.0.0.1:$PROXY_PORT" --dsh "127.0.0.1:$WEB_PORT" --start "$START" || die "relay:install failed"
      else run_in "$PLUG" pnpm relay:install --no-load --cwd "$CK" --listen "127.0.0.1:$RELAY_PORT" --backend "127.0.0.1:$PROXY_PORT" --dsh "127.0.0.1:$WEB_PORT" --start "$START" || die "relay:install failed"
           todo "no GUI login session for $USER: the relay LaunchAgent is written but not running — log this account in once, or (shared machine) have the administrator convert it to a LaunchDaemon"; fi
      # 3. Enable the route: the plugin republishes `tailscale serve … --set-path /dsh` on every boot from this state file.
      STATE="$DSH_HOME_DIR/tailscale-remote.json"
      if [ "$DRY" = 1 ]; then log "would write $STATE (enabled: true) and start the relay"
      else
        SELF_LOGIN="$(ts_login)"
        node - "$STATE" "$SELF_LOGIN,$ALLOW" <<'JS'
const fs = require('fs'); const [file, logins] = process.argv.slice(2);
let s = {}; try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
s.version = 1; s.enabled = true;
const before = JSON.stringify(s.allowedUsers ?? []);
s.allowedUsers = [...new Set([...(s.allowedUsers ?? []), ...logins.split(/[\s,;]+/).filter(Boolean).map(u => u.toLowerCase())])];
if (JSON.stringify(s.allowedUsers) !== before) fs.writeFileSync(file + '.changed', '');
if (!/^[A-Za-z0-9_-]{16,}$/.test(s.token ?? '')) s.token = require('crypto').randomBytes(24).toString('base64url');
fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 }); fs.chmodSync(file, 0o600);
console.log('    tailscale-remote.json: enabled, allowed users ' + JSON.stringify(s.allowedUsers));
JS
        # The plugin reads the state file at boot: if our dsh is already up and the allowlist changed, restart it.
        if [ -e "$STATE.changed" ]; then rm -f "$STATE.changed"; lsof -ti tcp:"$WEB_PORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true; sleep 2; fi
        if [ "$GUI_SESSION" = 1 ]; then
          launchctl kickstart -k "gui/$(id -u)/$RELAY_LABEL" 2>/dev/null || true
          log "poking the relay (starts dsh web; ~10 s on a cold start)"
          curl -s -o /dev/null --max-time 5 "http://127.0.0.1:$RELAY_PORT/" || true
          wait_http "http://127.0.0.1:$RELAY_PORT/" 401 120 || die "DSH did not come up behind the relay (logs: $DSH_HOME_DIR/logs/{relay,dsh-web}.log)"
          ok "dsh web is up behind the relay (:$RELAY_PORT → :$PROXY_PORT → :$WEB_PORT)"
          for _ in $(seq 1 30); do "$TS" serve status 2>/dev/null | grep -q "$MOUNT " && break; sleep 1; done
          "$TS" serve status 2>/dev/null | grep -q "$MOUNT " && ok "tailscale serve publishes $MOUNT" || warn "no $MOUNT in tailscale serve status yet (MagicDNS + HTTPS certs must be enabled on the tailnet; see Settings → Tailscale remote)"
        else
          log "relay not started (no GUI session): the route $MOUNT is published by the plugin when dsh web first runs"
        fi
      fi
      # 4. Dock app (needs swiftc). Rebuilt on --replace: a deploy-remote.sh app points its fallback at the proxy, ours at the relay.
      DOCK_URL_ARGS=(--name "$DOCK_NAME" --fallback "http://127.0.0.1:$RELAY_PORT/")
      [ "$MOUNT" = /dsh ] || { dns="$(ts_dns)"; [ -z "$dns" ] || DOCK_URL_ARGS+=(--url "https://$dns$MOUNT/"); }
      if [ -d "$HOME/Applications/$DOCK_NAME.app" ] && [ "$REPLACE" = 0 ]; then ok "Dock app present: ~/Applications/$DOCK_NAME.app"
      elif xcrun --find swiftc >/dev/null 2>&1; then
        run_in "$PLUG" pnpm dock-app:install "${DOCK_URL_ARGS[@]}" || warn "Dock app install failed (Settings → Tailscale remote → Install Dock app works too)"
      else todo "install the Command Line Tools, then: cd $PLUG && pnpm dock-app:install ${DOCK_URL_ARGS[*]}"; fi
  }
fi

# ===========================================================================
# Thin client: a second, BLUE Dock app "DSH <Host>" that opens a DSH running on another Mac of the tailnet
# (e.g. your instance on the shared server, mounted there at /dsh/<user>) — no relay, no token, admitted by
# this node's Tailscale identity. `pnpm remote-app HOST/dsh/USER` (dsh-tailscale-remote's dock-app:remote);
# needs only node + swiftc + a connected Tailscale, all guaranteed by the steps above. Same thing the sister
# script tools/bootstrap-mac-thin-client.sh does on its own, without the fork and the plugin builds.
if wants thin-client; then
  banner "Thin client: a Dock app for a DSH on another Mac (optional)"
  if [ -z "$THIN_HOST" ]; then
    ask THIN_HOST "Tailnet host name of a Mac whose DSH you also want a Dock app for (e.g. hub; empty = skip)" ""
  fi
  THIN_HOST="$(printf '%s' "$THIN_HOST" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  if [ -z "$THIN_HOST" ]; then log "skipped (no host given)"
  else
    if [ -z "$THIN_USER" ]; then
      default_user="$(ts_login | cut -d@ -f1 | tr '[:upper:]' '[:lower:]')"
      ask THIN_USER "Your instance on $THIN_HOST (its DSH is mounted at /dsh/<user>)" "${default_user:-$USER}"
    fi
    THIN_USER="$(printf '%s' "$THIN_USER" | tr -d '[:space:]')"
    [ -n "$THIN_USER" ] || die "--thin-client needs a user (the instance on $THIN_HOST)"
    if [ "$DRY" = 0 ] && ! ts_ready; then die "Tailscale is not connected (state: $(ts_state)) — the thin client is admitted by its identity"; fi
    if [ "$DRY" = 1 ]; then log "would run: pnpm remote-app $THIN_HOST/dsh/$THIN_USER  (in $DIR)"
    elif ! xcrun --find swiftc >/dev/null 2>&1; then todo "install the Command Line Tools, then: cd $DIR && pnpm remote-app $THIN_HOST/dsh/$THIN_USER"
    else
      run_in "$DIR" pnpm remote-app "$THIN_HOST/dsh/$THIN_USER" || die "thin-client Dock app build failed (pnpm remote-app $THIN_HOST/dsh/$THIN_USER)"
      # Same default name dock-app:remote uses: "DSH " + the host's first label title-cased on -/_ (hub → DSH Hub).
      THIN_APP="$HOME/Applications/DSH $(printf '%s' "${THIN_HOST%%.*}" | tr '_-' '  ' | awk '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) substr($i,2)}1').app"
      [ -d "$THIN_APP" ] && ok "thin client installed: $THIN_APP → https://$THIN_HOST…/dsh/$THIN_USER/ (rebuild any time: cd $DIR && pnpm remote-app $THIN_HOST/dsh/$THIN_USER)" \
        || warn "pnpm remote-app succeeded but $THIN_APP is not there — check its output above"
    fi
  fi
fi

# ===========================================================================
if wants verify; then
  banner "Verification"
  if [ "$DRY" = 0 ]; then
    for u in "http://127.0.0.1:$WEB_PORT/" "http://127.0.0.1:$RELAY_PORT/"; do
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$u" || true)"
      case "$code" in 401) ok "$u → 401 (alive, auth wall)" ;; 000) warn "$u → nothing listening" ;; *) warn "$u → HTTP $code" ;; esac
    done
    n="$(cd "$CK" && pnpm dsh --profile web --dump-config 2>/dev/null | grep -cE '^- id: tali-' || true)"
    # Every live bundle inserts one `tali-` row: count the plugins that have a bundle patch, minus the app-gated ones.
    # The truth is install-plugins.sh's list minus what this run left out (--without, paid-app gating).
    expected=0
    for p in $(sed -n '/^PLUGINS=(/,/^)/p' "$DIR/tools/install-plugins.sh" | grep -E '^\s+[a-z0-9-]+$' | tr -d ' '); do
      excluded "$p" && continue
      case ",${USER_WITHOUT:-}," in *",$p,"*) continue ;; esac
      expected=$((expected+1))
    done
    [ "${n:-0}" -ge "$expected" ] && ok "$n tali- rows composed in the web profile" || warn "only ${n:-0} tali- rows composed (expected ≥ $expected)"
    if [ -x "$TS" ]; then
      DNS="$("$TS" status --self --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).Self.DNSName.replace(/\.$/,""))}catch{}})' 2>/dev/null || true)"
      if [ -n "$DNS" ]; then
        code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$DNS$MOUNT/" || true)"
        case "$code" in 200|303) ok "https://$DNS$MOUNT/ → $code (admitted by identity)" ;; 401) ok "https://$DNS$MOUNT/ → 401 (route live; you are not on the allowlist from here)" ;; *) warn "https://$DNS$MOUNT/ → ${code:-000} (cert issuance can take a few seconds on the first hit)" ;; esac
      fi
    fi
    TOKEN_URL="$(grep -o "http://127.0.0.1:$WEB_PORT/?token=[^ ]*" "$DSH_HOME_DIR/logs/dsh-web.log" 2>/dev/null | tail -1 || true)"
    [ -n "$TOKEN_URL" ] && log "GUI (local, tokened): $TOKEN_URL"
    [ -n "${DNS:-}" ] && log "GUI (tailnet): https://$DNS$MOUNT/"
  fi
  echo
  if [ ${#TODO[@]} -gt 0 ]; then
    printf '%sStill to do by hand:%s\n' "$BOLD" "$NC"
    for t in "${TODO[@]}"; do printf '  • %s\n' "$t"; done
  fi
  printf '\n%sDone.%s checkout: %s · home: %s · log: %s\n' "$GREEN" "$NC" "$DIR" "$DSH_HOME_DIR" "$LOG"
  echo "Day-to-day: cd $CK && pnpm dsh web --port $WEB_PORT   (or just open the $DOCK_NAME Dock app / the relay: http://127.0.0.1:$RELAY_PORT/)"
fi

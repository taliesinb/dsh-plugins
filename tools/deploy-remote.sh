#!/usr/bin/env bash
#
# deploy-remote.sh — build the DSH fork locally, ship it to a macOS host over
# ssh, and (re)start it there as a user LaunchAgent publishing the GUI on the
# tailnet through dsh-tailscale-remote.
#
#   pnpm deploy-remote [user@host] [--no-build] [--credentials] [--port N]
#   pnpm remote-logs   [user@host]
#   pnpm remote-status [user@host]
#
# Why ship node_modules instead of building on the host: the host is the same
# platform/arch (darwin-arm64), so the locally built checkout — native addons
# included — runs unchanged; the host only needs the *same* Node version, which
# this script installs from nodejs.org into ~/.local/node (no sudo, no brew).
# Why launchd, not tmux: KeepAlive restarts a crashed server, RunAtLoad starts
# it at login, logs go to a file; nothing to install.
#
# Idempotent: every run re-syncs and restarts; first-run steps (Node, DSH home,
# tailscale-remote state with a fresh standing token, credentials) happen only
# when missing. The standing token is kept across deploys so the local
# dsh-remote-workspaces registry keeps working.
set -euo pipefail

TARGET=""
BUILD=1
CREDENTIALS=0
PORT="${DSH_REMOTE_PORT:-3080}"
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --credentials) CREDENTIALS=1 ;;
    --port=*) PORT="${arg#--port=}" ;;
    --help|-h) sed -n '2,20p' "$0"; exit 0 ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) TARGET="$arg" ;;
  esac
done
TARGET="${TARGET:-${DSH_REMOTE_TARGET:-alpha@192.168.0.42}}"

HERE="$(cd "$(dirname "$0")/.." && pwd)"                       # tali-dash-plugins
CHECKOUT="${DSH_CHECKOUT:-$HOME/github/deepseek-harness-embed}"  # the fork worktree on feat/embed-session
PLUGIN_SRC="$HERE/plugins/dsh-tailscale-remote"
LABEL="ai.symbolica.dsh-remote"
NODE_VERSION="$(node --version)"                               # pin the host to the local runtime
ALLOWED_USERS="${DSH_REMOTE_ALLOWED_USERS:-}"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 "$TARGET")
# Apple's /usr/bin/rsync is openrsync (protocol 29) and stalls indefinitely on an
# 85k-file listing from a modern rsync; the host gets Homebrew rsync instead.
REMOTE_RSYNC=/opt/homebrew/bin/rsync
RSYNC=(rsync --rsync-path="$REMOTE_RSYNC")

log() { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✖\033[0m %s\n' "$*" >&2; exit 1; }

[ -d "$CHECKOUT/apps/cli" ] || die "checkout not found: $CHECKOUT (set DSH_CHECKOUT)"
[ -f "$PLUGIN_SRC/index.js" ] || die "plugin not found: $PLUGIN_SRC"
command -v rsync >/dev/null || die "rsync is required locally"

# Tailnet login used by the remote's allowlist: this machine's, unless overridden.
if [ -z "$ALLOWED_USERS" ] && command -v tailscale >/dev/null; then
  ALLOWED_USERS="$(tailscale whois --json "$(tailscale ip -4 | head -1)" 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["UserProfile"]["LoginName"])' 2>/dev/null || true)"
fi
[ -n "$ALLOWED_USERS" ] || log "warning: could not determine your tailnet login; set DSH_REMOTE_ALLOWED_USERS=you@example.com (the remote will otherwise require its token)"

# ---------------------------------------------------------------------------
log "target $TARGET · checkout $CHECKOUT · node $NODE_VERSION"
"${SSH[@]}" 'true' || die "cannot ssh to $TARGET (key auth required)"
REMOTE_ARCH="$("${SSH[@]}" 'uname -sm')"
[ "$REMOTE_ARCH" = "$(uname -sm)" ] || die "host is $REMOTE_ARCH, local is $(uname -sm): shipping node_modules needs the same platform"
REMOTE_HOME="$("${SSH[@]}" 'printf %s "$HOME"')"
REMOTE_UID="$("${SSH[@]}" 'id -u')"
"${SSH[@]}" "test -x $REMOTE_RSYNC" || { log "installing rsync on the host (brew)"; "${SSH[@]}" 'zsh -lc "brew install rsync"' >/dev/null || die "brew install rsync failed on $TARGET"; }

# ---------------------------------------------------------------------------
if [ "$BUILD" = 1 ]; then
  log "building the fork ($CHECKOUT)"
  (cd "$CHECKOUT" && pnpm run build >/tmp/dsh-deploy-build.log 2>&1) || { tail -30 /tmp/dsh-deploy-build.log; die "build failed (log: /tmp/dsh-deploy-build.log)"; }
  log "building dsh-tailscale-remote client"
  (cd "$PLUGIN_SRC" && node build.mjs >/dev/null 2>&1) || die "plugin build failed"
fi
[ -f "$CHECKOUT/apps/cli/lib/bin.js" ] || die "no built CLI at $CHECKOUT/apps/cli/lib/bin.js — run without --no-build"
[ -f "$PLUGIN_SRC/lib/client.js" ] || die "no built plugin client — run without --no-build"

# ---------------------------------------------------------------------------
log "ensuring Node $NODE_VERSION on the host"
"${SSH[@]}" bash -s -- "$NODE_VERSION" <<'REMOTE'
set -euo pipefail
V="$1"; ARCH="$(uname -m)"; [ "$ARCH" = arm64 ] && NARCH=arm64 || NARCH=x64
mkdir -p "$HOME/.local" "$HOME/dsh/checkout" "$HOME/dsh/plugins" "$HOME/dsh/logs" "$HOME/.dsh/deploy"
if [ ! -x "$HOME/.local/node/bin/node" ] || [ "$("$HOME/.local/node/bin/node" --version)" != "$V" ]; then
  echo "  installing node $V (darwin-$NARCH) into ~/.local/node"
  curl -fsSL "https://nodejs.org/dist/$V/node-$V-darwin-$NARCH.tar.gz" -o /tmp/node.tgz
  rm -rf "$HOME/.local/node" "$HOME/.local/node-$V-darwin-$NARCH"
  tar -xzf /tmp/node.tgz -C "$HOME/.local"
  mv "$HOME/.local/node-$V-darwin-$NARCH" "$HOME/.local/node"
  rm -f /tmp/node.tgz
fi
echo "  node: $("$HOME/.local/node/bin/node" --version)"
REMOTE

# ---------------------------------------------------------------------------
log "syncing the checkout (built artifacts + node_modules; pnpm symlinks are relative)"
"${RSYNC[@]}" -a --delete --delete-excluded --stats \
  --exclude '.git' --exclude 'website' --exclude 'snapshots' --exclude 'python' --exclude '.agents' \
  --exclude 'coverage' --exclude '.turbo' \
  "$CHECKOUT/" "$TARGET:dsh/checkout/" | grep -E 'files transferred|Total transferred|deleted' | sed 's/^/  /'

log "syncing dsh-tailscale-remote (runtime files; deps resolved against the synced checkout)"
"${RSYNC[@]}" -a --delete --stats \
  --exclude 'node_modules' --exclude 'src' --exclude 'tests' --exclude 'lib/client.js.map' \
  "$PLUGIN_SRC/" "$TARGET:dsh/plugins/dsh-tailscale-remote/" | grep -E 'files transferred' | sed 's/^/  /'
"${SSH[@]}" 'mkdir -p dsh/plugins/dsh-tailscale-remote/node_modules'
"${RSYNC[@]}" -aL --delete "$PLUGIN_SRC/node_modules/uqr/" "$TARGET:dsh/plugins/dsh-tailscale-remote/node_modules/uqr/"

# Local-model plugins (plain ESM, node: imports only) and the user preset the
# Apple route relies on: the supervisor starts `afm --port 9997` on first use
# of the `apple` provider (afm must be installed on the host: `brew install
# scouzi1966/afm/afm`), enforce-model-preset switches blank sessions on that
# provider to the tool-less preset so a 4K on-device model gets a usable window.
log "syncing local-model-supervisor, enforce-model-preset, minimal-no-tools preset"
for P in local-model-supervisor enforce-model-preset; do
  "${RSYNC[@]}" -a --delete --stats --exclude 'node_modules' "$HERE/plugins/$P/" "$TARGET:dsh/plugins/$P/" | grep -E 'files transferred' | sed "s/^/  $P: /"
done
"${SSH[@]}" 'mkdir -p ~/.dsh/.agent-presets'
"${RSYNC[@]}" -a --delete --stats "$HOME/.dsh/.agent-presets/minimal-no-tools/" "$TARGET:.dsh/.agent-presets/minimal-no-tools/" | grep -E 'files transferred' | sed 's/^/  preset: /'

# ---------------------------------------------------------------------------
log "configuring DSH home, tailscale-remote state, LaunchAgent"
if [ "$CREDENTIALS" = 1 ] || ! "${SSH[@]}" "test -f ~/.dsh/.credentials.yaml"; then
  [ -f "$HOME/.dsh/.credentials.yaml" ] && { "${RSYNC[@]}" -a "$HOME/.dsh/.credentials.yaml" "$TARGET:.dsh/.credentials.yaml"; log "  copied .credentials.yaml"; }
fi
if [ "$CREDENTIALS" = 1 ] || ! "${SSH[@]}" "test -f ~/.dsh/settings.yaml"; then
  [ -f "$HOME/.dsh/settings.yaml" ] && { "${RSYNC[@]}" -a "$HOME/.dsh/settings.yaml" "$TARGET:.dsh/settings.yaml"; log "  copied settings.yaml"; }
fi

"${SSH[@]}" bash -s -- "$LABEL" "$PORT" "$ALLOWED_USERS" "$REMOTE_UID" <<'REMOTE'
set -euo pipefail
LABEL="$1"; PORT="$2"; USERS="$3"; UID_="$4"
NODE="$HOME/.local/node/bin/node"
PLUGIN="$HOME/dsh/plugins/dsh-tailscale-remote"

# The plugin's only workspace-linked dependency resolves against the synced checkout.
mkdir -p "$PLUGIN/node_modules/@deepseek-ai"
ln -sfn "$HOME/dsh/checkout/vendor/schemastery" "$PLUGIN/node_modules/@deepseek-ai/schemastery"

# Overlay applied on top of the shipped web profile: just the Tailscale remote.
cat > "$HOME/.dsh/deploy/remote.cordis.yml" <<YML
# Managed by tali-dash-plugins/tools/deploy-remote.sh — edits are overwritten.
- insert:
    - id: tali-tailscale-remote
      name: '$PLUGIN/index.js'
      config:
        tailscalePath: /Applications/Tailscale.app/Contents/MacOS/Tailscale
        # Publish the proxy listener itself (no relay LaunchAgent to manage on
        # a headless host): the plugin re-points \`tailscale serve\` at its own
        # port on every boot, so a DSH restart never leaves Serve at a dead port.
        publishPort: 0
    - id: tali-enforce-model-preset
      name: '$HOME/dsh/plugins/enforce-model-preset/index.js'
      config:
        rules:
          - provider: apple
            preset: minimal-no-tools
          - provider: '*'
            preset: standard
    - id: tali-local-model-supervisor
      name: '$HOME/dsh/plugins/local-model-supervisor/index.js'
      config:
        servers:
          - id: afm
            providers: [apple]
            command: afm
            args: ['--port', '9997']
            healthUrl: http://127.0.0.1:9997/v1/models
            idleMinutes: 15
            startupTimeoutMs: 90000
            logFile: $HOME/dsh/logs/afm.log
YML

# Standing token + allowlist: created once, kept across deploys (the local
# remote-workspaces registry stores this token).
STATE="$HOME/.dsh/tailscale-remote.json"
if [ ! -f "$STATE" ]; then
  TOKEN="$("$NODE" -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))')"
  USERS_JSON="$("$NODE" -e 'process.stdout.write(JSON.stringify(process.argv[1].split(/[\s,;]+/).filter(Boolean).map(s=>s.toLowerCase())))' "$USERS")"
  umask 077
  printf '{\n  "version": 1,\n  "enabled": true,\n  "allowedUsers": %s,\n  "token": "%s"\n}\n' "$USERS_JSON" "$TOKEN" > "$STATE"
  echo "  created tailscale-remote state (allowed: $USERS_JSON)"
elif [ -n "$USERS" ]; then
  # Keep the allowlist in step with the deployer's login without touching the token.
  "$NODE" -e '
    const fs=require("fs"); const [file, users]=process.argv.slice(1);
    const s=JSON.parse(fs.readFileSync(file,"utf8")); s.enabled=true;
    const want=users.split(/[\s,;]+/).filter(Boolean).map(u=>u.toLowerCase());
    s.allowedUsers=[...new Set([...(s.allowedUsers??[]), ...want])];
    fs.writeFileSync(file, JSON.stringify(s,null,2)+"\n", {mode:0o600});' "$STATE" "$USERS"
fi

PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <!-- Through a login shell on purpose: the macOS Tailscale CLI refuses to talk
       to the GUI app from a bare launchd environment ("The Tailscale GUI failed
       to start") but works from a shell (SHLVL set); the login shell also brings
       the user's real PATH (Homebrew) for tools the agent runs. -->
  <key>ProgramArguments</key><array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>exec "$NODE" "$HOME/dsh/checkout/apps/cli/lib/bin.js" --profile web --patch "$HOME/.dsh/deploy/remote.cordis.yml" --port $PORT --no-open</string>
  </array>
  <key>WorkingDirectory</key><string>$HOME</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
    <key>DSH_HOME</key><string>$HOME/.dsh</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$HOME/dsh/logs/dsh.log</string>
  <key>StandardErrorPath</key><string>$HOME/dsh/logs/dsh.log</string>
</dict></plist>
PL

# Restart: bootout is a no-op when not loaded; bootstrap loads + starts (RunAtLoad).
launchctl bootout "gui/$UID_/$LABEL" 2>/dev/null || true
sleep 1
launchctl bootstrap "gui/$UID_" "$PLIST"
echo "  LaunchAgent $LABEL (re)started; log: ~/dsh/logs/dsh.log"

# Health: the shell answers 401 to an anonymous root request once it listens.
for i in $(seq 1 40); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)"
  [ "$code" = "401" ] && break
  sleep 1
done
[ "$code" = "401" ] || { echo "  server did not come up (last HTTP $code); tail of log:"; tail -20 "$HOME/dsh/logs/dsh.log"; exit 1; }
echo "  DSH listening on 127.0.0.1:$PORT"
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale

# Dock app for the host's own user (WKWebView wrapper, built with the host's
# Swift toolchain by the plugin itself): (re)install so it tracks this build,
# and allowlist the host's own tailnet login so the app is admitted by
# identity too. Control actions are accepted on DSH's own port only, with the
# launch-token cookie from the log.
if xcrun --find swiftc >/dev/null 2>&1; then
  LAUNCH="$(grep -o 'token=[^ ]*' "$HOME/dsh/logs/dsh.log" | tail -1)"
  CJ="$(mktemp)"
  curl -s -c "$CJ" -o /dev/null "http://127.0.0.1:$PORT/?$LAUNCH"
  ctl() { curl -s -b "$CJ" -H 'content-type: application/json' -H "origin: http://127.0.0.1:$PORT" \
    --data "{\"type\":\"client-request\",\"rpcId\":\"deploy\",\"method\":\"$1\",\"payload\":{\"args\":$2}}" "http://127.0.0.1:$PORT/tailscale-remote/$1"; }
  SELF_LOGIN="$("$TS" status --self --json 2>/dev/null | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const u=j.User?.[j.Self.UserID];process.stdout.write(u?.LoginName??"")})')"
  USERS="$("$NODE" -e 'const st=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const set=new Set(st.allowedUsers);if(process.argv[2])set.add(process.argv[2]);process.stdout.write([...set].join(", "))' "$STATE" "$SELF_LOGIN")"
  ctl set-users "{\"allowedUsers\":\"$USERS\"}" >/dev/null && echo "  allowed users: $USERS"
  if ctl install-dock-app '{}' | grep -q '"ok":true'; then echo "  Dock app: ~/Applications/DSH.app (re)installed and launched"; else echo "  Dock app: install failed (see ~/dsh/logs/dsh.log)"; fi
  rm -f "$CJ"
else
  echo "  Dock app: skipped (no Swift toolchain: xcode-select --install)"
fi

# The plugin republishes the route on boot; give it a moment, then report.
for i in $(seq 1 20); do "$TS" serve status 2>/dev/null | grep -q '/dsh' && break; sleep 1; done
DNS="$("$TS" status --self --json 2>/dev/null | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(JSON.parse(s).Self.DNSName.replace(/\.$/,""))})')"
TOKEN="$("$NODE" -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).token)' "$STATE")"
echo
echo "  remote GUI:   https://$DNS/dsh/"
echo "  token link:   https://$DNS/dsh/?token=$TOKEN"
"$TS" serve status 2>/dev/null | sed 's/^/  serve: /' || echo "  serve: (tailscale serve status unavailable)"
REMOTE

# ---------------------------------------------------------------------------
DNS="$("${SSH[@]}" '/Applications/Tailscale.app/Contents/MacOS/Tailscale status --self --json 2>/dev/null' | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"
if [ -n "$DNS" ]; then
  log "checking https://$DNS/dsh/ from here (tailnet identity)"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$DNS/dsh/" || true)"
  case "$code" in
    200|303) log "  ok (HTTP $code) — this machine is admitted by identity" ;;
    401) log "  HTTP 401: not on the remote's allowed list; use the token link above (or set DSH_REMOTE_ALLOWED_USERS)" ;;
    *) log "  HTTP ${code:-000}: the tailnet route may still be settling; retry in a few seconds" ;;
  esac
fi
log "done"

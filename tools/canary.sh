#!/usr/bin/env bash
# canary.sh — a separate, disposable DSH instance for testing the plugins of
# THIS branch, labelled "DSH <branch> <commit>" so its window is never mistaken
# for the live one.
#
#   pnpm canary                      # start (or restart) this branch's canary; opens its Dock app
#   pnpm canary --plugin fs-tools    # also load a plugin that did not change on the branch
#   pnpm canary stop                 # stop this branch's canary (its Dock app quits)
#   pnpm canary stop --all           # stop every canary
#   pnpm canary remove               # stop + delete this branch's home and Dock app
#   pnpm canary list                 # every canary: branch, commit, port, pid, url
#   pnpm canary logs                 # tail this branch's dsh log
#   pnpm canary url                  # print the tokened URL again
#
# Options for start:
#   --plugin NAME      load plugins/NAME too (repeatable)
#   --only             ignore the branch diff; load only the --plugin ones
#   --port N           fixed port (default: first free from 3091)
#   --no-credentials   do not copy ~/.dsh/settings.yaml + .credentials.yaml
#   --no-app           no Dock app: open the tokened URL in the default browser instead
#   --no-open          neither launch the Dock app nor open a browser
#   --no-build         do not (re)build the plugins' lib/client.js
#   --browser-picker   in-browser directory picker (SSH_TTY trick) instead of the native one
#   --fresh            wipe this branch's canary home first (sessions, workspaces)
#
# WHAT IT DOES
#   1. Plugins = the plugins/<dir> touched on this branch relative to
#      origin/main (committed and uncommitted), plus --plugin; infrastructure
#      plugins (INFRA_PLUGINS below) are skipped unless forced.
#   2. For each: `pnpm install --ignore-scripts` if node_modules is missing,
#      then `pnpm build` when there is a build script (skipped with --no-build).
#      WARNING: from the MAIN checkout this rebuilds bundles the live server
#      may serve (install-plugins pnpm-links the plugin directories) → the live
#      GUI hot-swaps. Run canaries from a worktree (.worktrees/<name>).
#   3. Writes <root>/<branch>/overlay.yml: one absolute-path row per plugin +
#      an instance-identity row (label "DSH <branch> <commit>", red whale).
#   4. Home <root>/<branch>/home with the live settings.yaml + .credentials.yaml
#      copied in (snapshots; mode 600) so real turns work.
#   5. Launches `node --import tsx/esm apps/cli/src/bin.ts --profile web
#      --patch overlay.yml --port N --no-open` from the checkout (not `pnpm
#      dsh`: pnpm 12's packageManager temp dir fails under the sandbox),
#      detached, log in <root>/<branch>/dsh.log; the token goes to
#      <root>/<branch>/token.json.
#   6. Installs ~/Applications/DSH <branch> <commit>.app — the
#      dsh-tailscale-remote WKWebView wrapper (red whale icon) pointed at the
#      loopback URL, reading the token from token.json on every connect
#      (`dock-app:local`), so a restarted canary with a new token reconnects
#      on the app's own retry or ⌘R. One app per branch: a new commit retires
#      the previous commit's app. The wrapper is rebuilt only when its Swift
#      sources changed. Writing into ~/Applications needs an unsandboxed
#      shell; under the DSH sandbox the install step fails and the tool falls
#      back to the browser.
#
#   <root> = $DSH_CANARY_ROOT, default /tmp/dsh-canary (evaporates on reboot —
#   a canary is throwaway by design; nothing in ~/.dsh is touched).
#   The home is keyed by BRANCH so your test sessions survive new commits; the
#   label carries the commit (and "-dirty" when the tree has changes).
set -euo pipefail

ROOT="${DSH_CANARY_ROOT:-/tmp/dsh-canary}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
IDENTITY_PLUGIN="instance-identity"
# Infrastructure plugins never auto-loaded from the branch diff: they publish
# routes, supervise local model servers or rewrite identity, and their
# defaults are wrong for a throwaway instance. `--plugin NAME` still forces one.
INFRA_PLUGINS="dsh-tailscale-remote local-model-supervisor enforce-model-preset instance-identity app-lifeline reload-on-restart"
BRAND_COLOR='#E5484D'
DOCK_CLI="$HERE/plugins/dsh-tailscale-remote/scripts/cli.mjs"
BASE_PORT=3091

die() { printf '✗ %s\n' "$*" >&2; exit 1; }
note() { printf '▸ %s\n' "$*"; }

branch_slug() {
  local b
  b="$(git -C "$HERE" rev-parse --abbrev-ref HEAD 2>/dev/null || echo detached)"
  printf '%s' "$b" | tr '/' '-' | tr -c 'A-Za-z0-9._-\n' '-'
}

is_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

read_pid() { [ -f "$1/pid" ] && cat "$1/pid" || true; }

free_port() {
  local p="$BASE_PORT"
  while lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; do p=$((p + 1)); done
  printf '%s' "$p"
}

show_one() {
  local dir="$1" pid state
  pid="$(read_pid "$dir")"
  if is_alive "$pid"; then state="running pid $pid"; else state="stopped"; fi
  printf '%-28s %-8s %-6s %-18s %s\n' "$(basename "$dir")" "$(cat "$dir/commit" 2>/dev/null || echo -)" "$(cat "$dir/port" 2>/dev/null || echo -)" "$state" "$(cat "$dir/url" 2>/dev/null || echo -)"
}

cmd_list() {
  [ -d "$ROOT" ] || { note "no canaries under $ROOT"; return; }
  printf '%-28s %-8s %-6s %-18s %s\n' BRANCH COMMIT PORT STATE URL
  for dir in "$ROOT"/*/; do [ -d "$dir" ] && show_one "${dir%/}"; done
}

stop_dir() {
  local dir="$1" pid
  pid="$(read_pid "$dir")"
  if is_alive "$pid"; then
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do is_alive "$pid" || break; sleep 0.5; done
    is_alive "$pid" && kill -9 "$pid" 2>/dev/null || true
    note "stopped $(basename "$dir") (pid $pid)"
  else
    note "$(basename "$dir") was not running"
  fi
  rm -f "$dir/pid"
  # The Dock app would only show its offline page (and keep retrying). SIGTERM
  # by bundle path: an Apple-events `quit` is refused from a sandboxed shell.
  local app
  app="$(cat "$dir/app" 2>/dev/null || true)"
  [ -n "$app" ] && pkill -f "Applications/$app.app/Contents/MacOS/" 2>/dev/null || true
}

cmd_remove() {
  local dir="$ROOT/$(branch_slug)" app
  [ -d "$dir" ] || die "no canary for this branch"
  stop_dir "$dir"
  app="$(cat "$dir/app" 2>/dev/null || true)"
  [ -n "$app" ] && node "$DOCK_CLI" dock-app:uninstall --name "$app" >/dev/null 2>&1 || true
  rm -rf "$dir"
  note "removed $dir${app:+ and ~/Applications/$app.app}"
}

cmd_stop() {
  if [ "${1:-}" = "--all" ]; then
    for dir in "$ROOT"/*/; do [ -d "$dir" ] && stop_dir "${dir%/}"; done
  else
    stop_dir "$ROOT/$(branch_slug)"
  fi
}

cmd_logs() { exec tail -n 80 -f "$ROOT/$(branch_slug)/dsh.log"; }
cmd_url() { cat "$ROOT/$(branch_slug)/url" 2>/dev/null || die "no canary for this branch — pnpm canary"; }

# Plugins touched on this branch vs origin/main (committed + working tree).
changed_plugins() {
  local base
  base="$(git -C "$HERE" merge-base origin/main HEAD 2>/dev/null || true)"
  {
    [ -n "$base" ] && git -C "$HERE" diff --name-only "$base"..HEAD -- plugins/ || true
    git -C "$HERE" status --porcelain --untracked-files=all -- plugins/ | awk '{print $NF}'
  } | awk -F/ '$1=="plugins" && NF>2 {print $2}' | sort -u
}

cmd_start() {
  local plugins=() only=0 port="" creds=1 open=1 app=1 build=1 picker=0 fresh=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --plugin) plugins+=("$2"); shift 2 ;;
      --plugin=*) plugins+=("${1#--plugin=}"); shift ;;
      --only) only=1; shift ;;
      --port) port="$2"; shift 2 ;;
      --port=*) port="${1#--port=}"; shift ;;
      --no-credentials) creds=0; shift ;;
      --no-open) open=0; shift ;;
      --no-app) app=0; shift ;;
      --no-build) build=0; shift ;;
      --browser-picker) picker=1; shift ;;
      --fresh) fresh=1; shift ;;
      -h|--help) sed -n '2,55p' "$0"; exit 0 ;;
      *) die "unknown argument: $1 (see --help)" ;;
    esac
  done

  # The checkout the canary runs from: the submodule (or its symlink in a worktree).
  local dsh
  dsh="$(cd -P "$HERE/deepseek-harness" 2>/dev/null && pwd || true)"
  [ -n "$dsh" ] && [ -f "$dsh/apps/cli/src/bin.ts" ] \
    || die "deepseek-harness/ is not a checkout here — in a worktree: ln -s ../../deepseek-harness deepseek-harness"

  local slug commit dirty="" label dir
  slug="$(branch_slug)"
  commit="$(git -C "$HERE" rev-parse --short HEAD)"
  [ -z "$(git -C "$HERE" status --porcelain -- plugins/ tools/ cordis.dev.yml)" ] || dirty="-dirty"
  # instance-identity: 1-32 chars of [A-Za-z0-9 ._-]; "DSH " + slug + " " + commit(+"-dirty").
  local short="$slug"
  short="${short#feat-}"; short="${short#fix-}"; short="${short#chore-}"
  local budget=$((32 - 4 - 1 - ${#commit} - ${#dirty}))
  label="DSH ${short:0:$budget} ${commit}${dirty}"
  dir="$ROOT/$slug"

  case "$HERE" in */.worktrees/*) ;; *)
    note "WARNING: running from the main checkout — rebuilding a plugin here hot-swaps the LIVE GUI if that plugin is installed there. Prefer a worktree." ;;
  esac

  if [ $only -eq 0 ]; then
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      case " $INFRA_PLUGINS " in *" $p "*) note "skipping $p (infrastructure; pass --plugin $p to force)"; continue ;; esac
      plugins+=("$p")
    done < <(changed_plugins)
  fi
  [ ${#plugins[@]} -gt 0 ] || die "no plugin changed on this branch and no --plugin given"
  # de-duplicate, verify
  local uniq=() p seen=" "
  for p in "${plugins[@]}"; do
    case "$seen" in *" $p "*) continue ;; esac
    seen="$seen$p "
    [ -f "$HERE/plugins/$p/package.json" ] || die "plugins/$p has no package.json"
    [ "$p" = "$IDENTITY_PLUGIN" ] && die "$IDENTITY_PLUGIN is added by the canary itself; do not pass it"
    uniq+=("$p")
  done
  plugins=("${uniq[@]}")

  # Stop a previous canary of this branch; wipe if asked. Its Dock app is
  # named after the commit, so a new commit retires the old app.
  [ -d "$dir" ] && stop_dir "$dir" || true
  local previous_app
  previous_app="$(cat "$dir/app" 2>/dev/null || true)"
  if [ -n "$previous_app" ] && [ "$previous_app" != "$label" ]; then
    node "$DOCK_CLI" dock-app:uninstall --name "$previous_app" >/dev/null 2>&1 && note "retired ~/Applications/$previous_app.app" || true
    rm -f "$dir/app"
  fi
  if [ $fresh -eq 1 ] && [ -d "$dir" ]; then rm -rf "$dir"; note "wiped $dir"; fi
  mkdir -p "$dir/home" "$dir/scratch"

  # Build the plugins.
  for p in "${plugins[@]}"; do
    local pdir="$HERE/plugins/$p"
    if node -e "process.exit(require('$pdir/package.json').scripts?.build ? 0 : 1)"; then
      [ -d "$pdir/node_modules" ] || (cd "$pdir" && note "install $p" && pnpm install --ignore-scripts >/dev/null 2>&1)
      if [ $build -eq 1 ]; then (cd "$pdir" && note "build $p" && pnpm run build >/dev/null 2>&1); fi
      if node -e "const j=require('$pdir/package.json');process.exit(j.dsh?.client?0:1)" && [ ! -f "$pdir/lib/client.js" ]; then
        die "plugins/$p declares dsh.client but lib/client.js is missing (build it, or drop --no-build)"
      fi
    fi
  done

  # Overlay: absolute-path rows + the identity row.
  {
    printf '# generated by tools/canary.sh — %s\n- insert:\n' "$(date '+%Y-%m-%d %H:%M')"
    printf "    - id: canary-identity\n      name: '%s/plugins/%s/index.js'\n      config:\n        label: '%s'\n        brandColor: '%s'\n        dockLabel: '%s'\n" \
      "$HERE" "$IDENTITY_PLUGIN" "$label" "$BRAND_COLOR" "$label"
    for p in "${plugins[@]}"; do
      local entry
      entry="$(node -e "const j=require('$HERE/plugins/$p/package.json');console.log(j.main||'index.js')")"
      printf "    - id: tali-%s\n      name: '%s/plugins/%s/%s'\n" "$p" "$HERE" "$p" "$entry"
    done
  } > "$dir/overlay.yml"

  # Credentials + providers (snapshots).
  if [ $creds -eq 1 ]; then
    for f in settings.yaml .credentials.yaml; do
      [ -f "$HOME/.dsh/$f" ] && { cp "$HOME/.dsh/$f" "$dir/home/$f"; chmod 600 "$dir/home/$f"; }
    done
  fi

  [ -n "$port" ] || port="$(free_port)"
  printf '%s' "$commit$dirty" > "$dir/commit"
  printf '%s' "$port" > "$dir/port"
  rm -f "$dir/url"

  note "starting $label on :$port — plugins: ${plugins[*]}"
  local env_extra=()
  [ $picker -eq 1 ] && env_extra+=("SSH_TTY=/dev/canary")
  (
    cd "$dsh"
    env DSH_HOME="$dir/home" "${env_extra[@]+"${env_extra[@]}"}" \
      nohup node --import tsx/esm apps/cli/src/bin.ts --profile web \
        --patch "$dir/overlay.yml" --port "$port" --no-open \
        > "$dir/dsh.log" 2>&1 &
    echo $! > "$dir/pid"
  )

  local url="" i
  for i in $(seq 1 120); do
    url="$(grep -o 'dsh web: http://[^ ]*' "$dir/dsh.log" 2>/dev/null | head -1 | sed 's/^dsh web: //' || true)"
    [ -n "$url" ] && break
    is_alive "$(read_pid "$dir")" || { tail -n 30 "$dir/dsh.log" >&2; die "dsh web exited; log: $dir/dsh.log"; }
    sleep 0.5
  done
  [ -n "$url" ] || die "no URL after 60 s; log: $dir/dsh.log"
  printf '%s' "$url" > "$dir/url"
  local token
  token="${url#*token=}"
  printf '{"token":"%s"}\n' "$token" > "$dir/token.json"
  chmod 600 "$dir/token.json"
  note "$url"
  note "home $dir/home · scratch workspace $dir/scratch · log $dir/dsh.log"

  if [ $app -eq 1 ]; then
    # ~/Applications/<label>.app: the wrapper reads token.json on every
    # connect, so the app follows this branch's canary across restarts; the
    # wrapper's own name is what the wordmark shows, hence the full label.
    local appname="$label" launch=() current
    [ $open -eq 1 ] || launch=(--no-launch)
    # Same name, same URL → the bundle is already right (token.json is re-read
    # on connect): just relaunch it. Otherwise (re)install, which writes into
    # ~/Applications — refused under the DSH sandbox, hence the browser fallback.
    current="$(node "$DOCK_CLI" dock-app:status --name "$appname" --url "http://127.0.0.1:$port/" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).current===true?"yes":"no")}catch{console.log("no")}})')"
    if [ "$current" = "yes" ]; then
      printf '%s' "$appname" > "$dir/app"
      [ $open -eq 1 ] && open "$HOME/Applications/$appname.app" || true
      note "Dock app ~/Applications/$appname.app$([ $open -eq 1 ] && echo ' (relaunched)')"
    elif node "$DOCK_CLI" dock-app:local --name "$appname" --instance "canary-$slug" \
        --url "http://127.0.0.1:$port/" --token-file "$dir/token.json" \
        --glyph-color "$BRAND_COLOR" "${launch[@]+"${launch[@]}"}" >"$dir/dock-app.log" 2>&1; then
      printf '%s' "$appname" > "$dir/app"
      note "Dock app ~/Applications/$appname.app$([ $open -eq 1 ] && echo ' (launched)')"
    else
      grep -m1 -i "error\|EPERM" "$dir/dock-app.log" >&2 || tail -n 3 "$dir/dock-app.log" >&2
      note "Dock app install failed (see $dir/dock-app.log; a sandboxed shell cannot write ~/Applications — run pnpm canary from a terminal); opening the browser instead"
      [ $open -eq 1 ] && open "$url" || true
    fi
  else
    [ $open -eq 1 ] && open "$url" || true
  fi
}

case "${1:-start}" in
  start) shift || true; cmd_start "$@" ;;
  stop) shift || true; cmd_stop "$@" ;;
  list|ls) cmd_list ;;
  logs|log) cmd_logs ;;
  url) cmd_url ;;
  remove|rm) cmd_remove ;;
  -h|--help) sed -n '2,55p' "$0" ;;
  --*) cmd_start "$@" ;;
  *) die "unknown command: $1 (start|stop|remove|list|logs|url)" ;;
esac

# PREVIEWING.md — trialing plugins safely

> **VERY IMPORTANT: do not modify the user's live DSH configuration without
> explicit confirmation.** The live home is `~/.dsh`. Three tiers of risk,
> verified against the source checkout (`packages/boot/app-boot/src/profile.ts`,
> `docs/subsystems/client-modules.md`):
>
> 1. **Hot (applies the moment you save):** the `web` profile defaults to
>    `patchReload: 'live'`, so edits to `~/.dsh/cordis.patch.yml` (home level)
>    or `~/.dsh/profiles/<name>/cordis.patch.yml` reload the affected plugin
>    rows in the RUNNING server — including the client/server session YOU are
>    likely being run in, which can render it inoperative. (`headless`/`sdk`
>    profiles default to `patchReload: 'startup'`.)
> 2. **Hot for the browser:** the client-bundle HMR watcher is always mounted;
>    rebuilding the `lib/client.js` of a plugin that is installed in the live
>    profile hot-swaps it into the user's open GUI immediately. **`pnpm
>    install` in such a plugin counts as a rebuild**: every client plugin's
>    `prepare` script is `node build.mjs` (measured 2026-09-21 — adding a
>    devDependency to session-title-slug shipped its fixed bundle live
>    unasked). To edit source without shipping it, work in a copy of the
>    plugin under `/tmp` (see `recipes/session-title-slug-plugin.md`
>    §Post-rebase breakage) or add the dependency with `pnpm add --ignore-scripts`.
> 3. **Boot-time:** `dsh plugin add`/`remove` rewrites the profile manifest
>    and node_modules — composed at next launch, not live, but it still
>    changes what the user's DSH runs from then on (and the install itself
>    mutates the running profile's directory).
>
> (Module-source HMR — `@deepseek-ai/cordis-plugin-hmr` — ships disabled, so
> editing installed plugins' *source* files alone does not hot-reload.)
>
> Make none of these changes unless explicitly asked. If the user only
> *implies* it — e.g. asks you to "install" a plugin or fix a DSH bug — check
> first that they want the change applied to the live DSH they are using. The
> safe way to trial a plugin is the isolated preview server below; that
> requires no confirmation.

## The standing preview server (`~/.dsh-preview`, since 2026-09-17)

There is a permanent preview instance on this Mac, managed by a relay
LaunchAgent (`io.github.taliesinb.dsh-web-relay.preview`) that starts it on
demand and keeps it apart from the live one — own home, own ports, own Dock
app. Prefer it over ad-hoc servers for anything the user should also be able
to look at.

| | live | preview |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | `~/.dsh-preview` |
| `dsh web` port | 3080 | 3088 |
| composition | `~/.dsh/profiles/web/cordis.patch.yml` | `~/.dsh-preview/profiles/web/cordis.patch.yml` (standing rows: `tali-tailscale-remote`, `tali-local-model-supervisor`, `tali-enforce-model-preset`) **+ `cordis.dev.yml`** (the plugins under trial) |
| models | cloud providers per `~/.dsh/settings.yaml` | **local only, on purpose**: Apple Foundation (`apple/foundation`, default; `afm` on :9997 started on demand, `minimal-no-tools` preset) and LM Studio (:1234, `minimal` preset). No cloud keys — do not add any. |
| tailnet URL | `https://laptop.example.ts.net/dsh/` | `…/dsh-preview/` |
| relay → proxy | :3083 → :3084 | :3085 → :3086 |
| Dock app | `~/Applications/DSH.app` | `~/Applications/DSH Preview.app` (red) |
| logs | `~/.dsh/logs/{relay,dsh-web}.log` | `~/.dsh-preview/logs/{relay,dsh-web}-preview.log` |

**Is it installed?** `launchctl print gui/$UID/io.github.taliesinb.dsh-web-relay.preview >/dev/null 2>&1 && echo yes || echo no`
(or `cd plugins/dsh-tailscale-remote && pnpm relay:status --instance preview`).
If not, set it up — everything below is idempotent and touches only the
preview home, the preview LaunchAgent and the preview Dock app, never `~/.dsh`:

```sh
R=~/github/tali-dash-plugins                       # this repo; the fork is its submodule deepseek-harness/
H=~/.dsh-preview

# 1. Preview home: the standing rows (the plugins under trial go in cordis.dev.yml → pnpm dev-overlay, not here).
mkdir -p $H/profiles/web $H/.agent-presets
[ -f $H/profiles/web/cordis.patch.yml ] || cat > $H/profiles/web/cordis.patch.yml <<YML
- insert:
    - id: tali-tailscale-remote
      name: '$R/plugins/dsh-tailscale-remote/index.js'
      config:
        instance: preview
        listenPort: 3086
        publishPort: 3085
        mountPath: /dsh-preview
        dockAppName: DSH Preview
        dockAppGlyphColor: '#E5484D'
        relayCwd: $R/deepseek-harness
        relayStart: pnpm dsh --profile web --patch $R/cordis.dev.local.yml --no-open --port 3088
    - id: tali-local-model-supervisor
      name: '$R/plugins/local-model-supervisor/index.js'
      config:
        servers:
          - id: afm
            providers: [apple]
            command: afm
            args: ['--port', '9997']
            healthUrl: http://127.0.0.1:9997/v1/models
            idleMinutes: 15
    - id: tali-enforce-model-preset
      name: '$R/plugins/enforce-model-preset/index.js'
      config:
        rules:
          - provider: apple
            preset: minimal-no-tools
          - provider: lmstudio
            preset: minimal
          - provider: '*'
            preset: standard
YML
# Local-only models: copy just the apple + lmstudio providers from ~/.dsh/settings.yaml into
# $H/settings.yaml (no cloud keys), set agent-default-model to apple/foundation, and copy
# the preset: cp -R ~/.dsh/.agent-presets/minimal-no-tools $H/.agent-presets/

# 2. The relay LaunchAgent (:3085 → proxy :3086 → dsh web :3088 under DSH_HOME=$H):
cd $R/plugins/dsh-tailscale-remote
pnpm relay:install --instance preview --dsh-home $H --log-dir $H/logs \
  --listen 127.0.0.1:3085 --backend 127.0.0.1:3086 --dsh 127.0.0.1:3088 \
  --cwd $R/deepseek-harness \
  --start "pnpm dsh --profile web --patch $R/cordis.dev.local.yml --no-open --port 3088"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3085/     # 503 splash → DSH cold-starts (~3 s) → 401
```

A relay installed before 2026-09-25 still names `cordis.dev.yml` (the template,
whose rows now carry placeholder paths): edit its `--start` in
`~/Library/LaunchAgents/io.github.taliesinb.dsh-web-relay.preview.plist` to
`cordis.dev.local.yml`, run `pnpm dev-overlay`, then reload the definition —
`launchctl kickstart -k` reuses the cached plist, so it must be
`launchctl bootout gui/$UID/<label>` followed by `launchctl bootstrap gui/$UID <plist>`.

```sh

# 3. Publish the route and build the Dock app. Either via the preview GUI (Settings →
#    Tailscale remote → Enable, then This Mac → Install Dock app), or headless through the
#    control channel with the preview's launch token:
U=$(grep -o 'http://127.0.0.1:3088/?token=[^ ]*' $H/logs/dsh-web-preview.log | tail -1); rm -f /tmp/pj.txt
curl -s -c /tmp/pj.txt -o /dev/null "$U"
ctl() { curl -s -b /tmp/pj.txt -H 'content-type: application/json' -H 'origin: http://127.0.0.1:3088' \
  --data "{\"type\":\"client-request\",\"rpcId\":\"x\",\"method\":\"$1\",\"payload\":{\"args\":{}}}" "http://127.0.0.1:3088/tailscale-remote/$1"; echo; }
ctl enable; ctl install-dock-app                  # → ~/Applications/DSH Preview.app (red), Dock tile
pnpm relay:status --instance preview; pnpm dock-app:status --instance preview
```

Why each knob: `instance: preview` suffixes the LaunchAgent label, logs, state
file (`tailscale-remote-preview.json`) and Dock bundle id so the pair coexists
with the live one; the separate home is mandatory (session write locks —
see below); ports 3085–3088 avoid the live 3080/3083/3084 and the ad-hoc
3081/3082. Facts and failure table: `recipes/dock-app-via-tailnet.md`
§"Preview instance". Uninstall: `pnpm relay:uninstall --instance preview &&
pnpm dock-app:uninstall --instance preview --name "DSH Preview"`, then
`tailscale serve --https=443 --set-path /dsh-preview off`.

**How to use it as an agent:**

1. Put the plugin row(s) under trial into `cordis.dev.yml` (`name` paths under
   the `/Users/USER/github/tali-dash-plugins` placeholder prefix, then
   `pnpm dev-overlay` regenerates `cordis.dev.local.yml`, which is what loads;
   an `insert` list — it is a *complement* to the preview home's
   profile patch; do not repeat its standing ids listed above).
2. Start or restart the preview: `launchctl kickstart -k gui/$UID/io.github.taliesinb.dsh-web-relay.preview`
   (restarts the relay **and** the DSH it spawned — required after editing
   `cordis.dev.yml` or any host-side plugin module; client-bundle rebuilds
   hot-swap on their own). If it is not running yet, any request to
   `http://127.0.0.1:3085/` (or opening the Dock app) starts it; it answers a
   503 "Starting DSH…" page until the server is up (~3 s).
3. Reach it:
   - browsers on this Mac, incl. the `browser-automation` STP windows: open
     `https://laptop.example.ts.net/dsh-preview/` — admitted by
     the node's own Tailscale identity, **no token**;
   - scripts/curl: the tokened URL is printed into
     `~/.dsh-preview/logs/dsh-web-preview.log` (`dsh web: http://127.0.0.1:3088/?token=…`,
     the last occurrence is the current process); exchange it with a cookie
     jar (303) and call `/api/...` or the plugin control channels.
4. Tell the user to click **DSH Preview** in the Dock to see the same thing.

Facts: the default model (`apple/foundation`, preset `minimal-no-tools`)
answers plain text only and has **no tools** — a preview chat is for
exercising UI and plugin surfaces, not for agent work; switch to an LM Studio
model (`minimal` preset) if a tool call is what you need to see. Its Settings
persist (the page is treated as the operator's machine),
so providers/models configured there stay; sessions and workspaces are the
preview's own, never the live ones — **never point both servers at one home**
(session write ownership is a cross-process `flock`; a session listed by both
GUIs ends in `SessionAlreadyOwnedError`). Story and failure table:
`recipes/dock-app-via-tailnet.md`.

## Canary per branch: `pnpm canary` (the standard way to try a feature)

```sh
cd <plugins>/.worktrees/<branch>
pnpm canary            # builds the plugins changed on this branch, starts a separate dsh web
                       # on /tmp/dsh-canary/<branch>/home, credentials copied in, and launches
                       # a Dock app "DSH <branch> <commit>" (red whale) pointed at it
pnpm canary stop | remove | list | logs | url
pnpm canary --app      # the BUNDLED app (DSH Canary) built from this branch instead — its own
                       # home, all bundled plugins, no updater (recipes/canary-instances.md)
```

One instance per branch (first free port from 3091), independent of the live
DSH and the standing preview; rerunning restarts it on the same home. Details,
options and traps: `recipes/canary-instances.md`. Run it from a **worktree**:
from the main checkout a rebuild hot-swaps plugins the live server serves.

## Ad-hoc throwaway server (what `pnpm canary` automates)

A third `dsh web` against a `/tmp` home, e.g. for a patch you do not want in
`cordis.dev.yml`:

```sh
cd ~/github/deepseek-harness
DSH_HOME=/tmp/tali-dash-plugins-home \
  pnpm dsh --profile web --patch /tmp/my-overlay.yml --port 3090 --no-open
```

Run it as a managed background job and capture stdout. Note the CLI shape:
global options (`--profile`, `--patch`) come *before* the profile's own
(`--port`, `--no-open`); `dsh web --patch` is rejected. Ports 3080–3088 are
taken by the live/preview pairs; other sessions have used 3081/3082 ad hoc,
so pick 3090+ and stop the server when done.

## Details and gotchas

- **The URL is tokened.** stdout prints
  `dsh web: http://127.0.0.1:<port>/?token=...` — open THAT link (or hand it to
  the user); a bare `http://127.0.0.1:<port>/` answers 401. (The standing
  preview additionally has the token-free tailnet URL above.)
- **What isolation covers.** Sessions, workspace registrations, and profile
  state live per-home — but NOT the filesystem: agents run in the preview do
  real work in whatever workspace is opened there. Use a scratch directory.
- **Credentials.** A fresh home has no API keys or providers. Forward the
  user's by copying `~/.dsh/.credentials.yaml` (file-backed key store) and
  `~/.dsh/settings.yaml` (providers/models) into the throwaway home. They are
  snapshots, not links — edits on either side do not propagate.
- **Headless verification.** Fetch the tokened URL with a cookie jar and grep
  the `window.__DSH_BOOT__` graph for the plugin package name; the bundle is
  served at `/plugins/??<package>/client.js&rev=...` (expect HTTP 200).
- **HMR.** The server stat-polls every plugin bundle: a `pnpm watch` rebuild
  hot-swaps the browser without a refresh, and the graph row's `rev` flips
  from a process nonce to a content hash once a rebuild was observed. Host
  modules (`index.js` etc.) are NOT hot-reloaded — restart the instance.
  Rebuilding a bundle that the **live** server serves swaps it in every open
  GUI and kills any pending `ask_user_question`/approval prompt there
  (`NO_PROVIDER`) — see `recipes/client-bundle-rebuild-kills-pending-prompts.md`.
- **Disposable.** A `/tmp` home evaporates on reboot; treat everything in it
  (sessions, keys copied there) as throwaway state. `~/.dsh-preview` persists.

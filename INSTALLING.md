# Installing DSH (Tali's fork + plugins) on a fresh Mac

Assembled 2026-09-18 from the fork checkout, this repo (tools, recipes, plugin
READMEs) and the session transcripts `deepseek-harness/hybrid-local-remote` (T15–T17, T39–T43)
and `laptop/alpha-setup`, which set up the `alpha` MacBook Pro (macOS 27.0,
Apple Silicon) on 2026-09-16/17.

**One repo.** This repository carries the plugins, the tooling *and* the DSH
fork as the git submodule `deepseek-harness/` (branch `feat/embed-session`,
pinned to the commit the plugins were last tested against). Clone with
`--recurse-submodules`; nothing else needs to be checked out.

## What "the macOS app" is

Two things are called "the app"; this guide installs the first one.

| | What it is | Built by |
|---|---|---|
| **`~/Applications/DSH.app`** (what alpha got) | A ~350-line AppKit/WKWebView wrapper that opens `https://<host>.<tailnet>.ts.net/dsh/`, is admitted by the Mac's own Tailscale identity (no token, no expiring cookie), falls back to `http://127.0.0.1:<port>/?token=…` when Tailscale is down, and gets a Dock tile. Ad-hoc signed, no permissions. | `plugins/dsh-tailscale-remote/dock-app.mjs` in the plugins repo, compiled on the target with `xcrun swiftc` (Command Line Tools are enough; Xcode is not needed). |
| `apps/desktop` (Electron shell in this repo) | DeepSeek's signed/notarised Desktop release with a bundled Node runtime. Requires an Apple Developer ID, Team ID and notarytool credentials (`apps/desktop/README.md`). | Not used in Tali's setup. Not covered here. |

The Dock app is a thin client; the real install is the **DSH server** running
from a built checkout of this fork, plus a handful of out-of-tree plugins.
There are two ways to get that onto a fresh Mac:

- **Path B — deploy from a Mac that already runs DSH** (`pnpm deploy-remote
  user@host`). This is exactly what alpha received and is the verified path.
  The new Mac becomes a *remote* (headless server + its own Dock app) and
  appears in the deploying Mac's "Remotes" sidebar section.
- **Path C — standalone install** on the new Mac itself (what Tali's Air runs,
  minus the preview instance). Steps C1–C4 (a working local DSH with the
  plugins) were replayed on a second Mac on 2026-09-18; the optional layers
  (Apple on-device model, Tailscale route + Dock app) are verified only on
  Tali's machines.

Both paths share the manual prerequisites in Part A; A4 (Apple model) is
optional for both. The preview instance (`~/.dsh-preview`, `DSH Preview.app`,
port 3088) is deliberately left out.

## Resulting topology (Path B, as on alpha)

```
Dock app / browsers on the tailnet ─▶ https://alpha.tailbce956.ts.net/dsh/
  └▶ tailscaled (TLS, injects Tailscale-User-Login) ─▶ dsh-tailscale-remote proxy 127.0.0.1:3084 (inside DSH)
        └▶ DSH web 127.0.0.1:3080   (LaunchAgent ai.symbolica.dsh-remote, KeepAlive, zsh -lc)
Local fallback: http://127.0.0.1:3084/?token=<standing token>   (Dock app uses it when Tailscale is off)
```

| On the target | Path |
|---|---|
| Node (pinned to the deployer's version, no sudo/brew) | `~/.local/node/bin/node` |
| Built checkout incl. `node_modules` (same darwin-arm64) | `~/dsh/checkout/` |
| Plugins shipped | `~/dsh/plugins/{dsh-tailscale-remote,local-model-supervisor,enforce-model-preset,session-title-slug}` |
| DSH home | `~/.dsh/` (`settings.yaml`, `.credentials.yaml` copied from the deployer on first run) |
| Composition overlay (regenerated every deploy) | `~/.dsh/deploy/remote.cordis.yml` |
| Remote state: standing token + allowlist (kept across deploys) | `~/.dsh/tailscale-remote.json` (0600) |
| User preset for the on-device model | `~/.dsh/.agent-presets/minimal-no-tools/` |
| LaunchAgent | `~/Library/LaunchAgents/ai.symbolica.dsh-remote.plist` |
| Logs (launchd stdout/stderr) | `~/dsh/logs/dsh.log`, `~/dsh/logs/afm.log` |
| Dock app | `~/Applications/DSH.app` (`Contents/Resources/dsh-dock-app.json` holds url/fallback/tokenFile) |

Path C differs: the checkout is this repo's submodule
`tali-dash-plugins/deepseek-harness` (the plugins link into it relatively) run
through `pnpm dsh web`, an always-on **relay** LaunchAgent (`io.github.taliesinb.dsh-web-relay`,
port 3083) starts DSH on demand, and the plugins load from
`tali-dash-plugins/plugins/*`, installed into the profile as bundles
(`pnpm install-plugins`).

---

## Part A — manual prerequisites on the new Mac

Assumes: Apple Silicon, macOS 26 or newer (alpha: 27.0), Homebrew installed,
an admin user. Nothing below is automated by the deploy script except
`brew install rsync`.

### A1. Xcode Command Line Tools (gives `swiftc` for the Dock app)

```sh
xcode-select --install          # GUI prompt; wait for it to finish
xcode-select -p                 # → /Library/Developer/CommandLineTools
xcrun --find swiftc && swift --version   # alpha: Apple Swift 6.4 (macOS 27)
```

The deploy script skips the Dock app with "no Swift toolchain" if `xcrun
--find swiftc` fails. `swiftc` must be invoked through `xcrun` (the CLT binary
called directly says "unable to load standard library") — the plugin does this.

### A2. Tailscale

1. Install **Tailscale.app** (tailscale.com standalone build or App Store; both
   put the CLI at `/Applications/Tailscale.app/Contents/MacOS/Tailscale`, which
   is the path the deploy script and plugin default to). Optional:
   `ln -s /Applications/Tailscale.app/Contents/MacOS/Tailscale /usr/local/bin/tailscale`.
2. Log in to the **right tailnet as the right user**. The symbolica tailnet's
   ACL lets a user reach only *their own* devices plus tagged infrastructure;
   alpha was logged in as `alpha@symbolica.ai`, so `tali@` could not reach it
   (all TCP silently dropped over the tailnet, fine over LAN) until the admin
   added a policy rule (`src: group:research → dst: alpha@symbolica.ai, all
   ports`). Options, in order of preference: log in as the same user as the
   deploying Mac; ask for an ACL rule; or tag the node — but **tagged nodes
   carry no `Tailscale-User-Login`**, so identity admission stops working and
   only the token/QR path remains.
3. Name it: `tailscale set --hostname=alpha` (MagicDNS name becomes
   `alpha.<tailnet>.ts.net`). Match the OS name if you like:
   `sudo scutil --set HostName alpha; sudo scutil --set LocalHostName alpha; sudo scutil --set ComputerName alpha`.
4. Tailnet must have **MagicDNS and HTTPS certificates** enabled (they are on
   symbolica); `tailscale serve` needs them. First HTTPS hit after publishing
   can take a few seconds while the cert is issued.
5. Verify from the deploying Mac: `tailscale ping alpha` and `nc -z -G 4 <tailnet-ip> 22`.

Known trap (worked around in the LaunchAgent): the macOS Tailscale CLI fails
with *"The Tailscale GUI failed to start"* from a bare launchd environment; it
works from a login shell (`SHLVL` set). Anything that runs `tailscale` under
launchd must go through `/bin/zsh -lc`.

### A3. Remote Login + key auth (Path B only)

System Settings → General → Sharing → **Remote Login** on. Then from the
deploying Mac (password prompt once):

```sh
ssh-copy-id -i ~/.ssh/id_ed25519.pub alpha@192.168.0.42     # LAN IP or tailnet name
ssh -o BatchMode=yes alpha@alpha 'echo ok'                  # must succeed without a prompt
```

`deploy-remote.sh` uses `BatchMode=yes`; it dies with "cannot ssh … (key auth
required)" otherwise. Note that a non-interactive `ssh host cmd` does **not**
load `~/.zprofile`, so `brew`/`/opt/homebrew/bin` is not on PATH — the script
wraps brew calls in `zsh -lc` for that reason; do the same when poking around.

### A4. (Optional) Apple Intelligence + AFM (the `apple/foundation` model)

**Optional.** Alpha's default model is Apple's on-device model, reached
through **AFM** (`scouzi1966/maclocal-api`), an OpenAI-compatible server on
`127.0.0.1:9997` that the `local-model-supervisor` plugin starts on demand.
It is a free, private, tool-less 4K chat model — useful as a default for a
headless remote, not needed for agent work. If you skip it, also skip the
`apple` provider block in C3 and drop (or leave inert — they only fire when
the `apple` provider is selected) the `tali-local-model-supervisor` row and the
`apple` rule in C4.

Both pieces are manual. Note that afm is shipped as a **prebuilt arm64
binary** (no Homebrew bottle, no build), so the machine's `swift --version`
(CLT) is irrelevant; what matters is the **macOS major version**, because the
release check targets the OS's Swift runtime / FoundationModels framework:

1. System Settings → **Apple Intelligence & Siri** → enable, and wait for the
   model download. Until then every request fails with
   `"Apple Intelligence is not enabled."`.
2. Install afm (needs brew in a login shell):

   ```sh
   brew trust scouzi1966/afm            # Homebrew ≥ 6 refuses untrusted taps (third-party tap: your call)
   # macOS 27 or newer — current stable works (alpha: v0.9.19):
   brew install scouzi1966/afm/afm
   # macOS 26.x — stable ≥ 0.9.17 aborts at startup with "503: Apple Foundation Models require the
   # Swift 6.4 toolchain or newer"; pin 0.9.10 and fix its metallib packaging bug:
   brew install scouzi1966/afm/afm@0.9.10 && brew link afm@0.9.10
   KEG=/opt/homebrew/Cellar/afm@0.9.10/0.9.10
   ln -sfn "$KEG/libexec/MacLocalAPI_MacLocalAPI.bundle" /opt/homebrew/bin/mlx-swift_Cmlx.bundle
   ln -sfn ../libexec/MacLocalAPI_MacLocalAPI.bundle "$KEG/bin/mlx-swift_Cmlx.bundle"
   afm --version
   ```

   (Without the symlinks 0.9.10 dies on the first generation with `MLX error:
   Failed to load the default metallib`. Full story:
   `tali-dash-plugins/recipes/apple-foundation-model-provider.md` §1–2.)
3. Smoke test (then kill it; DSH will manage it):

   ```sh
   afm --port 9997 &
   curl -s http://127.0.0.1:9997/v1/models | head -c 200
   curl -s http://127.0.0.1:9997/v1/chat/completions -H 'content-type: application/json' -H 'authorization: Bearer x' \
     -d '{"model":"foundation","messages":[{"role":"user","content":"Reply with exactly: ok"}],"max_tokens":20}'
   kill %1
   ```

Skipping this is fine if you never select the Apple model; the deploy still
succeeds (alpha ran without afm for a day — "the apple foundation model isn't
working on alpha" was simply afm not being installed).

### A5. Homebrew rsync (Path B; auto-installed if missing)

Apple's `/usr/bin/rsync` is **openrsync** (protocol 29) and stalls forever on
the checkout's ~85k-file listing (the first deploy sat 15 minutes transferring
nothing). The script checks for `/opt/homebrew/bin/rsync` and runs `zsh -lc
"brew install rsync"` on the host when absent; doing it up front avoids the
surprise: `brew install rsync`.

### A6. Optional apps for the optional tool plugins

Only needed if you load these plugins (Path C, or if you later extend the
deploy's plugin list):

| Plugin | Needs on the Mac | Note |
|---|---|---|
| `browser-automation` (`safari_*`, `chrome_*` tools) | **Safari Technology Preview** (developer.apple.com/safari/technology-preview) — only STP ships `safaridriver --mcp`; stable Safari has no fallback. **Google Chrome** for `chrome_*` (`chrome-devtools-mcp` is a pinned dependency of the plugin, run by node). | First run of each may prompt: Safari ▸ Develop ▸ Allow Remote Automation is *not* needed for STP `--mcp`, but STP must be launched once to accept its licence. |
| `dash-docsets` | Dash 8 with docsets installed | plugin enables Dash's HTTP API itself |
| `wolfram-kernel-supervisor` | Mathematica / Wolfram 15 (`Wolfram.app`, `WolframScript.app`) with the AgentTools MCP server | |
| LM Studio provider (`lmstudio`, `:1234`) | LM Studio.app with a model loaded and the local server on | |

### A7. Keep a headless remote awake

alpha reported `sleep 1 (sleep prevented by powerd …)`; for a lid-closed or
unattended server set `sudo pmset -a sleep 0 disablesleep 1` (or keep it on
power with "Prevent automatic sleeping" on).

---

## Part B — deploy from an existing DSH Mac (verified on alpha)

Run on the Mac that already has the fork built (Tali's Air). Requirements
there: `rsync`, `python3`, `tailscale` on PATH (used for `whois` to learn your
login for the allowlist; otherwise set `DSH_REMOTE_ALLOWED_USERS=you@example.com`),
the fork at this repo's `deepseek-harness/` submodule (override
`DSH_CHECKOUT`), and the same
platform/arch as the target (`uname -sm` must match — `node_modules` incl.
native addons is shipped as-is).

```sh
cd ~/github/tali-dash-plugins
pnpm deploy-remote alpha@alpha                # tailnet name, or alpha@192.168.0.42 on the LAN
# flags: --no-build (reuse built artifacts)  --credentials (re-copy settings/credentials)  --port=N (default 3080)
# env:   DSH_REMOTE_TARGET  DSH_CHECKOUT  DSH_REMOTE_PORT  DSH_REMOTE_ALLOWED_USERS
```

What one run does (idempotent; first-run steps only when missing):

1. Builds the fork (`pnpm run build`, log `/tmp/dsh-deploy-build.log`) and the
   `dsh-tailscale-remote` client bundle.
2. Installs the deployer's exact Node version into `~/.local/node` on the host
   (nodejs.org tarball, no sudo). Ensures Homebrew rsync.
3. rsyncs the built checkout (+`node_modules`, minus `.git website snapshots
   python .agents coverage .turbo`) to `~/dsh/checkout/`; the four plugins to
   `~/dsh/plugins/`; the `minimal-no-tools` preset to `~/.dsh/.agent-presets/`.
   First transfer: ~1.7 GB / 81k files (~70 s on LAN); later ones seconds.
4. Copies `~/.dsh/.credentials.yaml` and `~/.dsh/settings.yaml` from the
   deployer **if the host has none** (or with `--credentials`). Your cloud API
   keys therefore land on the remote — intended, since its agents run there.
5. Writes `~/.dsh/deploy/remote.cordis.yml` (tailscale-remote with
   `publishPort: 0`, slug-style `session-title-llm`, session-title-slug,
   enforce-model-preset `apple → minimal-no-tools`, local-model-supervisor
   for `afm --port 9997`), creates `~/.dsh/tailscale-remote.json` with a fresh
   standing token and your tailnet login allowlisted (kept on later runs), and
   (re)writes + restarts the LaunchAgent. Waits for HTTP 401 on `:3080`.
6. If `xcrun --find swiftc` works: logs in on the host with the launch token
   from `~/dsh/logs/dsh.log`, calls the plugin's control channel to add the
   **host's own tailnet login** to the allowlist and `install-dock-app` →
   `~/Applications/DSH.app` built, pinned to the Dock and launched.
7. Prints `remote GUI: https://alpha.tailbce956.ts.net/dsh/`, the token link,
   `tailscale serve status`, and probes the URL from your Mac (200/303 = you are
   admitted by identity; 401 = use the token link or fix the allowlist).

Then on the deploying Mac's GUI: Remotes section → **add remote workspace** →
paste the URL (identity mode, no token needed) → pick a directory on the
remote (e.g. `~/projects/scratch`, create it first over ssh).

Day-to-day:

```sh
pnpm remote-status [user@host]      # launchd state, HTTP 401 check, node/checkout version, serve status, log tail
pnpm remote-logs   [user@host]      # tail -f ~/dsh/logs/dsh.log
pnpm remote-restart | pnpm remote-stop
pnpm deploy-remote user@host --no-build     # config-only redeploy (~10 s)
```

Only the launch line reaches `dsh.log` (`ctx.logger` output does not); plugin
diagnostics are file traces where the plugin offers one.

What went wrong on alpha and is now handled by the script (keep in mind when
extending it): openrsync stall (A5); Tailscale CLI under launchd (A2, hence
`zsh -lc`); the plugin's default `publishPort: 3083` expects a relay LaunchAgent
the headless host never had → Serve pointed at a dead port (502) — deploy now
sets `publishPort: 0` so Serve targets the proxy (`:3084`) directly and the
plugin re-points it on every boot; `mkdir` of the plugin's `node_modules`
before syncing `uqr`; `enforce-model-preset` did not fire for sessions on the
*default* model (no `model/selection` event) — fixed in the plugin (`2d63ac9`).

---

## Part C — standalone install (the new Mac is the primary)

This mirrors Tali's Air. C1–C3 were replayed on a second Mac on 2026-09-18
(macOS 26.6.2, node 25.8.1, pnpm 11.7.0, repos under
`~/Documents/Symbolica/`). C4's one-command bundle install replaced a
hand-written patch the same day and was verified against a throwaway home
on the Air (12 rows composed, all client bundles served). C5 and the optional
Apple route have only been exercised on Tali's machines.

**Layout.** One clone, anywhere (`~/github/tali-dash-plugins` below; the
directory name is free). The fork lives inside it as the submodule
`deepseek-harness/`; the plugins link into it relatively
(`link:../../deepseek-harness/...`) and every tool defaults to it. Nothing in
the profile needs an absolute path; only the dev overlay `cordis.dev.yml`
does, and only if you use it.

**Stopping points.** After C4 you have a fully working local DSH with the
plugins (`pnpm dsh web`). A4/C3-Apple (on-device model) and C5 (Tailscale
route, relay LaunchAgent, Dock app) are independent optional layers.

### C1. Node, pnpm, git — clone this repo with the fork inside it

```sh
brew install node pnpm git            # node ≥ 24 (Air: 26.7.0, tested: 25.8.1); the fork pins pnpm 11.7.0 via
                                      # packageManager and pnpm ≥ 10 fetches/uses that version itself
mkdir -p ~/github && cd ~/github
git clone --recurse-submodules https://github.com/taliesinb/dsh-plugins tali-dash-plugins
cd tali-dash-plugins/deepseek-harness # the fork, at the pinned commit on feat/embed-session
git remote add upstream https://github.com/deepseek-ai/deepseek-harness.git   # optional, for rebasing
pnpm install
pnpm run build                        # ~100 s
pnpm dsh web --no-open                # first launch initialises ~/.dsh: profiles/web/cordis.patch.yml, .credentials.yaml
                                      # (NOT settings.yaml — see C3); prints http://127.0.0.1:3080/?token=… — open it once, then Ctrl-C
```

Already cloned without `--recurse-submodules`? `git submodule update --init`.
To move the fork to the branch tip instead of the pinned commit:
`git submodule update --remote deepseek-harness` (then rebuild). The pin is
deliberate — it is the fork commit these plugins were last run against.

`fix/tailscale-mounting` (merged into `feat/embed-session`) is the minimum the
tailnet path mount needs (document-relative URLs); stock `master` loads the
remote page's HTML and then 404s on everything else. Node engines:
`^22.19.0 || >=24.0.0`. Remove any stale `~/Library/pnpm` state if `pnpm` and
the fork disagree about versions.

### C2. Build the plugins

Every plugin's `link:` dependency is **relative** to the submodule
(`link:../../deepseek-harness/vendor/cordis` …), so nothing needs rewriting.
`browser-automation` and `wolfram-kernel-supervisor` depend on
`@modelcontextprotocol/sdk` / `sharp` from npm at the fork's versions instead
of linking into its `.pnpm` store.

The one absolute-path file is `cordis.dev.yml` (dev overlay; row `name:` must
be an absolute module path — the loader's `!!js` interpolation applies to
`config` only, never `name`). It matters only if you use the preview/dev
overlay; otherwise skip it:

```sh
cd ~/github/tali-dash-plugins
sed -i '' "s#/Users/tali/github/tali-dash-plugins#$PWD#g" cordis.dev.yml
```

Install **every** plugin, then build the ones with a client bundle. The
build-only plugins (`session-title-slug`, `settings-shortcut`,
`agent-status-indicator`) have no runtime deps but need their devDependencies
(esbuild, typescript) — `pnpm build` fails with "node_modules missing" until
they are installed too:

```sh
for p in plugins/*/; do (cd "$p" && pnpm install); done          # 14 plugins; the three plain-ESM ones are no-ops
for p in dsh-tailscale-remote dsh-remote-workspaces session-title-slug settings-shortcut \
         agent-status-indicator foreign-link-opener wolfram-kernel-supervisor; do (cd plugins/$p && pnpm build); done
```

`enforce-model-preset`, `local-model-supervisor`, `preview-identity` are plain
ESM with `node:` imports only. A `dsh.client` package whose `lib/client.js` is
missing fails activation loudly at boot, so build before loading.

### C3. Providers and the on-device preset

**Cloud providers** (Anthropic, OpenAI, DeepSeek, …) are configured in the
GUI: Settings → Providers / Models. Keys go to `~/.dsh/.credentials.yaml`
(created on first launch); provider/model routes go to `~/.dsh/settings.yaml`,
which the GUI **creates on first save** — it does *not* exist after C1. Do at
least one provider through the GUI, or create the file yourself.

**Optional — Apple on-device model** (only if you did A4). Create or extend
`~/.dsh/settings.yaml` with this block under `llm-pi-ai.providers` (merge into
the existing `llm-pi-ai:` key if the GUI already wrote one; the adapters re-read
the file on the next request, no restart):

```yaml
llm-pi-ai:
  providers:
    apple:
      displayName: Apple Foundation
      api: openai-completions
      baseURL: http://127.0.0.1:9997/v1
      headers:
        Authorization: Bearer x          # afm needs no key; pi-ai insists on one
      compat:
        supportsDeveloperRole: false
        maxTokensField: max_tokens
      models:
        - id: foundation
          name: Apple Foundation (on-device)
          contextWindow: 16384           # deliberate over-claim (pi-ai's 4096 reserve); real window 4096
          maxTokens: 1024
```

Create the user preset the Apple rule switches sessions to (harmless to
create even without the Apple route — it just appears in the preset picker):

```sh
mkdir -p ~/.dsh/.agent-presets/minimal-no-tools
cat > ~/.dsh/.agent-presets/minimal-no-tools/preset.yml <<'EOF'
name: Minimal (no tools)
description: Chat-only composition for tiny local models — a one-line persona, no tools, no runtime context. Pairs with small context windows (e.g. Apple Foundation on-device).
order: 4
EOF
cat > ~/.dsh/.agent-presets/minimal-no-tools/agent.cordis.yml <<'EOF'
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: You are a helpful, concise assistant.
    complete: true
    includeRuntimeContext: false
EOF
```

### C4. Install the `tali-dash-plugins` plugins into the web profile

Scope: the hundreds of in-tree `@deepseek-ai/dsh-*` plugins come from the
shipped `web` bundle and need no configuration — `pnpm dsh web` composes them.
This step adds only the **out-of-tree plugins from `tali-dash-plugins`**.

Every live-profile plugin in that repo is an installable **bundle** (its
`package.json` declares `dsh.bundle.patch`, and its `cordis.patch.yml` inserts
its own `tali-*` row by package name), so the whole set is one command:

```sh
cd ~/github/tali-dash-plugins
pnpm install-plugins                 # = tools/install-plugins.sh; --profile <name>, --checkout DIR, --dry-run, --remove
```

It runs `pnpm dsh plugin --profile web add <12 plugin dirs>` from the fork
submodule: pnpm links the directories into `~/.dsh/profiles/web/node_modules`
(flat, `nodeLinker: hoisted`) and appends 12 bundles to
`dsh.profile.bundles`; the rows resolve **by package name**, so no patch file
carries an absolute path. It refuses to run if a client plugin's
`lib/client.js` is missing (C2). Idempotent; `pnpm remove-plugins` undoes it;
`pnpm dsh plugin --profile web remove <pkg>` drops one.

| Plugin (package) | Needs on the Mac | Tools it adds |
|---|---|---|
| `dsh-tailscale-remote` | Tailscale.app (C5); inert until *Enable* | Settings → Tailscale remote / Server panes |
| `tali-enforce-model-preset` | nothing (rules act only on their providers) | — |
| `tali-browser-automation` | **Safari Technology Preview** + **Google Chrome** (A6) | `safari_*`, `chrome_*` |
| `tali-dash-docsets` | **Dash 8** (A6) | `dash_*` |
| `tali-local-model-supervisor` | afm (A4); only fires for the `apple` provider | — |
| `tali-wolfram-kernel-supervisor` | **Mathematica / Wolfram 15+** at `/Applications/Wolfram.app` (ships the `Wolfram/AgentTools` paclet; defaults find both) | `wolfram_*` |
| `tali-foreign-link-opener` | only useful with a Safari "Add to Dock" web app; harmless otherwise | — |
| `tali-session-introspect` | nothing | `transcript_*` |
| `tali-fs-tools` | nothing | `list_dir`, `read_many`, `edit_many`, `search` |
| `tali-settings-shortcut` | nothing | ⌘. toggles Settings |
| `tali-session-title-slug` | nothing | `slug: prompt` naming |
| `dsh-remote-workspaces` | nothing (only meaningful on a Mac that controls remotes) | "Remotes" sidebar section |

Not installed, by choice: `agent-status-indicator` (floating status emoji;
`pnpm dsh plugin --profile web add plugins/agent-status-indicator` if wanted)
and `preview-identity` (dev-overlay only; never in a live profile). A plugin
whose external app is missing does not break the boot — its tools fail at
first use — so remove it or leave it.

**Configuration.** The bundles' row configs are the plugins' schema defaults,
and those equal Tali's live settings (`tailscale-remote` proxy `:3084` /
relay `:3083`, `browser-automation` `subagents: true`, `wolfram` `theme: auto`,
the `apple → minimal-no-tools` rule, …). `~/.dsh/profiles/web/cordis.patch.yml`
(created by the first launch; `patchReload: live`) therefore stays **empty**
unless you want to override a row by id — remember a patch replaces the row's
whole `config`, so restate every key. Tali's only live additions are debug
trace files, e.g.:

```yaml
- id: tali-browser-automation
  config:
    traceFile: /tmp/browser-automation-trace.log
```

Optional, not a `tali-dash-plugins` plugin: Tali's patch also overrides the
in-tree `session-title-llm` row (`style: slug`, `targetWords: 5`,
`maxOutputTokens: 64`, …) so model-generated titles come out as
`foo-bar-baz`, matching the hand-typed `slug:` convention.

Verify the composition without booting (expect 12 `tali-` rows — the
installer prints them too): `pnpm dsh --profile web --dump-config | grep -n 'id: tali-'`.

> Do **not** also insert these plugins by absolute path in the profile patch
> (the pre-2026-09-18 layout of Tali's own profile): a duplicate row id fails
> the boot.

**Stopping point:** `pnpm dsh web` now runs a complete local DSH with the
plugins; everything below is the tailnet/Dock-app layer.

### C5. (Optional) Relay LaunchAgent, enable the route, build the Dock app

Prerequisites from Part A: Tailscale.app **running and logged in** to the
tailnet (`tailscale status --self` shows your node; C5 does nothing useful
otherwise — the Dock app would only ever use its loopback fallback), and the
Command Line Tools (A1) for `swiftc`. Side effects to be aware of: a
LaunchAgent that starts at login (`io.github.taliesinb.dsh-web-relay`,
visible in Login Items as `dsh-web-relay`), a published `tailscale serve`
route reachable by anyone your tailnet ACL admits, and a **Dock tile**.

```sh
cd ~/github/tali-dash-plugins/plugins/dsh-tailscale-remote
pnpm relay:install --cwd ~/github/tali-dash-plugins/deepseek-harness --start "pnpm dsh web --no-open"
#  → ~/Library/LaunchAgents/io.github.taliesinb.dsh-web-relay.plist, listens :3083, relays to :3084,
#    starts `dsh web` (through zsh -lc) when it is down. Logs: ~/.dsh/logs/{relay,dsh-web}.log
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3083/     # 503 splash → DSH starts (~3 s) → 401
grep -o 'http://127.0.0.1:3080/?token=[^ ]*' ~/.dsh/logs/dsh-web.log | tail -1   # open this in Safari
```

In the GUI: Settings → **Tailscale remote** → **Enable** (publishes
`tailscale serve --bg --yes --https=443 --set-path /dsh http://127.0.0.1:3083`,
state to `~/.dsh/tailscale-remote.json`). Then either press **Install Dock
app** in the *This Mac* group, or:

```sh
pnpm dock-app:install --name DSH --fallback http://127.0.0.1:3083/
pnpm dock-app:status   # and: pnpm relay:status
```

The Dock app is admitted by the node's own login implicitly — no allowlist
entry needed for the Mac itself. Add other people's logins under *Allowed
Tailscale users*, or hand them the QR (carries the standing token).

Restart everything after host-side plugin edits:
`launchctl kickstart -k gui/$UID/io.github.taliesinb.dsh-web-relay`.

---

## Verification checklist

```sh
# server up (401 = auth wall, i.e. alive)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/
# route published
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve status        # https://<host>.<tailnet>.ts.net (tailnet only) |-- /dsh proxy http://127.0.0.1:3084 (or :3083 with a relay)
# admitted by identity from this Mac (200/303), anonymous from elsewhere (401)
curl -s -o /dev/null -w '%{http_code}\n' https://<host>.<tailnet>.ts.net/dsh/
# Dock app present, running, pinned
ls ~/Applications/DSH.app/Contents/MacOS/DSH; cat ~/Applications/DSH.app/Contents/Resources/dsh-dock-app.json
pgrep -fl 'Applications/DSH.app'; defaults read com.apple.dock persistent-apps | grep -c DSH.app
# Apple model: pick "Apple Foundation (on-device)" in a NEW session → chip must read "Minimal (no tools)";
# a one-line prompt answers in ~1 s and afm appears:
pgrep -fl 'afm --port 9997'
```

## Troubleshooting (consolidated from the alpha work)

| Symptom | Cause / fix |
|---|---|
| Deploy hangs at "syncing the checkout", nothing arrives | Apple openrsync on the host — `brew install rsync` there (script does it if brew is reachable via `zsh -lc`) |
| `cannot ssh to … (key auth required)` | A3: Remote Login off or key not installed |
| `host is Darwin x86_64, local is Darwin arm64` | Path B ships `node_modules`; same platform/arch only |
| Deploy fine, `tailscale serve status` empty, no `/dsh` | Tailscale CLI run from bare launchd; the plist must exec via `/bin/zsh -lc` (current script does) |
| Tailnet URL 502 | Serve targets a port nobody listens on (a relay that is not installed) — `publishPort: 0` on a headless host, or install the relay (C5) |
| Tailnet URL times out from another Mac, LAN works | Tailnet ACL: different Tailscale users; same-user login, ACL rule, or tag (loses identity headers) |
| Tailnet URL 401 for you | your login not allowlisted and not the node's own; use the token link or `DSH_REMOTE_ALLOWED_USERS` / Settings → Allowed users |
| First HTTPS request `000` right after enabling | cert issuance for the new MagicDNS name; retry in a few seconds |
| `Dock app: skipped (no Swift toolchain)` | A1 |
| `swiftc … unable to load standard library` | must be `xcrun swiftc` (plugin does; don't call the CLT binary directly) |
| Apple model: `Apple Intelligence is not enabled` | A4 step 1 |
| Apple model never answers / picker lacks it | afm not installed (A4) or `apple` provider missing from `settings.yaml`; check `pgrep -fl afm` and `~/dsh/logs/afm.log` (deploy) / `/tmp/local-model-supervisor-afm.log` (standalone) |
| Apple model replies cut at 1 token | `contextWindow: 16384` + `maxTokens: 1024` missing (pi-ai's 4096 reserve) |
| Apple session shows "Standard mode", huge prompt, errors | preset rule not applied: `minimal-no-tools` preset files missing, or an `enforce-model-preset` older than `2d63ac9` (default-model sessions fire no `model/selection`) |
| Remote page HTML loads, then 404s on `/api`, `/plugins` | DSH not on `fix/tailscale-mounting` / `feat/embed-session` |
| Two DSH tiles in the Dock | Dock plist `<data>` parsing trap; drag one off |
| `resume failed … SessionAlreadyOwnedError` | two servers on one `$DSH_HOME` — never share a home between instances |
| Plugin prints nothing, no error | `inject` names an unavailable service → PENDING; or a `dsh.client` package with no built `lib/client.js` (build it) |
| Boot fails with a duplicate row id (`tali-…`) | the plugins are installed as bundles *and* inserted by path in `cordis.patch.yml`; delete the path inserts (C4) |
| `pnpm install-plugins`: "lib/client.js is not built" / "no node_modules" | finish C2 for that plugin first |
| `pnpm install` in a plugin fails on `link:` | the submodule is not checked out — `git submodule update --init` (links are `../../deepseek-harness/…`) |
| `pnpm build` in `session-title-slug` / `settings-shortcut` / `agent-status-indicator`: "node_modules missing" | they have devDependencies (esbuild) — run `pnpm install` in every plugin first (C2) |
| `~/.dsh/settings.yaml` missing after first launch | expected; the GUI creates it on the first provider save, or create it by hand (C3) |
| afm: `503 … Swift 6.4 toolchain or newer` | macOS 26.x with stable afm — pin `afm@0.9.10` + metallib symlinks (A4); the local CLT `swift --version` is irrelevant (prebuilt binary) |

## Uninstall / rollback

Path B host: `launchctl bootout gui/$(id -u)/ai.symbolica.dsh-remote; rm ~/Library/LaunchAgents/ai.symbolica.dsh-remote.plist;
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --https=443 --set-path /dsh off; rm -rf ~/dsh ~/.local/node ~/Applications/DSH.app`
(keep or delete `~/.dsh` — sessions live there).

Path C: `cd ~/github/tali-dash-plugins/plugins/dsh-tailscale-remote && pnpm dock-app:uninstall --name DSH && pnpm relay:uninstall`,
then `tailscale serve --https=443 --set-path /dsh off` and drop the rows from the profile patch.

## Sources

- `tools/deploy-remote.sh`, `tools/remote-ctl.sh`, `tools/install-plugins.sh`,
  `tools/migrate-to-submodule.sh` (the one-time migration of Tali's own Mac)
- `plugins/dsh-tailscale-remote/README.md`
- recipes: `dock-app-via-tailnet.md`, `tailscale-remote-plugin.md`,
  `apple-foundation-model-provider.md`, `browser-automation-plugin.md`,
  `remote-workspaces-plugin.md`; `AGENTS.md`, `PREVIEWING.md`
- transcripts: `deepseek-harness/hybrid-local-remote` T15–T17 (first deploy,
  openrsync, launchd/Tailscale), T39–T40 (tailnet deploy, `publishPort: 0`),
  T42 (Dock app on alpha), T43 (afm + preset fix); `laptop/alpha-setup`
  (hostname rename, ACL diagnosis, ssh key)
- `deepseek-harness/apps/desktop/README.md` (why the Electron shell is out of scope)

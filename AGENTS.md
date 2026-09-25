# AGENTS.md — tali-dash-plugins

Out-of-tree work on DeepSeek Harness (DSH): **plugin code** under
`plugins/`, **recipes** (one Markdown file per completed setup/change) under
`recipes/`, helper scripts under `tools/`, and the DSH fork itself as the
submodule `deepseek-harness/`. Setting up a fresh machine: [INSTALLING.md](INSTALLING.md); the one-page colleague
version: [QUICKSTART.md](QUICKSTART.md) (placeholders only — real host/user names live in `extras/`). This file is the onboarding
guide for agents working here: how DSH plugins work, how this repo is laid
out, where the authoritative docs live, and how to record what you did.

> **VERY IMPORTANT: changes under the user's live DSH home (`$DSH_HOME`,
> default `~/.dsh`) can hot-reload the very client/server session YOU are
> likely being run in, making it inoperative.** The `web` profile ships
> `patchReload: 'live'`, so edits to `$DSH_HOME/cordis.patch.yml` or
> `$DSH_HOME/profiles/<name>/cordis.patch.yml` apply to the running server
> THE MOMENT you save. Rebuilding a plugin bundle that is installed in the
> live profile hot-swaps the live browser too. Even boot-time changes
> (`dsh plugin add`/`remove`) alter what the user's next launch runs. Make
> none of these changes unless explicitly asked; if the user only implies it
> (e.g. "install this plugin", "fix this DSH bug"), confirm first that they
> mean their live DSH. The safe, no-confirmation way to trial a plugin is the
> isolated preview server — see [PREVIEWING.md](PREVIEWING.md).

## Locations (symbolic — resolve them on the machine you are on)

| Symbol | Meaning | What belongs there |
|---|---|---|
| `<plugins>` | **this repo** | All plugin code (`plugins/<name>/`), recipes (`recipes/`), helper tools (`tools/`), the dev overlay template `cordis.dev.yml` (generated copy: `cordis.dev.local.yml`) |
| `<dsh-src>` | the DSH **source checkout** — the custom fork (`taliesinb/deepseek-harness`, branch `feat/embed-session`) as this repo's git **submodule `deepseek-harness/`**; the clone that `pnpm dsh web` runs from | Reference for APIs, docs (`docs/`), shipped presets. Fork commits live there (Remotes/embed/tailscale-mounting); ordinary features are plugins, not fork patches. Bump the submodule pin (`git add deepseek-harness`) when the fork moves |
| `$DSH_HOME` | the DSH home, default `~/.dsh` | Configuration, not code: `settings.yaml` (providers, models), `.agent-presets/`, `profiles/web/cordis.patch.yml` (which plugins the live web GUI runs), `sessions/`, `attachments/` |
| `<recipes-ws>` | the maintainer's **recipes workspace** — a code-free directory used as a session cwd whose `AGENTS.md` just points here | Nothing; recipes live in `<plugins>/recipes/` |

All doc paths below are relative to `<dsh-src>`. **Verify APIs against the
checkout** before relying on this file — it is a summary, the checkout is the
truth. Recipes spell out the concrete `~`-relative paths of the machine they
were written on; map them onto the symbols above when you are elsewhere.

Absolute paths are unavoidable in one place and are generated there: the dev
overlay rows (`name:` must be an absolute module path; the loader's `!!js`
interpolation covers `config` only). The committed `cordis.dev.yml` is a
**template** with the placeholder prefix `/Users/USER/github/tali-dash-plugins`;
`pnpm dev-overlay` writes the gitignored `cordis.dev.local.yml` with the real
path, and that generated file is what the preview relay and every `--patch`
command load — edit the template, regenerate. The plugins' `link:` dependencies are **relative**
(`link:../../deepseek-harness/...`, i.e. the submodule), so the fork must be
checked out there (`git submodule update --init`). The repo is **not** local-only: it is pushed
to `origin` (https://github.com/taliesinb/dsh-plugins), so commit finished
work and `git push`; anything machine-specific (those absolute paths, `~`
paths in recipes) is documented as such rather than assumed.

## Permissions (deliberate — do not "fix")

Sessions started from `<recipes-ws>` have `workspace-write` over that
directory only. Writing plugin code or recipes into `<plugins>` (or config
into `$DSH_HOME`) triggers one approval escalation per operation — **that is
the maintainer's chosen setup** (decided 2026-09-05). Do not try to widen the sandbox:
the DSH file policy is single-root by design (`workspaceRoot` = session cwd;
enforcement is canonicalize-then-contain, so symlinks don't help; no plugin
seam exists, and shell writes enforce the same roots at the OS level). Just
attempt the write and let the approval prompt do its job. If approvals are
disabled in a session, a denial is final.

## Ground rules

- **This repo is public.** Nothing that identifies a real deployment goes into
  it — no host names, macOS account names, tailnet/MagicDNS names, tailnet
  logins, LAN IPs, or internal repo names — not in code, comments, recipes,
  this file, or commit messages. Write `<remote>`, `<user>`,
  `<host>.example.ts.net`, "the shared remote machine", "DSH Remote" instead, and
  put the concrete facts in the private `extras/` submodule (its `AGENTS.md`
  has the full rule, the grep to run on every staged diff, and the history
  rewrite procedure). Before committing: `git diff --cached -- . ':!extras' |
  grep -i` for the identifiers listed there. Four history rewrites already
  (2026-09-21 and 2026-09-22 for leaks; 2026-09-25 to move a plugin into
  `extras/` and to make the prose impersonal — no personal names, no
  `/Users/<login>` paths, machine-neutral wording); a leak must never cause
  another. House style since then: "the maintainer", "the custom fork",
  "the development laptop", `/Users/USER/…`, `user@example.com`, "shared
  machine", "fresh machine", "native OS apps".
- Plugins are developed **out-of-tree** (this repo). Never fork/patch DSH to
  add a feature: "There is no privileged core to patch: you extend dsh by
  mounting a plugin beside the others" (`docs/architecture.md`).
- Layout: one plugin = one directory under `plugins/`, each an installable npm
  package. `cordis.dev.yml` at the repo root is the dev overlay template that
  loads them by absolute path (through the generated `cordis.dev.local.yml`).
- The recipe owns the system-level story; the plugin README owns the plugin.
  Cross-reference rather than duplicate.
- **No explanatory blurbs in the UI.** The maintainer does not want captions, help
  paragraphs or hint sentences under fields, in dialogs or in panels ("The URL
  its Tailscale remote publishes (keep the trailing slash). Your tailnet
  login is used to sign in; a token is only needed when…", "Must already exist
  there; it becomes an ordinary workspace…", "Tab completes, ↑↓ pick a
  suggestion…" — all removed on request, 2026-09-24). A label, a placeholder,
  a short status line (e.g. "Directory will be created") and an error message
  when something fails are the whole vocabulary. Put the explanation in the
  README, not on the screen. This has been the default move of several agents;
  it is not to his taste.

## The plugin model (Cordis)

DSH is composed entirely of Cordis plugins mounted into a shared context. A
plugin is a module exporting `apply(ctx, config)` (function form), or an
object `{ name, inject, apply }`, or a `Service` subclass (class form, used
when the plugin *provides* a service to others).

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'
export const inject = ['tools']        // required services; apply waits for them

export function apply(ctx: Context) {
  ctx.tools.register(/* ... */)        // registrations are effects
}
```

Key mechanics (details: `docs/cordis-tutorial/`, `docs/cordis-primer.md`,
generated API in `docs/cordis-api/`):

- **Effects**: everything registered through `ctx` (listeners, tools, slots,
  timers) is undone automatically when the plugin unloads. Wrap any resource
  managed outside Cordis in `ctx.effect(() => { ...; return disposer })`.
- **inject / PENDING**: a plugin whose `inject` names an unavailable service
  waits silently in PENDING — the #1 "my plugin prints nothing" cause
  (`docs/cordis-tutorial/06-composition-and-hmr.md`).
- **Config**: export a `Config` schema; invalid YAML config fails the load
  loudly before `apply` runs (`docs/user/develop/basic/config.md`).
- A row's `config` in a later patch layer **replaces** the whole value, no
  deep-merge.

## Loading a plugin: two ways

1. **Dev overlay** (what this repo uses day-to-day):

   ```sh
   cd <dsh-src>
   DSH_HOME=~/.dsh-preview pnpm dsh --profile web --patch <plugins>/cordis.dev.local.yml --port 3088 --no-open
   # (what the preview relay runs for you; see PREVIEWING.md)
   ```

   The overlay `insert`s rows whose `name` is an **absolute path** to the
   plugin entry module. Tutorial: `docs/user/develop/basic/index.md`.
   Verify composition without booting:
   `DSH_HOME=~/.dsh-preview pnpm dsh --profile web --patch ... --dump-config`
   (global options before the profile's own; `dsh web --patch` is rejected).

2. **Installed bundle** (stable plugins): the package declares
   `dsh.bundle.patch` in package.json (see any `plugins/*/cordis.patch.yml`)
   and is installed into a profile with
   `dsh plugin --profile <name> add ./plugins/<dir>` (pnpm-links the local
   directory; `remove` undoes it). Layer order, git installs, and the pnpm
   `allowBuilds` catch: `docs/user/develop/basic/publish.md`.
   **All twenty-two live plugins at once:** `pnpm install-plugins [--profile web]`
   (`tools/install-plugins.sh`; `pnpm remove-plugins` undoes it). Rows then
   resolve by package name from the profile's hoisted `node_modules`, so no
   patch carries an absolute path. A "superplugin" package that merely lists
   the plugins as dependencies does **not** work: pnpm never installs a
   `link:`ed package's dependencies into the profile, and the loader resolves
   rows from the profile directory (measured 2026-09-18). Never combine the
   bundle install with absolute-path `insert` rows for the same plugins —
   duplicate ids fail the boot.

## Host plugins (Node side)

Register tools, listen to agent events, provide services. Start points:

- `docs/user/develop/basic/tool.md` — the tool-definition DSL (`ctx.tools`).
- `docs/user/develop/framework/` — services, events.
- `docs/user/develop/practice/` — LLM adapters, dynamic composition.
- `docs/agent-lifecycle.md`, `docs/tool-execution-pipeline.md` — agent-loop
  events a host plugin can hook.
- Running from the source checkout, a row may point straight at a `.ts` file
  (the host runs through tsx). Built JS always works.
- Host module edits need a `dsh web` restart — a live patch-row reload re-runs
  `apply` from Node's module cache (module-source HMR is off). Client bundle
  rebuilds hot-swap on their own.

## Client plugins (Web GUI side)

The web GUI is also a Cordis tree, running in the browser. A *client plugin*
is one package with two halves:

- **Node half** (`main` / exports `"."`): loaded by the host Loader; may be an
  empty `apply` for browser-only plugins.
- **Browser half** (exports `"./client"` → `lib/client.js`): a built bundle
  the web shell fetches and mounts as a browser-side Cordis plugin.

The host scans Loader rows for packages declaring `dsh.client` in
package.json (`{ "dsh": { "client": { "platform": "web" } } }`, requires the
`./client` export) and serves their bundles under `/plugins`; the browser
boots from the injected `window.__DSH_BOOT__` graph. Subsystem doc:
`docs/subsystems/client-modules.md`.

### Client bundle format

Source of truth: `packages/client/tsdown.client.ts` (in-tree preset). Our
out-of-tree equivalent is `plugins/wait-tool/build.mjs` (esbuild).
The artifact is a CJS bundle wrapped in a factory registration:

```js
window.__ModuleLoader__.load({ id: '<package name>', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
/* ...bundled CJS... */
return module.exports; } });
```

- `id` must equal the package.json `name`.
- Only the shell's **platform modules** may remain `require()`d (externals);
  everything else must be inlined. Mirror of
  `packages/client/web/src/platform.ts`:
  `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`,
  `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`,
  `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`.
- Cross-plugin **runtime** imports of other `@deepseek-ai/*` client packages
  are forbidden; `import type {}` is fine (erased) and is how you pull in
  SlotMap/standard-prop declaration merges.
- The bundle must exist when the server boots — a `dsh.client` package with a
  missing `lib/client.js` fails activation loudly.

### Slots: contributing UI

All client UI composes through the typed slot system — `ctx.slots` in the
browser `apply`. Authoritative doc (incl. the full slot tree):
`docs/subsystems/slots.md`; house rules: `packages/client/AGENTS.md`.

```ts
export const inject = ['slots']
export function apply(ctx: Context) {
  // inject(name, cb): waits until the slot's owner declares it, re-runs on
  // redeclaration, unwinds with your plugin.
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      { name: 'conversation.input.dock', id: 'my-entry', order: 100 },
      MyComponent,
    ))
}
```

- Cardinality `list` needs a unique `id` (+ `order`); `single`/`keyed` cells
  are replacement points; `chain` elects by `select()`.
- Scope `session` gives components `sessionId`, `useSession`, `useProjection`;
  every scope gets `useSessions`, `useWorkspaces`,
  `useSessionPendingInteraction`. Conversation slots add `useConversation`,
  `useChat`, etc.
- Components never see `ctx`; type props as
  `PropsRuntime<'slot.name'>` (& store/inject/renderSlots shares as needed)
  from `@deepseek-ai/dsh-client-ui-slots`.
- Useful session state (`SessionSnapshot`, in
  `packages/api/session-controller/src/client/contract/snapshot.ts`):
  `running`, `lastAgentError`, `queue`, `blank`, `openState`.
  Pending approvals/questions: `useSessionPendingInteraction` map keyed by
  session id. Host-computed per-session values: `useProjection('<key>')`
  (`docs/subsystems/session-projection.md`).
- Live introspection: ask a running agent to call
  `cordis_inspect what:"client"` for the live slot catalog.

### Dev loop for client plugins

```sh
cd <plugins>/plugins/<plugin> && pnpm watch   # rebuilds lib/client.js on save (hot-swaps the preview GUI)
# row in <plugins>/cordis.dev.yml, `pnpm dev-overlay`, then (re)start the standing preview:
launchctl kickstart -k gui/$UID/io.github.taliesinb.dsh-web-relay.preview
```

### The preview server

Trial plugins in the **standing preview instance** — `DSH_HOME=~/.dsh-preview`,
port 3088, composed from that home's profile patch plus `cordis.dev.local.yml`,
started on demand by the relay LaunchAgent
`io.github.taliesinb.dsh-web-relay.preview`, reachable token-free from any
browser on this Mac at `https://laptop.example.ts.net/dsh-preview/`
and by the user as **DSH Preview** in the Dock — never by patching the live
config. Add rows to `cordis.dev.yml`, `pnpm dev-overlay`, then
`launchctl kickstart -k gui/$UID/io.github.taliesinb.dsh-web-relay.preview`.
**Its default model is local and dumb on purpose**: `apple/foundation` (Apple
Foundation on-device, 4K window) on the `minimal-no-tools` preset — basic text
replies only, **no tools**; LM Studio models (`minimal` preset, tools) are
the other local option. There are no cloud providers/keys in the preview home
and none should be added, so a preview session can smoke-test UI/plugin
behaviour but cannot run a real agent turn; test tool-using plugins headlessly
or in a throwaway home with forwarded credentials (PREVIEWING.md).
Full procedure, the ad-hoc `/tmp`-home alternative, credential forwarding and
HMR gotchas: [PREVIEWING.md](PREVIEWING.md).

### Verifying a client change without a GUI login

`dsh web` authenticates the browser with a per-process launch token printed
only in its terminal, so an agent's own browser usually cannot open the live
GUI. **On the development Mac this no longer holds**: with `dsh-tailscale-remote`
installed, any browser on the machine (incl. the `browser-automation` STP
windows) is admitted by the node's own Tailscale identity at
`https://laptop.example.ts.net/dsh/` (live) and `/dsh-preview/`
(preview server on its own home `~/.dsh-preview`, started on demand by its
relay; its `?token=` URL is in `~/.dsh-preview/logs/dsh-web-preview.log`) — see `recipes/dock-app-via-tailnet.md`.
Elsewhere, the fallback below still applies. Alternative used for the first client plugins: load
`lib/client.js` in Node under a fake `window.__ModuleLoader__` with stub
platform modules, capture what `apply(ctx)` registers, and replay a real
session log (`zstd -dc $DSH_HOME/sessions/<ws>/<session>/session.jsonl.zstd`)
through it.

### Type-checking against the checkout

Each plugin declares `link:` devDependencies pointing into the checkout
(`vendor/cordis`, `packages/client/ui-slots`, ...) so `pnpm typecheck` sees
the real d.ts files. Links are relative to the submodule
(`link:../../deepseek-harness/...`). `@modelcontextprotocol/sdk` and `sharp`
are ordinary npm dependencies pinned to the checkout's versions, not links into
its `.pnpm` store (since `5785d17`). esbuild does not type-check; the build
works even if types drift.

## Recipes (`recipes/`)

After completing any non-trivial DSH task — adding a provider, authoring a
plugin or preset, installing/configuring third-party plugins, infrastructure
like local model servers, diagnosing a bug — write (or update) a recipe in
`recipes/`, written so a future agent (or human) with zero session context
can reproduce or maintain it:

- One topic per file, kebab-case name (`apple-foundation-model-provider.md`,
  `cloudflare-remote-control.md`, `install-rewind-plugin.md` are examples).
- Exact paths, exact config blocks, exact commands, and the *why* behind
  non-obvious choices.
- Record what **failed** and why, not just the happy path — failed attempts
  are what save the next agent hours.
- Include a troubleshooting table when the task had failure modes.
- Cross-reference plugin READMEs rather than duplicating them.
- No real host / account / tailnet names (Ground rules): `<remote>`,
  `<user>`, `<host>.example.ts.net`; the concrete inventory and any
  per-account rollout log go into the private `extras/AGENTS.md`.
- Add the new recipe to the index below.

### Recipe index

- `nixos-thin-client.md` — the root Nix flake and Linux Electron wrapper:
  packaged runtime, saved server and desktop launcher, automatic TCP over
  WebSocket forwarding, Chromium's loopback proxy rule, occupied-port HMR,
  and Node/Electron integration checks without a live DSH.

- `anthropic-many-image-2000px-limit.md` — "many-image requests: 2000 pixels"
  400 after the 21st image of a session: Anthropic's >20-image per-dimension
  cap vs DSH's pixel-count-only `requestImagePixelBudget`, diagnosing from
  attachment metadata in the session log, the 1.15 MP per-provider setting
  in `$DSH_HOME/settings.yaml`, and why downscaling beats offloading for the
  prompt cache.
- `anthropic-new-model-before-catalog.md` — using a model newer than the
  installed pi-ai catalog via the `settings.yaml` `models` list (Fable 5.1 on
  0.84.2; Opus 5.5 on 0.85.1, 2026-09-23): reading the spec out of the newest
  published pi-ai tarball, the compat-key drift between pi-ai versions vs the
  installed `ANTHROPIC_COMPAT_GATE`, validating a candidate file through
  `assertServiceable` before copying it live, and the picker-writes-the-default
  trap. Same day: OpenAI GPT-6 Luna/Sol on the `openai` route (`"off": none`
  wire value, Responses compat gate).
- `apple-foundation-model-provider.md` — local models as DSH providers
  (LM Studio + Apple Foundation via AFM), the pi-ai token-budget trap,
  minimal presets, and the `enforce-model-preset` plugin.
- `black-screen-after-server-restart.md` — a bare dark window in the Dock
  apps (any browser) after the DSH server restarted: not the wrapper — the
  client's `/plugins/events` reconnect gets per-process `<nonce>-<n>` bundle
  revs, `entries.sync` hot-swaps every plugin in place and the React root
  crashes; the `reload-on-restart` client plugin (wraps
  `ctx.modules.entries.sync`, reloads the page when *all* known revs changed,
  passes single-bundle HMR through), the Dock-log/relay-log (local vs UTC)
  diagnosis trail, the preview-server reproduction, and per-instance
  deployment with its one-time ⌘R caveat.
- `bootstrap-mac-installer.md` — `tools/bootstrap-mac.sh`, the one-command
  fresh-machine installer (INSTALLING.md Part A + C1–C5 as sixteen idempotent
  steps: CLT, Homebrew, node/pnpm/git, STP/Chrome casks, the mandatory
  Tailscale gate (install → `tailscale up` reconnect → driven browser login),
  clone, fork + plugin builds, `~/.dsh`, bundles, afm + Apple provider, relay
  → route → Dock app); the fresh-machine abort gate and its resume marker, the
  paid-app rule (Dash never installed, its plugin gated on bundle-id
  detection — the Setapp-Dash trap; extras plugins gate through the
  manifest's `requires:`), why a `.pkg` is the wrong
  container, the headless facts it relies on, the macOS-VM landscape
  (Virtualization.framework vs UTM / Tart / VirtualBuddy) and the pending
  clean-VM test plan; `pnpm bootstrap-remote user@host` (ssh runner) and
  `--replace`, which turned the remote Mac from a deploy-remote (Path B) host into a
  standalone install while keeping `~/.dsh` — the default since 2026-09-23
  (`--no-replace` restores the fresh-machine abort), and `--instance`/`--allow` for one
  DSH per macOS user on a shared machine (Tailscale is one node per Mac, Serve
  paths are additive; 2026-09-21; the five-run log of
  what only a real run finds: ssh submodule URL, masked `runq` failures,
  lefthook vs a fresh submodule's `core.worktree`, pnpm 12 build scripts).
  Also the **thin client** (2026-09-23): the `thin-client` step /
  `--thin-client HOST` (a blue `DSH <Host>` Dock app to another Mac's
  `/dsh/<user>` via `pnpm remote-app`) and the standalone
  `tools/bootstrap-mac-thin-client.sh [HOST [USER]]` (CLT, Tailscale, node
  tarball, shallow clone, `dock-app:remote`; nothing built locally), plus why
  `bash -c "$(curl …)"` needs a `$0` placeholder word before any flags. And
  the checkout-free **uninstaller** `tools/uninstall-mac.sh [--force]`
  (LaunchAgents, this user's processes and Serve paths, apps → Trash + Dock
  tiles, global CLI; keeps `~/.dsh` and the checkouts) with the two `pgrep`
  facts it surfaced (ancestor exclusion → `-a`; the script text as argv).
- `brand-kit-plugin.md` — re-branding the Web GUI from config (`brand-kit`
  plugin, no brand built in): mark file as a CSS mask (or image) in the
  three `single` brand slots (replacing the whale AND the version chip),
  fonts served from a directory with document-relative `@font-face`,
  typography, one-hex accent re-pointing the shipped `--dsw-static-deepseek-*`
  ramp via `color-mix` on `html>body` (the theme-sheet cascade trap), the
  two locale-owned strings ("Into the Unknown", "Deep diving...") swapped in
  place by a MutationObserver; why the brand is a private *configuration
  profile* (assets + a profile-patch block) and not a plugin; a new bundle
  row taking effect live without a restart. Then the **profiles UI**: the
  bundle's Plugins-panel card (`plugins.bundle.config`) over a Fetch route
  — profiles as directories under `$DSH_HOME/brand-profiles/` (portable
  `profile.json` + assets, fflate zip export/import, staging-dir import,
  upload of mark/font files, full editor), apply = reload because
  `index-inject` is emitted per request, one asset route instead of
  registration-time exact routes, and why a dev-overlay row shows no card.
  Then the row `config` was retired: a brand is only ever a profile
  (`cli.mjs import <dir|zip> --name X --apply` for provisioning; none active
  = shipped look).
- `bundled-app-dmg.md` — the self-hosting `DSH Canary.app` (red whale) in a
  DMG (2026-09-23/24, milestones 1 + 3): why not `bootstrap-mac.sh`'s global installs and why the
  Swift wrapper rather than upstream's Electron shell; `pnpm build-app`
  (`tools/bundle/`: sha256-verified Node 24 LTS, `stage-dsh.mjs` packing all
  304 fork packages + the plugins of `plugins.txt` and installing with
  pnpm-workspace.yaml overrides, `build-app.mjs` pruning 455 MB — declarations,
  maps, `.ts` sources, other-platform prebuilds, the 259 MB LibreOffice engine
  unless `--with-office` — then signing ad-hoc and running hdiutil: 268 MB app,
  88 MB DMG); `EmbeddedServer.swift` (profile `app` created/
  merged from the bundled template, `zsh -lc` spawn, token URL from stdout,
  SIGTERM → quit) and the `app-lifeline` plugin against orphaned servers; the
  traps — `pnpm deploy` drops `workspace:^` peers, pnpm 12 ignores
  `pnpm.overrides` and silently pulls UPSTREAM's npm packages, `allowBuilds`
  keys in `@file:` form, symlinked `/tmp`, app-boot's dependency-graph BFS from
  `@deepseek-ai/dsh/package.json` (plugins anchored there), two plugins'
  incomplete `files`, hdiutil under the sandbox; sizes. **Updates**:
  `pnpm release-app` (`release.mjs`: `YYYYMMDDnn` build number →
  `CFBundleVersion`, calver display version, `gh release create canary-N`
  with the DMG + `.sha256`, `--latest`) and `Updater.swift` (GitHub
  `releases/latest` on launch + 6-hourly + Check for Updates…, prompt with
  notes, download → SHA-256 → hdiutil → `cp -R` beside the bundle → Trash →
  rename → relaunch after the old pid exits; translocation/unwritable
  preflight; `dsh.update.autoInstall` default for headless tests; measured
  with a local fake feed). Milestone 2 (first-run dialog) still designed only.
- `browser-automation-plugin.md` — per-chat Safari Technology Preview /
  Chrome windows and the isolated page reader (`browser-automation` plugin):
  why a plugin and not MCP config, the STP `--mcp` facts that shape it, the
  live profile row, the attempts that failed (incl. chrome-devtools-mcp's
  silent ≥ 2 MB screenshot spill-to-disk), and the failure-reporting layer
  (`explainFailure` / `FAILURE_HINTS`) every `safari_*`/`chrome_*` error
  passes through; "Round three" (2026-09-23, from `rsi/tool-analysis-03.md`):
  the host-side wait engine (`waiting.mjs`; `wait` on evaluate / screenshot /
  navigate, `then` on navigate, selector/expression `*_wait_for`),
  `selector`/`text` targets for click/fill/hover, reopen-after-Chrome-restart
  under the same window id, most-recently-used window default. "Round four"
  (2026-09-24): the plugin's first **browser half** — a `tool.call.toolview`
  row for `chrome_get_screenshot` / `safari_get_screenshot` so the chat card
  shows the capture instead of the image block's JSON (keyed slot, single-owner
  `tool.call.images`, own `<img>` via `loadImage`), effective at the next
  restart; the pnpm store v10→v11 purge, and the throwaway-home + copied
  session/attachment method for seeing a real recorded row.
- `chat-title-plugin.md` — the agent as reviewer of the automatic chat title
  (`chat-title` plugin, host-only): a `rename_chat` tool over
  `ctx.sessionTitle.rename` in the titler's style (read from the
  `session-title-llm` loader row; refuses in subagents), an 80-word
  system-prompt rule and a runtime-context line carrying the current
  automatic title (placeholder vs provider wording), both gated on the
  agent's scope seeing the tool so no-tools presets get nothing; why `rename`
  can only write `source.kind: 'user'` and how `tool/result.meta.chatTitle`
  tells the agent's own titles from the human's (never overridden); how the
  design moved from "agent names every chat first" to reviewer after the
  comparison with `session-title-llm`; the headless throwaway-home
  verification (titler on: no rename; titler disabled: placeholder replaced),
  the live bundle install taking effect without a restart, and the pnpm-12
  `packageManager` temp-dir trap (`node --import tsx/esm apps/cli/src/bin.ts`
  from the checkout root).
- `client-bundle-rebuild-kills-pending-prompts.md` — historical note on a
  rare `NO_PROVIDER` from `ask_user_question` right after a live client
  bundle rebuild. Not a reason to avoid rebuilding a live bundle; if it ever
  happens, just re-ask.
- `copy-sessions.md` — **Copy to…** beside every Move to… (fork `session.copy`
  + `ui-workspace` dialog; plugin `sessions.copy` / `sessions.copyAcross`,
  **Copy to remote…**): a new session with fresh ids from the source's durable
  log and lineage, the source never touched (a running agent keeps running);
  a mid-turn source is *truncated* rather than terminated — the whole turn in
  progress dropped and its queued prompt cancelled, or kept and closed with the
  interrupted-turn closers; "<title> (copy)" title, same workspace = Duplicate;
  `storeSessionLogs` shared with the cross-host import (`mode=copy`), the
  linked-plugin-build hot-swap trap, and the throwaway-home HTTP/Chrome trial.
- `cloudflare-remote-control.md` — phone remote control via dsh-full-remote
  behind cloudflared: install + profile patch, the 反向代理 locale bug and its
  root cause, the `taliesinb/dsh-full-remote` fork (`~/github/dsh-full-remote`,
  branch `tali/main`) with the reactive-locale fix and the **Tailscale route**
  feature (why port-based not `/dsh`, the tagged-node login-allowlist facts,
  the identity-header trust conditions vs cloudflared spoofing, `tailscale
  serve` CLI syntax), plus Phase 2 (named tunnel + Cloudflare Access).
- `dash-docsets-plugin.md` — Dash 8 docsets as native tools (`dash-docsets`
  plugin): the Dash HTTP API facts (port file, endpoints, anchors, FTS
  quirks), why native tools instead of Kapeli's MCP server, the in-process
  HTML→Markdown decision, install/test commands, and the failure table.
- `foreign-link-opener-plugin.md` — Dock-installed (Safari "Add to Dock") DSH
  web app opening other-port/other-host links in a new DSH window: why the
  manifest cannot fix it (web-app scope is host-only, `window.open` never
  leaves the app) and the `foreign-link-opener` plugin that hands such links
  to real Safari via `open -a`.
- `dock-app-integrated-titlebar.md` — the Dock app's title bar folded into
  the page (2026-09-22): the shipped client already carries the whole
  macOS-desktop layout behind `<html data-platform="darwin">` (Electron's
  hiddenInset strip, header controls for the closed sidebar, drag regions),
  so the wrapper sets the mark and supplies what WKWebView lacks — a
  JS→`performDrag` bridge (no `-webkit-app-region`), traffic lights moved to
  (16, 18) by resizing the title-bar container, the private `_mouseInGroup:`
  override for their rollover, `drawsBackground = false` over an
  `NSVisualEffectView` (View ▸ Window Material: Frosted / Liquid Glass), a
  thinner sidebar tint; how to test with neither Accessibility nor Screen
  Recording (own-window snapshot via `kill -USR1`, a test-copy bundle, a
  hit-test probe) and why snapshots cannot show the material.
- `dock-app-via-tailnet.md` — the DSH Dock app as a native WKWebView wrapper
  (`dsh-tailscale-remote/dock-app`) admitted by this Mac's own Tailscale
  identity, plus the always-on relay LaunchAgent that starts `dsh web` on a
  cold open: why the Safari web app broke (30-day cookie, no URL bar), why a
  web-app bundle cannot be fabricated (LS template-app data vault), why not
  GUI-scripting Safari (TCC/cdhash), the relay's "answer first, start DSH,
  self-reloading splash" trick, the proxy's Host/Origin fence and
  `ownsHost` injection, the live rollout order while the old host code still
  ran, and the Dock-plist `<data>` trap. The wrapper's menu bar also carries
  **Settings… (⌘,)**, impossible in Safari — see
  `settings-keyboard-shortcut-plugin.md`.
- `fs-tools-plugin.md` — batch filesystem tools beside the built-ins
  (`fs-tools` plugin: `list_dir` with directories, `read_many` that emits
  `fs/observed`, `edit_many` validated-before-write across files, `search` =
  ripgrep with context/files/count/include/exclude): the corpus evidence from
  `rsi/tool-analysis-02-validation.md` (bash mutates files 1.5× more than
  edit+write; `edit` 19 % error rate), how the read-guard integration works
  (`fs/edit-intent` waterfall + `fs/observed`), the headless e2e method, and
  the Cordis `inject`/HarnessError/`oneOf`/glob-anchoring traps. §3a (round
  two, 2026-09-23, from `rsi/tool-analysis-03.md`): `edit_many` `verify:
  { command }` (edit + typecheck in one call), structural ops
  (`insert_after` / `insert_before` / `replace_between` / `append`), unread or
  changed files pass through when every anchor is unique else return the
  matching regions and record the observation, freshness checked before any
  write; `search` names missing roots with the cwd.
- `import-claude-code-sessions.md` — importing Claude Code / pi transcripts
  (Supacode-era included) into DSH sessions: the `tali-import-sessions` plugin
  (`plugins/import-sessions`: device-upload or server chooser, one decision
  modal, directory-matched workspaces, working-session fold for large
  sessions, written through DSH's services), the format-v3 facts it had to
  learn (no `type` in the logical header, required `assistant/message.stream`,
  `startSeq/endSeq` replaces), the Dock-app `runOpenPanel` gap, plus the
  pre-plugin history: why Supacode keeps no transcripts, the session-log frame
  contract, the superseded `tools/` scripts, and the removed third-party
  `dsh-import-agents` plugin.
- `inline-links-remote-audit.md` — audit (no code) of what the client
  auto-links in agent output (GFM allowlist, inline-code URLs, `#L` file
  links, produced-file mentions, `WebBlock`) and what a click does, then what
  becomes of `127.0.0.1`/`localhost` links from a DSH Remote session viewed in
  the Dock app and from a `dsh-remote-workspaces` hybrid frame: loopback is
  always the *client's*, `localWebUrl` hard-codes the server's, the Browser's
  `application-origin` check is against the local origin inside the frame,
  file links stay correct via the document-relative API; the seams a fix
  would use — and the fix built on them (2026-09-23): transparent loopback
  port forwarding in the DSH Remote Dock app (`forward.mjs` upgrade route
  with the `lsof` uid guard + `PortForward.swift`; the `NWListener` EINVAL
  and multi-file `swiftc` traps; what is still unmeasured).
- `install-rewind-plugin.md` — session rewind plugin install.
- `model-titles-not-slugs-on-new-instance.md` — model-generated session
  titles come out as natural phrases instead of `foo-bar-baz` on a freshly
  bootstrapped instance (DSH Remote, 2026-09-22): the slug shape is the fork's
  `style: slug` on the in-tree `session-title-llm` row, set only in this Mac's
  `~/.dsh/profiles/web/cordis.patch.yml` and never by `bootstrap-mac.sh`; how
  to read `source.kind` from `session/title` events, the preview
  reproduction + fix, and the per-account rollout on the shared remote machine
  (live patch reload, no restart; host details stay in `extras/`).
- `notion-mcp.md` — Notion's hosted MCP server in the web profile: why DSH's
  mcp-client can't do OAuth, the `mcp-remote` stdio bridge, the one-time
  terminal login into `~/.mcp-auth`, and the sandbox/`npx` EPERM trap.
- `numbered-session-switching-plugin.md` — ⌘1…⌘5 between the five most
  recently viewed sessions, numbers in the sidebar gutter
  (`numbered-switching` plugin): the post-rebase selection facts (no
  `list.current`; current = `retainedBy.mainView`, open =
  `ctx.uiWorkspace.openSession`), row→session identity through React's
  fiber expando (rows carry no id), the badge-in-the-padding-box geometry,
  why only the WKWebView Dock app receives ⌘digit, the PID-keyed
  AX/`CGEvent.postToPid` method for testing real chords — because System
  Events resolves both same-named "DSH" apps to the LIVE one — and the
  optional coupling to `dsh-remote-workspaces` (`ctx.provide` +
  `ctx.inject` for a sibling plugin; "absent is not gone"; the same-origin
  embed frame shares `sessionStorage` and must opt out).
- `plugin-inject-string-content-bug.md` — "This turn failed: content.some is
  not a function": a host plugin passed a bare string as `agent.inject`
  `content`, poisoning the session log; the `UserMessage` shape rule, the fix
  in `browser-automation` (and its twin in an extras plugin), and the
  `repair-session-string-content.mjs` log-repair tool (zstd multi-frame and
  packed-chunk-row traps).
- `instance-identity.md` — telling the DSH / DSH Preview / DSH Remote windows
  apart (`instance-identity` plugin, host-only, plus the Dock-app wrapper):
  a `webserver/index-inject` `<style>` row renames the wordmark via
  `::before{content}` on the existing span (`display:flex;font-size:0` — the
  17.5px-strut trap), colours the whale (`fill="currentColor"`;
  `_brandMark` + the rail's `_railMark`) and dims the baked-in version chip; a
  body-placed script row rewrites `document.title` behind `DocumentTitle`; why
  the `common` locale namespace cannot be overridden; the wrapper's own
  `__DSH_DOCK__` + `!important` copy of the rules so DSH Remote reads right
  with no plugin on its server; rebuilding the three Dock apps from their
  `dsh-dock-app.json` specs.
- `per-session-qr-code.md` — a QR button in the Session header (top right)
  whose code opens *that one Session* chrome-less on a phone: the fork's
  `?embed=<sessionId>` page at the tailnet route, riding the standing token
  (or identity) — a UI feature, deliberately not a security boundary (what
  real per-session scoping of `/api` + the mux would take, and why not); the
  `conversation.session.header.utilities` slot, the proxy exchange now
  keeping the query, the `session-` prefix trap, phone-width facts, the
  `/tmp`-copy trial so the live bundle is not hot-swapped, and the `CI=true
  pnpm install` purge trap.
- `phone-ui.md` — chat-only Session chrome on phone-width viewports
  (`phone-ui` plugin, host-only `<style>` row in a `max-width` media query):
  hides the Session header + Chat/Trajectory tabs, the per-message icon
  rows and the composer stats dock (incl. the context meter) below 640px,
  in the full GUI and the `?embed` page alike, then 8px side margins (text
  and composer card on one edge), no code-block banner rows and half the
  code-block/user-bubble rounding; the `data-slot="…"` outlets as the
  unhashed hooks for chrome without attributes of its own, the DOM facts
  per target (`.md-code-block` + its radius variable, the `.scroll`
  padding formula), the **cascade trap** (client CSS is injected after the
  `index-inject` rows, so a specificity tie loses — and a console-appended
  trial hides it), the STP `safari_set_viewport_size 390×844` trial (no
  device emulation needed), the Dock apps' **View ▸ Desktop / Mobile**
  switch (`<html data-dsh-view="mobile">` from a re-registered document-start
  script + a 390×844 resize; the plugin emits every rule twice so the flag
  alone selects the phone view), the PID-keyed `ax-drive.swift` that tests
  the wrapper's menus where System Events picks the wrong "DSH", the
  **mobile composer** (browser half: bottom tongue + full-screen entry over
  `inputActions.setDraft/submit`, stop via the session's `cancel()`,
  caret memory, sheet sized to `visualViewport` because iOS covers rather
  than shrinks the layout viewport, React ignores synthetic `input`
  events), the iOS "never finishes loading" root cause (client-hmr's
  mid-load `EventSource` — deferred past `load` by a head-script shim), and
  the rest of the phone pass still open (sidebar rail, right dock).
- `private-plugins-in-extras.md` — plugins that live in the private `extras/`
  layer yet install like public ones: the manifest's `requires:` gate (any of
  app paths / bundle ids / commands, evaluated by `tools/extras-manifest.mjs`
  so no public script hardcodes a private plugin's needs) and `check:` hooks
  whose output becomes bootstrap to-dos; and the 2026-09-25 procedure that
  moved a plugin there — extract with history, relink one level deeper, hand-
  scrub the public tree, rehearsed `filter-repo` with a targeted table,
  `sync-host` reset onto a rewritten upstream, absolute-path profile links and
  the pnpm store-version trap.
- `preview-identity.md` — superseded stub (2026-09-05 red favicon + "DSH-dev"
  manifest for the Safari Dock preview; the dev-overlay/profile collision rule).
- `promotion-loop-and-duplicate-dsh-tools.md` — the two faults that made the
  live GUI blank and every tool call die after the 2026-09-18 promotion:
  a `launchctl submit` one-shot script is **keepalive by default** (an
  install→build→restart loop rewrote `apps/web/dist` under the live server
  every 25 s for an hour), and `@deepseek-ai/dsh-tools` loaded twice (src via
  tsconfig paths, lib via one row resolved through `node_modules`) so the
  module-local `TOOL_RUNTIME_SCHEDULER` symbol never matched — fixed with
  `Symbol.for` (fork commit `9384b80976`; re-apply on every rebase).
- `rebase-fork-on-upstream.md` — trialing a rebase of the `feat/embed-session`
  fork onto `upstream/master` in a separate worktree: the six conflicts and
  their resolutions (selection moved out of the Session Controller into
  ui-workspace, nested-group `renderGroup`, the transport `streamBaseUrl`
  override), the two fix-ups the new upstream gates demand (client-typecheck
  of test doubles, `gen-cordis-catalog` type/event classification), the
  throwaway-home + prefix-stripping-proxy verification of every fork feature,
  the plugin breakages it exposed (turnTail chain→list, `requestBody` on
  Fetch routes), and how to promote the trial branch.
- `reboot-command.md` — `/reboot` restarts this `dsh web` from inside a
  session (`reboot-command` plugin, both halves): the survey (no such
  command in-tree or here; the restart action lived only in the
  Tailscale-remote Server pane; the interruption logic only as move.ts's
  private `blockersOf`), the host command `/reboot now|wait|cancel` logged
  like `/compact` + a `commandUi.decorate` dialog on the bare form listing
  every session with a running turn / queued messages / background jobs /
  subagents, the host-side armed **Wait** (fires after 2 s of every session
  idle), the relay verdict via `dsh-tailscale-remote`'s new optional
  `tailscaleRemoteRelay` service (restart vs quit), the comeback poke to the
  relay's loopback URL for pages served straight from dsh's port, the
  preview verification (sleep-60 turn → Wait → clean exit → relay restart →
  reload) and the two-step live install still pending. §9 (2026-09-24): why
  Enter did nothing in the dialog (the shipped `Modal` handles Escape only and
  never moves focus off the composer) and the `dialog-keys.ts` hook — Enter
  clicks the `DIALOG_DEFAULT` primary button, focus pulled into the dialog
  past Lexical's async refocus, restored on close — copied into every plugin
  dialog with a default button (`import-api-keys`, `import-sessions`,
  `dsh-remote-workspaces`).
- `session-introspect-plugin.md` — model-facing `transcript_*` tools for
  reading *other* agents' transcripts and running tool-use studies (§2.7:
  `transcript_export`, `split_at`/`until` cohorts, adoption used/avail,
  error reactions, sequences/runs/duplicates/args) (`session-introspect` plugin: find by
  `workspace/title`, per-turn outline, timeline render, per-tool error/latency
  stats with what-happened-next, grep, raw event; `fmt` text/json/jsonl and
  `out_file` via `ctx.fs` on every tool) over `ctx.sessionQuery`; the survey
  (in-tree `tool-session-query` is unmounted and same-cwd-only; the `@session`
  mention drops tool events), the five-session evidence of agents hand-decoding
  `~/.dsh/sessions/*/session*.jsonl.zstd`, the on-disk format census and the
  `session.v3.jsonl.zstd` stale-copy trap, the headless end-to-end test method
  against a copied home, and the first corpus-wide findings (incl. 11 sessions
  the current reader refuses).
- `session-title-slug-plugin.md` — name a New Session at creation by starting
  its first prompt with `some-slug: ` (`session-title-slug` plugin): the
  survey of why the blank row's label is unreachable through data (blank
  until `turn/start`, `single` browser slot, one-owner locale namespaces) and
  hence a DOM preview; why the rename waits for the local `blank` flip and
  reads the submission echo, not the draft or input phase; the
  `SSH_TTY` trick that keeps the preview's directory picker in the browser.
- `shared-host-providers-and-keys.md` — cloud providers + API keys on every
  DSH instance of a shared machine: how DSH stores them (`settings.yaml`
  `llm-pi-ai.providers.<id>.apiKeyEnv` → `.credentials.yaml` `refs.<NAME>`,
  mode 600, both chokidar-watched so no restart), why the anthropic row is a
  catalog restatement (pi-ai 0.85.1 lacks Opus 5.5), the private
  `dsh-set-providers` rollout tool's rules (replace anthropic, keep existing
  refs/defaults, keys over ssh stdin never argv), the leftover-free headless
  smoke test under a temporary `DSH_HOME`, and two new-account traps: deploy
  keys before the bootstrap, and `install-plugins.sh`'s `EXTRA_DIRS[@]:
  unbound variable` under macOS bash 3.2 (fixed `95e3335`).
- `settings-keyboard-shortcut-plugin.md` — ⌘. toggles the web GUI Settings
  panel (`settings-shortcut` plugin): why ⌘, is impossible in Safari (the
  app consumes it before the page), the component-local open state that
  forces DOM clicks on `[hash]_[local]` class selectors, and how to test a
  chord with a real System Events keystroke instead of a synthetic one —
  plus (2026-09-22) ⌘, in the WKWebView Dock apps: a real Settings… menu
  item whose action feeds the plugin its ⌘. chord synthetically, with the
  DOM-click fallback for servers without the plugin, tested by PID-posted
  `CGEvent`s.
- `stuck-loading-history-on-session-switch.md` — "Loading history…" forever
  when switching to a mid-turn session in the Dock app: root cause is
  `dsh-util-values` comparing `Function.prototype.toString(Object)` to V8's
  one-line `[native code]` literal, which JavaScriptCore renders multi-line,
  so every object failed the lossless-JSON test and the mid-turn
  assistant-stream baseline threw (fork `319dcb8a56`); plus fork
  `1ab8de08d2` so `doOpen` never leaves `openState='loading'` (local faults
  → `'error'` + `console.error`, 15 s/30 s opening watchdog). The
  `openState` state machine down to the multiplexed socket, why Chrome
  could not reproduce it, the util-values `lib/index.js` host-face
  rebuild trap, and the hot-swap caveat when rebuilding
  `session-controller/lib/client.js`.
- `tailscale-remote-plugin.md` — the DSH GUI at `https://<node>/dsh/` over the
  tailnet: the from-scratch `dsh-tailscale-remote` plugin (loopback proxy +
  `tailscale serve --set-path /dsh` + "Tailscale remote" settings section with
  Enable/Disable, URL, allowed-user list, tokened QR), the DSH branch
  `fix/tailscale-mounting` (document-relative Host URLs; why a worktree), the
  measured Tailscale path-strip facts, and the trailing-slash trap. Ports and
  the Dock app / relay moved on in `dock-app-via-tailnet.md`. Since 2026-09-21
  also the `sessionOwners` service (`owners.mjs`): which tailnet login drives
  which session, joined from the proxy's identity headers and the session ids
  in `POST /api/session/*` bodies — and the Typert wire-shape trap (`args`
  keyed by parameter name) that had left the Server pane's session column
  empty.
- `transcript-grace-margin.md` — visible "end of transcript" space under the
  last row of an active session (`transcript-grace-margin` plugin, host-only):
  why the shipped client leaves only 16px under a 36px composer fade band,
  the two unhashed hooks (`data-conversation-scroll`, `data-chat-flow`) vs
  the `<hash>_<local>` classes, why padding on the column is safe for
  ChatView's auto-follow / back-to-bottom / turn navigation, the
  console-first verification on the preview and the relay's boot-on-demand
  503.
- `wait-tool-plugin.md` — a `wait` tool replacing bash `sleep N`
  (`wait-tool` plugin, both halves): the model states the duration, so the
  chat draws a live progress bar with **Skip** (returns early, worded as the
  timeout having elapsed) and **Abort** (an error, "user aborted sleep", so
  the model stops and asks); the `status`/`control` Fetch routes with
  session-ownership checks and the server-clock offset, the `defineTool`
  output-DSL trap (`required: true` per property, no array), and why a
  cancelled turn must be thrown as a coded `ABORTED` HarnessError (rejecting
  with `signal.reason` logs `Error: [object Object]`); the throwaway-home +
  Chrome trial that exercised all four settlements.

Recipes of the private plugins live in `extras/recipes/` and are indexed in
the extras README.

## Doc map (checkout-relative)

| Topic | Path |
|---|---|
| First plugin, tools, config, packaging | `docs/user/develop/basic/` |
| Services & events | `docs/user/develop/framework/` |
| Cordis hands-on tutorial | `docs/cordis-tutorial/` |
| Cordis API reference (generated) | `docs/cordis-api/` |
| Architecture & profile/bundle layering | `docs/architecture.md` |
| Config schema catalog (all shipped plugins) | `docs/config-catalog.md` |
| Tool catalog | `docs/tool-catalog.md` |
| Web client architecture | `docs/subsystems/web-client.md` |
| Slots (full tree + rules) | `docs/subsystems/slots.md` |
| Client module system / dsh.client | `docs/subsystems/client-modules.md` |
| Conversation nodes (chat rendering) | `docs/subsystems/conversation.md` |
| In-tree client house rules | `packages/client/AGENTS.md` |
| Client bundle preset (format truth) | `packages/client/tsdown.client.ts` |
| CLI flags, profiles, layer precedence | `apps/cli/reference/README.md` |

## The optional `extras/` submodule

symbolica-ai/dsh-extras (private): deployment inventory, host scripts, and
private plugins — vendored directories or nested pins under
`extras/plugins/`, each with its recipes under `extras/recipes/` and its
blurb in the extras README. Everything that names a host, tailnet, login or
internal repo goes there, never here; so does any plugin that should not be
public. Missing = fine (no org access); the tooling continues without it.
Manifest `extras/dsh-extras.yml`, read by `tools/extras-manifest.mjs`: per
plugin `path`, `bundle`, `install`, an optional `requires:` gate (any of app
paths / bundle ids / commands — the reader evaluates it, installers only see
`ok` or `missing:<what>`) and an optional `check:` hook whose output the
bootstrap turns into to-do items; see recipes/bootstrap-mac-installer.md.

# AGENTS.md — tali-dash-plugins

Tali's out-of-tree work on DeepSeek Harness (DSH): **plugin code** under
`plugins/`, **recipes** (one Markdown file per completed setup/change) under
`recipes/`, and helper scripts under `tools/`. This file is the onboarding
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
| `<plugins>` | **this repo** | All plugin code (`plugins/<name>/`), recipes (`recipes/`), helper tools (`tools/`), the dev overlay `cordis.dev.yml` |
| `<dsh-src>` | the DSH **source checkout** (the git clone that `pnpm dsh web` runs from) | Read-only reference for APIs, docs (`docs/`), shipped presets. Never fork/patch it to add features; extend via plugins |
| `$DSH_HOME` | the DSH home, default `~/.dsh` | Configuration, not code: `settings.yaml` (providers, models), `.agent-presets/`, `profiles/web/cordis.patch.yml` (which plugins the live web GUI runs), `sessions/`, `attachments/` |
| `<recipes-ws>` | Tali's **recipes workspace** — a code-free directory used as a session cwd whose `AGENTS.md` just points here | Nothing; recipes live in `<plugins>/recipes/` |

All doc paths below are relative to `<dsh-src>`. **Verify APIs against the
checkout** before relying on this file — it is a summary, the checkout is the
truth. Recipes spell out the concrete `~`-relative paths of the machine they
were written on; map them onto the symbols above when you are elsewhere.

Absolute paths are unavoidable in two places and are tolerated there:
`cordis.dev.yml` rows (`name:` must be an absolute module path) and the
`link:` devDependencies each plugin uses for type-checking — regenerate both if
the checkout or this repo moves. The repo is **not** local-only: it is pushed
to `origin` (https://github.com/taliesinb/dsh-plugins), so commit finished
work and `git push`; anything machine-specific (those absolute paths, `~`
paths in recipes) is documented as such rather than assumed.

## Permissions (deliberate — do not "fix")

Sessions started from `<recipes-ws>` have `workspace-write` over that
directory only. Writing plugin code or recipes into `<plugins>` (or config
into `$DSH_HOME`) triggers one approval escalation per operation — **that is
Tali's chosen setup** (decided 2026-09-05). Do not try to widen the sandbox:
the DSH file policy is single-root by design (`workspaceRoot` = session cwd;
enforcement is canonicalize-then-contain, so symlinks don't help; no plugin
seam exists, and shell writes enforce the same roots at the OS level). Just
attempt the write and let the approval prompt do its job. If approvals are
disabled in a session, a denial is final.

## Ground rules

- Plugins are developed **out-of-tree** (this repo). Never fork/patch DSH to
  add a feature: "There is no privileged core to patch: you extend dsh by
  mounting a plugin beside the others" (`docs/architecture.md`).
- Layout: one plugin = one directory under `plugins/`, each an installable npm
  package. `cordis.dev.yml` at the repo root is the dev overlay that loads all
  of them by absolute path.
- The recipe owns the system-level story; the plugin README owns the plugin.
  Cross-reference rather than duplicate.

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
   pnpm dsh web --patch <plugins>/cordis.dev.yml
   ```

   The overlay `insert`s rows whose `name` is an **absolute path** to the
   plugin entry module. Tutorial: `docs/user/develop/basic/index.md`.
   Verify composition without booting: `pnpm dsh web --dump-config --patch ...`.

2. **Installed bundle** (stable plugins): the package declares
   `dsh.bundle.patch` in package.json (see any `plugins/*/cordis.patch.yml`)
   and is installed into a profile with
   `dsh plugin --profile <name> add ./plugins/<dir>` (pnpm-links the local
   directory; `remove` undoes it). Layer order, git installs, and the pnpm
   `allowBuilds` catch: `docs/user/develop/basic/publish.md`.

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
out-of-tree equivalent is `plugins/agent-status-indicator/build.mjs` (esbuild).
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
cd <plugins>/plugins/<plugin> && pnpm watch   # rebuilds lib/client.js on save
cd <dsh-src> && pnpm dsh web --patch <plugins>/cordis.dev.yml
```

### The preview server (isolated sandbox)

Trial plugins in a second `dsh web` instance against a throwaway `DSH_HOME` —
never by patching the user's live config. Command, credential forwarding,
tokened-URL and HMR gotchas: [PREVIEWING.md](PREVIEWING.md).

### Verifying a client change without a GUI login

`dsh web` authenticates the browser with a per-process launch token printed
only in its terminal, so an agent's own browser usually cannot open the live
GUI. Alternative used in `recipes/wolfram-kernel-supervisor.md`: load
`lib/client.js` in Node under a fake `window.__ModuleLoader__` with stub
platform modules, capture what `apply(ctx)` registers, and replay a real
session log (`zstd -dc $DSH_HOME/sessions/<ws>/<session>/session.jsonl.zstd`)
through it.

### Type-checking against the checkout

Each plugin declares `link:` devDependencies pointing into the checkout
(`vendor/cordis`, `packages/client/ui-slots`, ...) so `pnpm typecheck` sees
the real d.ts files. Links are absolute paths — regenerate if the checkout
moves. esbuild does not type-check; the build works even if types drift.

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
- Add the new recipe to the index below.

### Recipe index

- `agent-status-indicator-plugin.md` — floating animated status/tool icons in
  the chat area (`agent-status-indicator` plugin), its document-type icon
  pipeline, and how to rebuild/preview it.
- `anthropic-many-image-2000px-limit.md` — "many-image requests: 2000 pixels"
  400 after the 21st image of a session: Anthropic's >20-image per-dimension
  cap vs DSH's pixel-count-only `requestImagePixelBudget`, diagnosing from
  attachment metadata in the session log, the 1.15 MP per-provider setting
  in `$DSH_HOME/settings.yaml`, and why downscaling beats offloading for the
  prompt cache.
- `anthropic-new-model-before-catalog.md` — using a model newer than the
  installed catalog.
- `apple-foundation-model-provider.md` — local models as DSH providers
  (LM Studio + Apple Foundation via AFM), the pi-ai token-budget trap,
  minimal presets, and the `enforce-model-preset` plugin.
- `browser-automation-plugin.md` — per-chat Safari Technology Preview /
  Chrome windows and the isolated page reader (`browser-automation` plugin):
  why a plugin and not MCP config, the STP `--mcp` facts that shape it, the
  live profile row, the attempts that failed (incl. chrome-devtools-mcp's
  silent ≥ 2 MB screenshot spill-to-disk), and the failure-reporting layer
  (`explainFailure` / `FAILURE_HINTS`) every `safari_*`/`chrome_*` error
  passes through.
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
- `import-claude-code-sessions.md` — migrating Supacode/Claude Code transcripts
  (and their project memory) into DSH sessions: why Supacode keeps no
  transcripts, the session-log frame contract, the converter tool in
  `tools/`, and the installed `dsh-import-agents` plugin alternative.
- `install-rewind-plugin.md` — session rewind plugin install.
- `notion-mcp.md` — Notion's hosted MCP server in the web profile: why DSH's
  mcp-client can't do OAuth, the `mcp-remote` stdio bridge, the one-time
  terminal login into `~/.mcp-auth`, and the sandbox/`npx` EPERM trap.
- `plugin-inject-string-content-bug.md` — "This turn failed: content.some is
  not a function": a host plugin passed a bare string as `agent.inject`
  `content`, poisoning the session log; the `UserMessage` shape rule, the fix
  in `browser-automation`/`wolfram-kernel-supervisor`, and the
  `repair-session-string-content.mjs` log-repair tool (zstd multi-frame and
  packed-chunk-row traps).
- `preview-identity.md` — red icon + "DSH-dev" label for the preview server,
  and the dev-overlay/live-profile collision rule.
- `settings-keyboard-shortcut-plugin.md` — ⌘. toggles the web GUI Settings
  panel (`settings-shortcut` plugin): why ⌘, is impossible in Safari (the
  app consumes it before the page), the component-local open state that
  forces DOM clicks on `[hash]_[local]` class selectors, and how to test a
  chord with a real System Events keystroke instead of a synthetic one.
- `tailscale-remote-plugin.md` — the DSH GUI at `https://<node>/dsh/` over the
  tailnet: the from-scratch `dsh-tailscale-remote` plugin (loopback proxy +
  `tailscale serve --set-path /dsh` + "Tailscale remote" settings section with
  Enable/Disable, URL, allowed-user list, tokened QR), the DSH branch
  `fix/tailscale-mounting` (document-relative Host URLs; why a worktree), the
  measured Tailscale path-strip facts, and the trailing-slash trap.
- `wolfram-kernel-supervisor.md` — per-chat Wolfram/Mathematica kernels
  (`wolfram-kernel-supervisor` plugin): the Pi `wolfram_Show`/rho archaeology,
  why the paclet fork's Show tool is obsolete, `wolfram_show`'s user-only image
  path (presentationMeta + pinned turn-tail gallery + plugin fetch route, and
  the gallery's skip rules for error-box renders / duplicate attachments), the
  SIGTERM-immune kernel and its kill ladder, and the client-plugin gotchas.

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

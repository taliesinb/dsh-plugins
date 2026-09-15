# Wolfram kernel supervisor for DSH (`wolfram-kernel-supervisor` plugin)

Per-chat Wolfram Language kernels in the DSH web GUI, with `wolfram_show`
rendering plots **inline to the user at retina resolution** while the model
receives one line of text — the DSH successor of the Pi `wolfram_Show` tool +
rho `show.ts` pair. Done 2026-09-14; verified end-to-end in an isolated
preview server driven through Chrome.

Plugin code + README: `~/github/tali-dash-plugins/plugins/wolfram-kernel-supervisor/`.
This recipe owns the system-level story, the archaeology, and the gotchas.

## TL;DR — install / use

```sh
cd ~/github/tali-dash-plugins/plugins/wolfram-kernel-supervisor
pnpm install && pnpm run typecheck && pnpm run build     # lib/client.js must exist before a server loads the plugin
pnpm run live:kernels                                    # 13 assertions against real kernels, incl. zero-leak
```

- Dev overlay row (already in `~/github/tali-dash-plugins/cordis.dev.yml`):
  `- id: tali-wolfram-kernel-supervisor` / `name: '/Users/tali/github/tali-dash-plugins/plugins/wolfram-kernel-supervisor/index.js'`.
- Live web profile (**not done — hot-reloads the running server; only on request**):
  `dsh plugin --profile web add ~/github/tali-dash-plugins/plugins/wolfram-kernel-supervisor`
  or the same row in `~/.dsh/profiles/web/cordis.patch.yml`.
- Tools: `wolfram_eval`, `wolfram_run`, `wolfram_show`, `wolfram_symbol`,
  `wolfram_lint`, `wolfram_kernel_open/close/list`. Kernel ids `wl:M:N`
  (session M, kernel N), default = the chat's last-started kernel. Table in the README.
- Requirements: Mathematica 15+ at `/Applications/Wolfram.app` with the
  `Wolfram/AgentTools` paclet installed (`~/Library/Wolfram/Paclets/Repository/Wolfram__AgentTools-*`;
  the highest version is used — currently the 2.2.7 fork build, but the stock
  paclet works identically since the fork's `Show` tool is no longer used).

## 1. What existed in the Pi world (archaeology)

Three repos, one of which was not mentioned in the request:

| Piece | Where | Role |
|---|---|---|
| MCP server | **Mathematica 15's own `Wolfram/AgentTools` paclet** (`Wolfram`AgentTools`StartMCPServer[]`, stdio, newline-delimited JSON-RPC, protocol `2025-06-18`) | The kernel *is* the MCP server. Server profile `WolframLanguage` (env `MCP_SERVER_NAME`) exposes `WolframLanguageContext`, `WolframLanguageEvaluator`, `ReadNotebook`, `WriteNotebook`, `SymbolDefinition`, `CodeInspector`, `TestReport`. |
| Verification suite + fast launch | `~/github/wolf-mcp` (`src/client.ts`, `test/mcp.test.ts`, `README.md`) | Bun tests; measured that `-nopaclet` + `PacletDirectoryLoad[<AgentTools dir>]` cuts `initialize` from ~3.3 s to ~1.3 s (kernel boot 2.7 s → 0.6 s). |
| Pi bridge | `~/github/wolf-mcp/pi-extension/index.ts` (symlinked at `~/.pi/agent/extensions/wolfram`) | Pi has no MCP client, so the extension spawns the kernel with `@modelcontextprotocol/sdk` `StdioClientTransport`, runs `tools/list`, and registers each tool as `wolfram_<Name>`; results are flattened to text. One kernel per session, closed on `session_end`. |
| **`wolfram_Show`** | **`~/github/WolframAgentTools`** — your fork of `WolframResearch/AgentTools` (remote `taliesinb/AgentTools`), file `Kernel/Tools/Show.wl`, registered in `Kernel/Tools/Tools.wl` and both server profiles in `Kernel/DefaultServers.wl`; built + installed as paclet 2.2.7 (`~/Library/Wolfram/Paclets/Repository/Wolfram__AgentTools-2.2.7`) | Server-side tool: `ToExpression` → `Rasterize[expr, ImageResolution -> 144]` → PNG bytes → `~/Library/Wolfram/AgentToolsShow/<YYYY-MM-DD-HH-MM-SS>-<8 hex md5>@2x.png` → returns **one JSON object** `{type:"image", source:"WolframShow", path, format, devicePixels:{width,height}, points:{width,height}, resolution:144, scale:2, bytes}`. An earlier `open` argument (system viewer) was removed once inline display worked. Runs in the *server* kernel (unsandboxed file writes), so it could not see evaluator-session variables. |
| Inline display | `~/github/rho/extensions/show.ts` + `lib/image.ts` (TUI only) | `tool_result` interceptor: any tool whose result text is JSON with `type:"image"` and string `path` is auto-shown as a `rho.image` custom entry (transcript only, **never LLM context**); the model receives a one-line replacement (`displayed <path> (WxH). shown to the user inline already; do not call the show tool for this.`), optionally prefixed with U+2063 so a patched `ToolExecutionComponent.render` hides the tool row. `scale` from the JSON sizes the baked border; `@Nx` filename tag is the fallback. |
| Web GUI (pi-web) | `~/github/pi-web/src/client/src/toolIcons.json` (`"wolfram_": "svg:wolfram"`) | Only a tool icon. pi-web never rendered the image; inline display was TUI-only. |
| Fork's fast launch | `Kernel/MCPServerObject.wl` commit `3627e30` | `JSONConfiguration` emits the `-nopaclet` args so `InstallMCPServer["ClaudeCode", …]` configs are fast too. |

Key design properties worth preserving: (a) the user sees the image, the model
gets one line and pays no image tokens; (b) retina (@2x) assets sized by
*points*, not device pixels — the TUI "half size" bug came from dividing by
scale; (c) the model is told not to re-show the image; (d) a warm kernel per
session, fast launch.

## 2. What DSH already provides (verified in `~/github/deepseek-harness`)

| Fact | Source | Consequence |
|---|---|---|
| `@deepseek-ai/dsh-mcp-client` bridges stdio MCP servers; tools appear as `mcp__<serverName>__<Name>`; config has `command`, `args`, `env`, `cwd`. | `docs/config-catalog.md`, `notion-mcp.md` recipe | Phase 0 needs no code. `MCP_SERVER_NAME` goes in `env` (DSH scrubs the parent env of `*KEY*/*TOKEN*/DSH_*` only). |
| mcp-client decodes MCP `image` content blocks (PNG/JPEG/WebP/GIF, canonical base64) into durable attachments (`ctx.attachments.saveImages`) and projects `{type:'image', attachment}` blocks **into the model-visible content** — but only after checking the current model declares `image` input; otherwise a text diagnostic. | `packages/mcp/mcp-client/src/tools.ts` (`prepareImageProjection`, `resolveImageAdmission`) | Graphics reach the *model* for free. |
| **The web GUI renders tool-result images only for a tool with a keyed toolview.** The generic card flattens non-text blocks as pretty JSON (`resultText`). Design note: "Render the image on the generic fallback too — the slot design cannot… future image tools register their own." | `.agents/notes/implemented/feature/2026-08-20-tool-card-image-results.md`, `packages/client/ui-tool/src/client/tool/models/tool-call-model.ts:117` | A **client plugin** is required for inline display. This is also why the browser-automation plugin's "INLINE" screenshots show as JSON in the card (it has no client half). |
| A keyed toolview registers into `tool.call.toolview` with `key: '<toolName>'` and receives `block` (call/result node incl. `content` and `meta`), `cwd`, `home`, and **`loadImage(ref) → Promise<url>`** (session-authorized). `tool.call.images` (the shared gallery) is a *child slot owned by the read_image entry*; declaring it again throws at load. | `packages/client/ui-tool/src/client/contract/slots.ts`, `toolviews/read-image-row.tsx` | Our toolview renders its own `<img src={await loadImage(ref)}>`; no need for the gallery slot. |
| `output.presentationMeta(args, value)` is a pure projection persisted to the session log and exposed to the client as `block.meta`; it is **not** part of the model-visible content (`output.render` is). Computed for top-level calls only. | `packages/core/tools/src/index.ts:210`, `read-image.ts:236` | This is the DSH equivalent of rho's "transcript-only custom entry": put the attachment ref in `meta`, return one line from `render`. |
| `finalizeContent(exec, result)` lets a tool swap the model-visible content after the fact (browser-automation's `inlineFinalizer` prepends `{type:'image', attachment}`). | `curated-tools.mjs:878` | Optional `see: true` path that also hands the image to the model. |
| Client-plugin template: two-halves package (`main` + `./client` → `lib/client.js`, `dsh.client.platform: web`), esbuild bundle wrapped in `window.__ModuleLoader__.load`, externals = shell platform modules only. | `tali-dash-plugins/AGENTS.md`, `plugins/agent-status-indicator/build.mjs` | Copy that build. |
| Host-side MCP stdio helper already written: `connectServer` / `callRaw` / `callText` / `imageOf` / `parseJsonText`. | `tali-dash-plugins/plugins/browser-automation/servers.mjs` | Reuse (copy or extract to a shared file). |

### Live probes (kernel `/Applications/Wolfram.app/Contents/MacOS/wolfram`, paclet 2.2.7, fast launch, via `wolf-mcp/src/client.ts`)

- `initialize`: **1.8 s**. First `WolframLanguageEvaluator` call: 6 s (Chatbook stack autoload); subsequent calls fast.
- `WolframLanguageEvaluator` returns `[ {text:"Out[1]= "}, {type:"image", mimeType:"image/png", data:<base64>}, {text:"<system-reminder>Pass session=\"…\"…"} ]` for any graphics result. **The stock tool already ships graphics as MCP image blocks** (`Kernel/Server/Shared.wl` `graphicsToImageContent`: `If[ImageQ@g, g, Rasterize@g]`).
- Sizing is deterministic and retina works inside the sandboxed evaluator kernel:
  `Rasterize[Graphics[Disk[], ImageSize->100], ImageResolution->72]` → 100×100;
  `… ImageResolution->144` → **200×200**; bare `Graphics[Disk[], ImageSize->100]` → 200×200 (server default is already @2x).
- The evaluator's `session` id persists definitions across calls.
- **Parallel kernels:** 3 MCP servers started concurrently (`initialize` + first eval for all three in 2.7 s), `$LicenseType` "Professional", no license refusal — and at the time 23 stray kernels were *also* alive (see §6), so the license imposes no practical concurrent-kernel cap here. Each server process is ~160 MB RSS plus its sandbox evaluator kernel.
- **Scripts inside the sandbox:** `Get["/tmp/x.wls"]` on a file with a `#!/usr/bin/env wolframscript` first line works; `Print` output is captured ("During evaluation of In[1]:= …"), the last expression is returned as `Out[1]=`, and definitions made by the script persist in the evaluator `session`. `$ScriptCommandLine` is `{}` inside the sandbox (set it explicitly before `Get` when a script expects arguments). File writes from the sandbox work (`Export` to `/tmp` → `True`), so the evaluator kernel is *not* filesystem-restricted.
- **Shutdown semantics (decides the supervisor's kill ladder):** the server exits within 250 ms on **stdin EOF** or a bare `Quit` line (`Kernel/Server/Local.wl` `stdinShutdownQ`), but **ignores SIGTERM and SIGINT completely** (alive after 10 s); only SIGKILL works. This is why the machine had 23 orphaned kernels: the MCP SDK's `StdioClientTransport.close()`, Claude Code, and the Pi bridge all stop servers with SIGTERM.

**Consequence: the paclet fork's `Show` tool is no longer needed.** `wolfram_show` can be
`WolframLanguageEvaluator` with `Rasterize[<expr>, ImageResolution -> 144]` in the
*same evaluator session*, which is strictly better than the fork (it can plot
variables the agent defined earlier). Keep the fork only if you want the
timestamped `@2x.png` files on disk for other tools — the plugin can write those
itself from the base64.

## 3. Architecture as built

```
plugins/wolfram-kernel-supervisor/
├── index.js           host: Config, per-agent tool attach (agent/created|disposed), image fetch route, admission helpers
├── kernels.mjs        KernelSessions: wl:M:N registry, default rule, spawn+bootstrap, idle timers, orphan scan; evaluate()
├── servers.mjs        custom MCP stdio transport around child_process.spawn (SDK Client on top) + the kill ladder
├── tools.mjs          the 8 tool definitions (defineTool DSL), PNG/IHDR + filename helpers
├── src/client/index.tsx  keyed toolviews (wolfram_show / wolfram_eval / wolfram_run) + turn accumulator + pinned gallery
├── scripts/live-kernels-test.mjs, scripts/smoke-config.mjs
└── build.mjs, cordis.patch.yml, package.json (dsh.bundle.patch + dsh.client.platform=web)
```

### The image path (why it looks the way it does)

1. **Host** `wolfram_show`: `Rasterize[(expr), Background -> None, ImageResolution -> 144]` (transparent PNG) via the stock
   `WolframLanguageEvaluator` in the chat's kernel/session (so it can plot variables from
   `wolfram_eval`); decode the MCP `image` block; `ctx.attachments.saveImages` (no model
   gate); write `~/Library/Wolfram/DeepseekHarness/<YYYY-MM-DD-HH-MM-SS>-<md5:8>@2x.png` (the Pi-era `AgentToolsShow` name was retired);
   `output.render` → one line (`[wl:0:0] displayed …: 720x462 px = 360x231 pt (@2x), <path>.
   Shown to the user inline already; do not call read_image or wolfram_show on it again.`);
   `output.presentationMeta` → `{attachment, points, devicePixels, scale, path, label, kernelId}`.
2. **Client toolview** (`tool.call.toolview`, key `wolfram_show`): renders `<img width={points.width}>`
   → a @2x asset displays at Mathematica's on-screen size (the Pi TUI "half size" bug came from
   dividing by scale twice; never divide again).
3. **Fold problem**: in the default *compact* transcript, DSH folds a settled turn's tool rows into
   a "N tool calls" disclosure (`ChatNodeSeat.tsx`, `TURN_PROCESS_INDEPENDENT_KINDS`), which hides the
   image the moment the answer lands (Settings → General → Transcript view = full disables the fold,
   but that is a user preference, not something a plugin should flip). Fix: a turn-scoped
   `ConversationNodeDefinition` (kind **`wolframShown`**) collects successful `wolfram_show`
   `tool/result` events' `meta`, and a `conversation.chat.turnTail` chain entry renders them as a
   pinned gallery under the final answer — the turn-tail node is never folded. Pattern copied
   from `packages/client/ui-deliverables`. **Pinning rule (2026-09-15):** the accumulator
   skips results with `meta.errorImage === true` (pink error box — the host only *warns*, the
   result is not `isError`) and results whose `attachment.attachmentId` (content-addressed
   sha256) is already pinned in the turn. Both are debug artefacts of a model retrying; they keep
   their tool rows in the fold. Without this a "make a 3d plot" turn pinned 4 images (3 broken
   attempts, one a pixel-identical `see: true` re-show) above the answer.
4. **Bytes problem**: the core's `session/attachment` read authorizes only references found in
   *content* image blocks (`packages/api/session-controller/src/commands.ts` `imageInEvent`);
   a meta-only reference answers `Image is not referenced by this session`. Fix: the host
   registers `GET /api/wolfram/shown?sessionId=&attachmentId=` through `ctx.connection.fetch.register`
   (behind the normal browser auth/trust checks), authorizing by scanning the session's events
   (live: `ctx.sessions.get(id).snapshotEvents()`; cold: `ctx.sessionQuery.observeSession(id,
   {projectionMode:'none'})`) for a `tool/result` whose `meta.attachment.attachmentId` matches,
   then `ctx.attachments.readImage(ref)`. Same-origin `<img src>` sends the cookie; no loader.
   Content-block images (`wolfram_eval` plots the model also received) still use the standard
   `loadImage` owner prop.

### Appearance (light/dark)

Mathematica 15 has a front-end-session setting `LightDark` (`Automatic | "Light" | "Dark"`) that
Plot themes, Grid frames, text colour and Rasterize's page fill follow, plus `DarkModePane[expr]`
for one-off dark rendering. Setting it must go through `UsingFrontEnd[...]` in the sandbox kernel
(bare `CurrentValue[$FrontEndSession, …] = …` fails with `FrontEndObject::notavail`). The host
pins it once per kernel at bootstrap from DSH's theme: settings namespace `ui-theme`, field
`preference` (`light|dark|system`, absent = `system`), with `system` resolved by
`defaults read -g AppleInterfaceStyle` (prints `Dark` only in dark mode). Measured: Plot page fill
255 (light) → 25 (dark). `wolfram_show` additionally rasterizes with `Background -> None`, so the
PNG is transparent and a bare `Graphics` no longer arrives on a white plate; `background: opaque`
restores the kernel's page colour. Host module changes need a `dsh web` restart — a live patch-row
reload re-runs `apply` from Node's module cache (module-source HMR is off).

### Interactive Manipulate (added 2026-09-14)

All Wolfram code now lives in `plugins/wolfram-kernel-supervisor/kernel/DSHPlugin.wl`, `Get`'d at kernel
bootstrap (`DSHPlugin\`ShowRasterizer` — HoldAllComplete, `Render`, `RunScript`). `ShowRasterizer` matches a
top-level `Manipulate[body, controls…]`, parses the simple control specs as Manipulate does (variable part
held, everything else evaluated), stores `HoldComplete[body]` + specs under an id, `Print`s a
`DSH-MANIPULATE:{json}` line (the host strips it from the model-visible text and puts the descriptor in
`presentationMeta`) and returns the initial frame. The client draws native controls (`<input type=range>`,
chips, `<select>`, checkbox); on release it fetches `GET /api/wolfram/manipulate?sessionId&kernelId&id&values`
(host validates values against the descriptor, `DSHPlugin\`Render[id, values]` substitutes via rules on the
held body and rasterizes, ~55 ms) and swaps the `<img>` to the returned blob. One request in flight, latest
value wins; 410 when the kernel is gone. Verified in the preview: slider + setter → 3 renders at ~100 ms each.

### Guarded rendering, timing, live previews (added 2026-09-14)

`kernel/DSHPlugin.wl` `evalAndRasterize`: body under `TimeConstrained` + `Check` + `` Internal`AddHandler["Message", h] ``
(bracketed by `` Internal`WithLocalSettings ``, from `~/github/CoreTools/Prelude/PreTracing.wl` `TraceLoading`), rasterize
under its own `TimeConstrained`; messages or timeout ⇒ no raster, structured failure with message texts. Facts learned:
the handler receives `Hold[Message[…], printedFlag]` where the flag is `False` for *every* message in the sandbox kernel,
and it also fires for internally `Quiet`ed messages (`OptionValue::nodef` floods from Plot), so `$MessageList` (issued,
non-Quiet only) is the filter and the handler only supplies text; `Power::infy`-style texts live on `General::tag`;
message arguments arrive as `HoldCompleteForm[…]` — format with `ToString[Unevaluated[e], InputForm]` (Unevaluated as the
*argument*, not as a `ReplaceAll` result, which re-evaluates). `ErrorImageQ` (MathTools) flags pink error boxes.
`DSH-SHOW:{ok, evalMs, rasterMs, totalMs, messages, timedOut, errorImage}` is printed per render; the host adds host
round-trip. Live preview: kernel total < 50 ms ⇒ slider drags render every 150 ms (throttle with trailing edge; a pure
debounce rendered once per drag — measured). Warm numbers: eval 9–11 ms, raster 19–35 ms, round trip ~125 ms; cold kernel
first Plot: eval 6 s, raster 1.2 s. When re-`Get`ting the package in a long-lived kernel, `ClearAll["DSHPlugin`*",
"DSHPlugin`Private`*"]` first — stale rules otherwise shadow edits.

### Label trees and the transport benchmark (added 2026-09-14)

Choice/control labels go to the GUI as JSON trees (`labelTree`/`labelText` in `kernel/DSHPlugin.wl`, `LabelNode` in
the client). Wolfram gotchas hit: a `HoldAllComplete` visitor also holds its *depth* argument (use `HoldFirst`);
`heldLiteral[[1]]` evaluates the held list — map at level `{2}` inside the `Hold` and `ReleaseHold` afterwards;
helper functions like `codeNode` need `HoldAllComplete` too or `Range[20]` arrives evaluated; association *patterns*
are positional — use `KeyValuePattern`; `FirstCase[o, _?ColorQ | (FontColor -> c_) :> c]` leaves `c` unbound for the
first alternative (split the cases); comparing an evaluated value with its symbol needs `Unevaluated`/`MatchQ`.
Transport benchmark (host round trips via the evaluator): `1+1` 27 ms, ready Image 40 ms, 40 KB string 30 ms, fresh
Rasterize 91 ms, Rasterize→file→read 99 ms — base64 is ~10 ms of it; files don't help.

### Slash commands (added 2026-09-14)

`/wolfram-show <expr>`, `/wolfram <code>`, `/wolfram-kernels` via `ctx.commands.register` (inject `commands`);
the handler gets `invocation.agent` and reuses the tool's show core (`createShowCore` in `tools.mjs`), returning
the presentation payload as JSON `text`; the client registers keyed `conversation.chat.commandview` entries
(`key` = command name) and renders the same card; `/api/wolfram/shown` authorization also accepts a
`command/done` payload containing the attachment id. Gotchas: the composer's suggestion popup eats a bare
Enter after a typed `/command …` (pick the command from the list, then type); a turn-less session shows the
hero and hides command cards until its first turn (`conversationPhase` → `blank`).

### Kernel lifecycle facts (measured)

| Fact | Number |
|---|---|
| Spawn + `initialize` + bootstrap eval (`SetDirectory[cwd]; UsingFrontEnd[CurrentValue[$FrontEndSession, LightDark] = …]; $ProcessID`) | ~2 s (3 in parallel: 2.4 s total) |
| `wolfram_show` cold (kernel start + Rasterize + store) | 5.5 s; warm ~1 s |
| RSS per kernel process | ~160 MB (+ evaluator state) |
| Exit on stdin EOF or a `Quit` line | ~250 ms |
| Exit on SIGTERM / SIGINT | **never** (alive after 10 s) → SIGKILL only |
| License cap | none hit with 26 concurrent kernels ("Professional") |

Kill ladder (`servers.mjs` `KernelTransport.close`): `Quit\n` + `stdin.end()` → wait 2 s → `SIGKILL`
→ `SIGKILL` surviving child kernels (`pgrep -P`). `agent/disposed`, idle timeout (60 min, with an
`agent.inject` notice), and plugin unload all go through it; the live test asserts zero leftover
`StartMCPServer` processes. Stopping the DSH server also takes its kernels down (verified 5 → 4).

## 4. Verification performed

- `pnpm run live:kernels`: ids `wl:0:0, wl:0:1, wl:1:0`; last-started default; `x = 1` in one
  kernel invisible in the other two; state persists within a kernel; evaluator cwd = session cwd;
  cross-session `kernelId` rejected; `Rasterize @144` of a 100 pt graphic = 200×200 px; `close()`
  closes the default and falls back to the previous; **no leaked processes**.
- Isolated preview (`DSH_HOME=/tmp/wks-preview-home`, port 3081, seeded workspace, Claude Fable 5.1):
  `wolfram_show` → card "Wolfram show: damped sine · wl:0:0 · 360×231 pt @2x", pinned gallery
  `<img>` natural 720×462 rendered 360×231, served by `/api/wolfram/shown` (cold-session auth
  verified after a server restart); model's reply: "The plot is displayed above … do not re-show".
  Second turn: `wolfram_run spiral.wl` → `wolfram_eval pts = spiralPoints[300]` → `wolfram_show
  ListLinePlot[pts]` on the same kernel; state carried over; second gallery 720×747 → 360×374.
- `wolfram_kernel_list` output matched the registry; `pid (evaluator pid)` were identical — the
  AgentTools evaluator runs in the server kernel process here, so the list only prints the
  evaluator pid when it differs.

## 5. Failed attempts / gotchas (save these)

| Symptom | Cause | Fix |
|---|---|---|
| `conversation Definition "wolfram-shown" published Location data key "wolframShown"; expected its owned kind` — whole chat view blank | a `ConversationNodeDefinition`'s `buildLocationData` **key must equal its `kind`** | kind `wolframShown` |
| `slot entry crashed … Cannot read properties of undefined (reading 'width')` | a prop named **`ref`** on a function component — React strips it | prop renamed `image` |
| `ctx.slots.inject(cb)` type error `void is not assignable to SlotInjectionEffect` | the inject callback must return the `register()` disposer(s) | return an array of registrations |
| Gallery/toolview image "[image unavailable]", network shows `session/attachment` → `ATTACHMENT_NOT_REFERENCED` | meta-only attachment references are invisible to the core authorization | plugin fetch route (§3.4) |
| Toolview row stayed collapsed after the call settled | `useState(defaultOpen)` evaluated while running | effect opens once the result carries an image, until the user toggles |
| `Set::wrsym: Symbol $ScriptCommandLine is Protected` from `wolfram_run` | protected in the evaluator kernel | `Unprotect[$ScriptCommandLine]; … ; Protect[…]; Get[path]` |
| Two kernels opened in parallel: "last-started" default flipped between runs | order was pushed on connect completion | registry entry (and `order`) reserved at `open()` entry; `kernel.ready` awaited by `resolve()` |
| Preview: `stored record … does not match its schema` (`createdAt`/`updatedAt`) and later `cwd resolves to /private/tmp/…` | hand-seeded `storages/workspace.json` needs timestamps and the **canonical** path | seed `createdAt`/`updatedAt` ISO strings and `/private/tmp/...` |
| Chrome `chrome_get_screenshot` returned "value is not lossless JSON" | tool-result projection issue in this session, unrelated to the plugin | verified via DOM queries instead (`naturalWidth`, bounding rects) |
| `DSHPlugin\`Show` defined fine in one kernel but a fresh kernel had `Names["DSHPlugin\`*"]` = {Render, RunScript} and the call echoed unevaluated | `Show` inside `BeginPackage` resolved to `System\`Show` | never spell a package symbol like a built-in — renamed `ShowRasterizer` |
| `{{n,3}, Range[10]}` control dropped | matched `_List` on the **unevaluated** spec | evaluate the non-variable spec parts (Manipulate semantics) |
| `wolfram_kernel_list` showed `pid X (evaluator X)` | evaluator shares the server process | print the evaluator pid only when different |
| Image frame wider than the image, white plate behind dark plots | `IMAGE_FRAME` had `background: #fff` and was a stretched flex child | transparent hairline frame, `width: fit-content`, `alignItems: flex-start` on flex parents |
| Bare `Graphics` white in dark mode even with `LightDark = "Dark"` | Rasterize's page fill is opaque unless `Background -> None` | transparent PNG by default (`background: opaque` to opt out) |
| Editing a live row's **comments** did not reload; editing its `config` reloaded the row but kept the **old host code** | loader diffs row semantics; module-source HMR is disabled | host changes → restart `dsh web`; client bundle rebuilds hot-swap on their own |
| "3 images in a row" under one answer (laptop/wolfram-demo, turn 3) | the model called `wolfram_show` 4× in one turn — `Gold`/`Silver` aren't colours → pink error boxes → retries, plus one `see: true` re-show of the identical image; the gallery pinned every non-`isError` result | accumulator skips `errorImage` and duplicate `attachmentId` (§3.3); verified by replaying the session log through the built bundle with a fake `__ModuleLoader__` (4 → 1 pinned) |
| Verifying a client-plugin change against the live GUI from an agent's own browser | `dsh web` auth needs the per-process launch token printed only in its terminal; `reverse-proxy.json`'s `accessToken` is a different mechanism | replay the log through `lib/client.js` in Node (mock `ctx.uiConversation.events.register` to capture the `ConversationNodeDefinition`, drive `match/start/update`), or ask Tali to reload |
| 23 stray kernels (~3.7 GB) on the machine before any plugin existed | Pi bridge / Claude Code / older MCP SDK close with SIGTERM, which the kernel ignores | killed all but Claude Desktop's `disclaimer --pgroup` tree; `wolfram_kernel_list global:true` + `wolfram_kernel_close orphanPid` for the future |

## 6. Follow-ups (not done)

- Install into the live web profile (needs Tali's go-ahead: `patchReload: live`).
- Wolfram spikey icon in the tool-row title/status indicator (a tiny inline SVG is used now).
- Fate of `~/github/WolframAgentTools` fork: `Show.wl` is obsolete; the fast-launch
  `JSONConfiguration` commit (`3627e30`) is still worth upstreaming; prune paclet dirs 2.2.0–2.2.6.
- Lightbox for the gallery (click currently opens the image URL in a new tab).

## 7. References

- Pi-era code: `~/github/wolf-mcp` (bridge, latency notes), `~/github/WolframAgentTools/Kernel/Tools/Show.wl`, `~/github/rho/extensions/show.ts`
- DSH: `docs/subsystems/attachment.md`, `docs/subsystems/slots.md`, `docs/api-gateway.md` (exact Fetch routes),
  `.agents/notes/implemented/feature/2026-08-20-tool-card-image-results.md`,
  `packages/client/ui-deliverables/src/client/*` (turn accumulator + turnTail chain template),
  `packages/session-query/session-log-export/src/index.ts` (fetch-route template),
  `packages/api/session-controller/src/commands.ts` (`imageInEvent` authorization)
- Templates in tali-dash-plugins: `browser-automation` (host MCP wrapping, per-session registry), `agent-status-indicator` (client bundle build)

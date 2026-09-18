# tali-wolfram-kernel-supervisor

Per-chat Wolfram Language (Mathematica 15+) kernels for the DSH web GUI, with
plots shown **inline to the user** at retina resolution.

The kernel is Mathematica's own MCP server (`Wolfram/AgentTools` paclet,
`StartMCPServer[]` over stdio). This plugin supervises those processes — one
per kernel, isolated per chat session — and exposes a small curated tool set.
Nothing else reaches the model (no `mcp__*` names, no dsh-mcp-client).

## Tools

| Tool | Purpose |
|---|---|
| `wolfram_eval {code, kernelId?, timeConstraint?}` | Evaluate code; definitions persist per kernel. Graphics come back as images (attached to the model when it accepts images, else saved to disk). |
| `wolfram_run {path, args?, kernelId?}` | `Get[]` a `.wl`/`.wls`/`.m` script inside the kernel; `$ScriptCommandLine = {path, ...args}`. Its definitions stay available to later calls. |
| `wolfram_show {expression, kernelId?, resolution?=144, see?=false, label?, background?=transparent}` | `Rasterize` the expression @2x in the kernel (transparent PNG; the kernel's front end is pinned to the GUI's light/dark appearance so text, axes and Plot themes match) and **show it to the user** (tool card + a pinned gallery under the turn's final answer, label = link that opens the file). The model gets one line + the PNG path; `see:true` also hands it the image. |
| `wolfram_symbol {symbols}` / `wolfram_lint {code}` | `SymbolDefinition` / `CodeInspector` passthroughs. |
| `wolfram_kernel_open {label?}` | Start another kernel (becomes the default). |
| `wolfram_kernel_close {kernelId?, orphanPid?}` | Close a kernel (default: last-started); or SIGKILL a stray unsupervised kernel process whose parent is dead. |
| `wolfram_kernel_list {global?}` | This chat's kernels; `global:true` adds other chats' kernels and stray `StartMCPServer` processes on the machine. |

Kernel ids are `wl:<session>:<kernel>` (`s:M:N`-style, like browser-automation).
`kernelId` omitted/null = the chat's **last-started** live kernel, or a fresh one
(`Opened kernel wl:0:0 …` prefixes that result). Ids are validated against the
caller's session; subagents get their own session (`subagents: true`).

## Slash commands (no model involved)

| Command | Does |
|---|---|
| `/wolfram-show <expression>` | exactly what the `wolfram_show` tool does — same kernel, same card, Manipulate becomes interactive — but from the composer, with no agent turn and nothing added to the model's context |
| `/wolfram <code>` | evaluate in the chat's default kernel; output shown as a card |
| `/wolfram-kernels` | list this chat's kernels |

Implementation: `ctx.commands.register` handlers receive `invocation.agent`, so they
resolve the same per-chat kernel; `/wolfram-show` returns the presentation payload
as JSON in the command result (`command/done` is log-only, never model-visible) and
the browser half renders it through the keyed `conversation.chat.commandview` slot
with the same body as the tool card. **Caveat:** the chat shows the hero, not the
transcript, until a session has had one turn — command cards in a brand-new session
appear only after the first message (core behaviour, applies to `/compact` too).

## Interactive `Manipulate`

`wolfram_show` of a top-level `Manipulate[body, controls…]` becomes a live widget.
`kernel/DSHPlugin.wl` (`DSHPlugin\`ShowRasterizer`, `HoldAllComplete`) parses the
*simple* control forms with Manipulate's own semantics — non-variable parts are
evaluated, so `{x, 0, Length[l]}` and `{n, Range[10]}` work:

| Spec | Control |
|---|---|
| `{x, min, max}` · `{x, min, max, step}` · `{{x, init}, …}` · `{{x, init, "label"}, …}` | slider (readout shows the value) |
| `{c, {a, b, c}}` (≤ 6 choices, or `ControlType -> Setter`) | setter bar (chips) |
| `{c, {…7+ choices…}}` or `ControlType -> PopupMenu` | popup |
| `{b, {True, False}}` | checkbox |
| Manipulate options (`SaveDefinitions -> True`, …) | ignored |

The held body and variables are registered under an id in the kernel; the
initial frame is rasterized; the descriptor rides `presentationMeta`.

**Labels.** Control labels (`{{x, init, label}}`) and choice labels are sent as
small JSON trees (`labelTree` in the package) and rendered to HTML by the client:
strings bare, numbers, symbols, colour names as swatch + name (`Red`), other
colours as swatches, lists `1, 2, 3`, associations `k: v, …`, `Style` (Bold /
Italic / colour / size), `Row`, `Column`, `Superscript`/`Subscript`/`Subsuperscript`,
`Tooltip`, `Framed`, `Rule`; anything else as `code` (InputForm, 80 chars).
Depth-capped at 5 and 12 items per list. A plain-text projection (`labelText`)
feeds the model-facing text.

**Guarded rendering.** Every render (`ShowRasterizer`, `Render`) goes through
`evalAndRasterize`: the body under `TimeConstrained` (option `"TimeLimit"`, 30 s)
+ `Check` + an `` Internal`AddHandler["Message", …] `` trap (pattern from
CoreTools `TraceLoading`; `$MessageList` decides which trapped messages were
actually issued, since the handler also sees internally `Quiet`ed ones), then the
rasterization under its own `TimeConstrained`. Any message or timeout → **nothing
is rasterized**; the failure and the message texts reach the model / the card. A
`DSH-SHOW:{json}` line reports `evalMs`, `rasterMs`, `totalMs` (kernel), messages,
`timedOut`, and `errorImage` (pink error-box pixels, MathTools `ErrorImageQ`).
The host adds the round-trip time; the card shows `eval · raster · round trip`.

**Live previews.** When the last render's *kernel* time (eval + raster) was under
50 ms, dragging a slider re-renders continuously, throttled to one render per
150 ms with a trailing frame (host round trip is a fairly constant ~80 ms on top,
absorbed by the throttle). A slow render or a 422 (body failed for those values —
the last frame is kept and the messages shown) switches live off until a fast
render happens again. The status row under the frame shows `eval · raster ·
round trip` (+ `live`) and two icons: a picture (click → the current values are
rendered once more with `&save=1`, a PNG in the show directory, and opened in the
system viewer) and a document (opens the `.wl` source that every show writes
beside its PNG — same timestamp+hash stem, a header comment with time / kernel /
session / image name, then the expression exactly as submitted). Static shows
get the same two icons (their PNG already exists). Layout follows Mathematica: controls above the frame, status below; no
caption link for interactive graphics. The rounded frame pads the raster by 8 px
(no clipping into the image) and fills the padding with the median colour of the
raster's one-pixel border ring (canvas sample on load) — transparent for the
default transparent renders, the page colour for `background: opaque`. Card titles summarize the expression as
`Head[...]` (`/wolfram-show: Manipulate[...]`) when it is one bracketed
expression, else the first line truncated. On release
the browser fetches `GET /api/wolfram/manipulate?sessionId&kernelId&id&values=[…]`;
the host validates every value against the descriptor (sliders clamped, choice
indices bounded, booleans) and evaluates `DSHPlugin\`Render[id, values]` — the
body with the variables substituted, re-rasterized (~55 ms + transfer). Widgets
live as long as the kernel: a 410 disables the controls with a note. The tool
row and the pinned gallery each hold their own control state.

## Transport cost (measured)

Not the base64. In-kernel: `Rasterize` 13–17 ms, PNG encode 6 ms, base64 0.1 ms,
file write 0.07 ms. Host round trips: bare `1+1` through the evaluator 27 ms
(sandbox bookkeeping), returning a ready `Image` 40 ms, a 40 KB string 30 ms,
fresh `Rasterize` + return 91 ms (min 58), fresh `Rasterize` → PNG file → host
reads it 99 ms. So writing frames to disk buys nothing; the variance is
`Rasterize` itself. (`` MathLink`CallFrontEnd[ExportPacket[…, "ImageObjectPacket"]] ``
à la CoreTools `ToImage` might shave a few ms off `Rasterize` — untested; it is
not on the sandbox kernel's context path.)

## How the image reaches the user (and not the model)

1. Host: `wolfram_show` evaluates `Rasterize[(expr), Background -> None, ImageResolution -> 144]`
   through `WolframLanguageEvaluator` (the stock tool already returns graphics
   as MCP `image` blocks), stores the PNG with `ctx.attachments.saveImages`
   (no model-capability gate), writes `~/Library/Wolfram/DeepseekHarness/<ts>-<md5:8>@2x.png`,
   returns one line via `output.render`, and puts the attachment reference +
   `points`/`scale` into `output.presentationMeta` (persisted card metadata the
   model never sees).
2. Client (`src/client/index.tsx`): keyed toolviews for `wolfram_show` /
   `wolfram_eval` / `wolfram_run` render the image at **point size**
   (`devicePixels / scale` CSS px, so @2x is crisp and matches Mathematica's
   on-screen size). Because the compact transcript folds tool rows into
   "N tool calls" once the turn ends, a turn-scoped accumulator
   (`ConversationNodeDefinition`, kind `wolframShown`) also collects the
   turn's shows and a `conversation.chat.turnTail` chain entry renders them
   as a pinned gallery under the final answer (never folded). The gallery
   skips debug artefacts — renders flagged `errorImage` (pink error box)
   and pixel-identical re-shows (same content-addressed `attachmentId`,
   e.g. `see: true` on an image already displayed) — so a model that
   retries a broken plot pins only the good one; every attempt still
   has its tool row.
3. Captions are links: click → `GET /api/wolfram/open?path=` (paths under `showDirectory` only) → `open` in the system viewer.
4. Bytes: the core's attachment read authorizes only references found in
   *content* image blocks, so meta-only references 404. The host registers
   `GET /api/wolfram/shown?sessionId=&attachmentId=` via
   `ctx.connection.fetch` (behind normal browser auth) and authorizes by
   scanning the session's events (live or cold) for a `tool/result` whose
   `meta.attachment.attachmentId` matches (or a `command/done` payload does). `<img src>` uses it directly.

## Kernel-side code

All Wolfram code the plugin evaluates on your behalf is in `kernel/DSHPlugin.wl`
(`Get`'d once per kernel at bootstrap): `ShowRasterizer`, `Render`, `RunScript`.
No `.wl` files elsewhere, no paclet; the stock `Wolfram/AgentTools` server is
used unmodified. Package symbols must not be spelled like `System\`` built-ins
(`Show` resolved to the built-in and silently did nothing).

## Kernel lifecycle

- Spawn (lazy, on first use): `wolfram -nopaclet -noinit -noprompt -run 'PacletDirectoryLoad["<AgentTools dir>"]; Needs["Wolfram`AgentTools`"]; Wolfram`AgentTools`StartMCPServer[]'`, `MCP_SERVER_NAME=WolframLanguage`, cwd = chat workspace. Bootstrap eval `SetDirectory[cwd]; UsingFrontEnd[CurrentValue[$FrontEndSession, LightDark] = "Dark"|"Light"]; $ProcessID` pins the appearance (config `theme: auto|light|dark`; `auto` = DSH `ui-theme` setting, `system` resolved via macOS `AppleInterfaceStyle`) and captures the evaluator `session` id. ~2 s.
- **Shutdown ladder** (`servers.mjs`): write `Quit`, end stdin → wait 2 s → `SIGKILL` → `SIGKILL` child kernels. The kernel **ignores SIGTERM/SIGINT**; MCP-SDK-style SIGTERM closes are how 23 orphans accumulated on this machine before this plugin existed.
- Idle timer per session (`idleMinutes`, default 60) closes kernels and injects a notice; `agent/disposed` and plugin unload close everything. Caps: `maxKernelsPerSession` 4, `maxKernelsGlobal` 12.

## Where the kernel is (Settings ▸ Plugins ▸ "Wolfram kernel")

The kernel location is a live **setting** (namespace `wolfram-kernel-supervisor`, field
`kernelPath`), edited in the web GUI under Settings ▸ Plugins ▸ Plugin configuration ▸
**Wolfram kernel**. Precedence: that setting → the plugin config `kernel:` → auto-detection.
When the setting is empty the plugin searches `$WOLFRAMSCRIPT_KERNELPATH`, wolframscript's own
configuration, the platform's standard install locations (macOS `/Applications` and
`~/Applications` `Wolfram*.app` / `Mathematica*.app`; Linux `/usr/local/Wolfram`, `/opt/Wolfram`
`<Product>/<version>`; Windows `%ProgramFiles%\Wolfram Research\<Product>\<version>`) and
`$PATH`, and **fills the setting in** with what it finds. If nothing is found the setting stays
empty and every `wolfram_*` tool and `/wolfram*` command fails with a message that says where
the setting is (and how to install Wolfram). Any form is accepted: the `WolframKernel`
executable, the `wolfram` launcher, a `.app` bundle, or an installation directory; changes
apply to kernels started from then on.

The card also shows **wolframscript**'s state, because agents run `wolframscript` from bash and it
locates the kernel independently. The plugin never rewrites a working configuration: an explicit
`WOLFRAMSCRIPT_KERNELPATH` that exists is left alone; one that points at a missing file is
repaired; with no explicit path it probes once (`wolframscript -code '$Version'`, result cached in
`showDirectory/wolframscript-probe.json`) and only a failed probe runs
`wolframscript -configure WOLFRAMSCRIPT_KERNELPATH=<kernel>` (`configureWolframscript: false`
disables the write; the buttons on the card do it on request). Status route:
`GET /api/wolfram/kernel`; `POST ?action=detect|configure-wolframscript|probe-wolframscript`.

## Config

See the header of `index.js`. Defaults need nothing: the kernel is auto-detected (see above),
highest installed `Wolfram__AgentTools-*` paclet, 144 dpi, `theme: auto`, files under
`~/Library/Wolfram/DeepseekHarness`.

## Develop

```sh
pnpm install                 # links DSH packages from ~/github/deepseek-harness
pnpm run check               # syntax + Config smoke + headless kernel-setting test (fake ctx, fake settings provider)
pnpm run typecheck && pnpm run build   # browser half → lib/client.js
pnpm run live:kernels        # real kernels: isolation, default rules, 2x Rasterize, ZERO leaked processes
```

Preview in an isolated DSH (see ../../PREVIEWING.md); the dev overlay
`../../cordis.dev.yml` has a row for this plugin. Recipe with the end-to-end
story and the gotchas: `~/projects/deepseek-harness/wolfram-kernel-supervisor.md`.

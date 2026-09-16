# tali-browser-automation

Per-chat Safari (Technology Preview) and Chrome automation for DSH with a
**curated tool set**: `safari_*` and `chrome_*` tools, per-session windows
addressed by id, isolated page readers, and element-aware screenshots. The
plugin owns the MCP forwarding itself — it holds private MCP SDK connections to
Apple's Safari MCP server (`safaridriver --mcp`) and Google's
`chrome-devtools-mcp`, and registers exactly the tools it wants. Nothing else
reaches the model: no `mcp__server__tool` names, no raw server tools, no
`dsh-mcp-client`. Host-only plugin, plain ESM JavaScript.

## Tools

44 tools, 21 Safari + 23 Chrome — full reference with every parameter, return value
and implementation note in **[`docs/tools.md`](docs/tools.md)** (generated from
the definitions by `pnpm run docs`; `pnpm run check` fails when it is stale).

| Area | Safari | Chrome |
|---|---|---|
| Windows | `safari_open`, `safari_close` | `chrome_open`, `chrome_close` |
| Navigation / reading | `safari_navigate`, `safari_get_page_content` (isolated reader or window; expand / section / selectors / scope), `safari_get_page_structure` (outline with selectors), `safari_wait_for`, `safari_get_youtube_notes` | `chrome_navigate`, `chrome_get_page_content` (temporary page or window; same expand / section / selectors / scope; own DOM→markdown serializer), `chrome_get_page_structure`, `chrome_snapshot`, `chrome_wait_for` |
| JavaScript | `safari_evaluate_expression`, `safari_evaluate_function` | `chrome_evaluate_expression`, `chrome_evaluate_function` |
| Interaction | `safari_interact` (batch), `safari_click`, `safari_hover`, `safari_press_key`, `safari_type_text` | `chrome_interact` (batch, same format), `chrome_click`, `chrome_fill`, `chrome_fill_form`, `chrome_hover`, `chrome_press_key`, `chrome_type_text` |
| Screenshots | `safari_get_screenshot` (inline, element crop), `safari_save_screenshot` | `chrome_get_screenshot`, `chrome_save_screenshot` |
| Diagnostics | `safari_console_messages`, `safari_network_requests`, `safari_get_network_request`, `safari_handle_dialog`, `safari_set_viewport_size` | `chrome_console_messages`, `chrome_network_requests`, `chrome_get_network_request`, `chrome_handle_dialog`, `chrome_set_viewport_size` |

Raw server names and schemas these forward to: `docs/server-tools.json`
(`pnpm run dump:tools` regenerates it).

## Windows and sessions (`windows.mjs`)

- Every agent (chat or subagent) that uses a browser gets a **session index**,
  consecutive over the plugin instance's lifetime. Windows are numbered from 0
  per browser within the session: `s:0:0`, `s:0:1`, `c:0:0`, …
- **Safari window = one `safaridriver --mcp` process** = its own automation
  session and its own STP window (fresh cookies/JS state). This is the only
  isolation Safari offers, and it is real: two windows on different pages keep
  independent tabs, `evaluate`, and screenshots (verified). The STP banner
  reads *"This window is controlled by DSH: ‹chat title› · s:0:1."* — the MCP
  handshake's `clientInfo.name`, which we set per window.
- **Chrome window = one page** of a single `chrome-devtools-mcp --isolated`
  instance per session, routed by `pageId`; windows share the session's
  cookies like tabs of one browser. Fresh temporary profile: no saved logins.
- Every window tool takes optional `windowId`. Omitted, the browser must have
  **zero or one** window in the calling session: zero opens one (`opened` is
  reported), one is used, more is an error naming the open ids. Ids are
  validated against the caller's session; a window of another chat is
  unreachable.
- Per-session behavior needs **no dynamic tool registration**: the tool set is
  static (registered per agent at `agent/created`, also for agents already
  live when the plugin loads) and every call reads `exec.agent`.

## Lifecycle

- Nothing is spawned until a tool needs it. Web sessions are never disposed by
  DSH, so a per-session idle timer (`idleMinutes`, reset by every tool call)
  closes a session's windows and injects a notice; agent disposal and plugin
  unload close everything.
- **STP instance ownership** (`servers.mjs`): Apple's driver launches STP on a
  session's first navigation and terminates it only when *that* session ends
  — if other sessions were alive at that moment, the instance lingers forever
  with no windows (observed). We count live Safari connections host-wide; if
  the first one starts while no STP instance runs, the instance is ours, and
  when the count returns to zero we quit it after a 3 s grace period
  (osascript `quit`, then SIGTERM). A connection ending cleanly (stdin EOF —
  the driver exits in ~20 ms, inside the MCP SDK's 2 s grace before SIGTERM)
  closes its window; SIGTERM'd drivers leak windows.
- **Reader pool** (`reader-pool.mjs`): `safari_get_page_content` with a url and
  `safari_get_youtube_notes` read in isolated readers (own STP windows labeled
  `DSH: page reader #n`), never in a chat's window. Concurrent reads each get a
  reader; `reader.maxIdle` (1) stay warm (a warm read is ~1.5–2 s vs ~4 s
  cold); the rest close after `reader.idleMinutes`. Cold start is serialized
  (two brand-new sessions navigating simultaneously can both launch STP).

## Page reads (`page-read.mjs`)

WebKit's extractor (the server's `get_page_content`) returns only *rendered*
text and always the whole page: closed `<details>`, `aria-expanded="false"`
accordions and unselected tab panels are silently absent, headings come out as
plain lines, and every icon becomes `![]()`. `safari_get_page_content` runs
small in-page scripts around the extraction; both modes share the pipeline:

| Step | Isolated (url) default | Window default | What it does |
|---|---|---|---|
| `prepare` | — | — | your JS function body, BEFORE extraction (dismiss banners, "show more"); `script` still runs after |
| `expand` | on | off | `details.open = true`; click `aria-expanded="false"` outside nav/header/footer (never menus/comboboxes/tabs); click through each `role=tablist`, appending the other panels under **"Hidden tab panels"**; the header reports counts |
| probe | when not expanded | when not expanded | counts what stayed collapsed → `NOTE: 14 collapsed <details> sections and 1 tab group not expanded …` |
| `section` / `selectors` / `scope` | `scope: auto` (main landmark when it holds ≥ 60 % of the text) | `scope: page` | isolated pages are edited in place (`body.replaceChildren`); windows hide the siblings along the kept subtrees' ancestor chains (`display:none !important`, tagged `data-dsh-scope-hidden`) and restore afterwards. `section: "#troubleshooting"` = that heading through the next heading of equal or higher level |
| `markHeadings` | on for `webkitMarkdown` | off | writes `## ` into each heading's first text node so WebKit's markdown carries levels (never replaces framework-owned nodes — React throws on its next render otherwise). Not needed for `markdown`, which has native headings |
| `clean` | on for markdown | on for markdown | drops zero-width anchors, alt-less images, icon-only link lines; a `[](url)` left inline (WebKit omits link text that also appears in the URL, e.g. `mcp-remote`) gets the URL's last path segment back as text |

**`format: markdown` is the plugin's own serializer in both browsers**
(`dom-markdown.mjs`, run as an evaluate script): headings, nested lists, code
fences with language, inline code, bold/italic, links, images with alt, pipe
tables (data tables only — layout tables like Hacker News become block flow),
blockquotes, shadow DOM traversal (MDN's code examples live in
`<mdn-code-example>` shadow roots). Measured against WebKit's markdown on
Notion docs / Wikipedia / MDN / HN it is the same speed (5–25 ms) and keeps
everything WebKit drops (0 → 18 fences and 0 → 34 inline-code spans on the
Notion page; 8 → 15 headings on MDN); WebKit's is still there as
`webkitMarkdown` (with the `markHeadings` hack), and `textTree` / `json` /
`html` / `plainText` remain WebKit's — they carry the node UIDs interaction
needs. Visibility uses `checkVisibility()` (display, visibility, *and*
`content-visibility`, which is how Chrome hides the children of a closed
`<details>` while leaving them layout boxes — plain `getClientRects()` is
fooled).

**Chrome has the same surface** (`chrome_get_page_content`,
`chrome_get_page_structure`) through `chrome-read.mjs`: chrome-devtools-mcp has
no text extractor (its snapshot is the accessibility tree), so markdown is the
serializer above, `plainText` is `innerText`, `html` the body's innerHTML. The
expand / scope / probe / clean steps are the very same scripts, bridged onto
`evaluate_script` by `chromeReadCall`. A `url` read uses a temporary page of
the session's Chrome instance; the instance stays warm for later reads and is
closed by the session idle timer (`anythingOpen()` in windows.mjs counts a
reader-only instance as "open").

`safari_get_page_structure` / `chrome_get_page_structure` are the map for all of this: landmarks, every
heading with a CSS selector (`#id` when unique, else an `nth-of-type` path),
collapsed counts and tab groups — ~1–3 kB for a long docs page.

Timing that matters: a layout tick (`setTimeout`, not rAF — rAF does not fire
in occluded windows) between DOM mutations and the extraction. Rewriting
heading text in the same tick as opening `<details>` made WebKit's markdown
drop the details' bodies while textTree kept them.

## Screenshots (`safari-screenshot.mjs`)

Apple's `screenshot` captures the whole viewport (its `node` parameter is a
documented no-op). With `querySelector` we: find the element, `scrollIntoView`
(`scrollTo`), poll with `setTimeout` until rect and scroll offset are stable for
three samples (**not** `requestAnimationFrame` — it does not fire in occluded
windows, e.g. a second stacked STP window, and hung the loop until the 30 s
script timeout), capture the viewport, re-measure (retake once if it moved
> 2 px), and crop with **sharp** at device-pixel precision (scale = image
width ÷ CSS viewport, exact for fractional DPR). Not `sips`: its
`--cropOffset 0 0` is treated as unset and center-crops (verified). Inline
images go through DSH's attachment store under the same admission rule as the
MCP bridge (the model must declare image input; otherwise a temp file path is
returned). Verified pixel-exact on iana.org's `h1` and a below-the-fold
`footer`. Chrome element capture uses the server's native `uid` screenshots.

Chrome's `take_screenshot` has **two success shapes**: an image block, or —
for captures ≥ 2 MB (chrome-devtools-mcp `screenshot.js:256`, 1.8.0 and 1.9.0; a retina
viewport of a colourful page gets there easily) — a text-only reply
`Took a screenshot of …\nSaved screenshot to <tmp>/chrome-devtools-mcp-XXXXXX/screenshot.png.`
`captureChrome` handles both (`servers.mjs` `savedFileOf`), deletes the
server's per-call temp dir after reading, and says so in the summary
(`4.2 MB png (≥ 2 MB: chrome-devtools-mcp wrote it to disk; read back …)`).
Before this, the plugin echoed the server's success line as
`chrome screenshot failed: Took a screenshot …` — the uninformative message
seen in the tensatory session.

## Failure reporting

All curated tools share one wrapper (`explainFailure`, `FAILURE_HINTS` in
`curated-tools.mjs`) that turns a raw failure into something the model can act
on: `<curated tool>: server tool <raw name> failed: <server's words>`, a plain
reading of MCP-SDK timeouts (`toolCallTimeoutMs`, blocking dialog, endless
navigation), `Request: {…}` with the call's arguments, and a `Hint:` remedy for
known messages (stale uid → `chrome_snapshot` again; dialog open →
`*_handle_dialog`; page closed → reopen; element not interactive →
scroll/wait; `no element matches` → check the selector; model without image
input → `read_image`). `chrome_interact` step reports get the same hint
inline. Screenshot failures name the target and window and quote the server's
exact reply plus the content blocks received; a requested-vs-captured mismatch
("uid asked, viewport delivered") is a `NOTE:` on success. `AbortError`s pass
through untouched. When a new opaque server message turns up, add a row to
`FAILURE_HINTS` and a case to `scripts/smoke-config.mjs`.

## Requirements

- **Safari**: Safari Technology Preview 247+ (or Safari 27) with Develop ▸
  Developer Settings ▸ *Allow Remote Automation*. STP is launched on demand,
  in the background; the user's regular Safari is never touched. There is no
  classic-Safari fallback (stable Safari's driver has no `--mcp`); tools fail
  with an explanatory message when STP is missing.
- **Chrome**: Google Chrome, plus `chrome-devtools-mcp` **pinned in this
  plugin's `package.json`** (exact version, currently 1.9.0; `pnpm install` in
  the plugin directory installs it — one package, ~14 MB, it bundles its own
  deps). The default `chrome.command: ''` runs that bin script
  (`node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js`)
  with the host's own `node` (`process.execPath`), so PATH, shebangs and
  global installs play no part. Upgrade = edit the version, `pnpm install`,
  `pnpm run check`, restart `dsh web`; the smoke test asserts the pin is
  exact and the bin exists. Setting `chrome.command` to a path (e.g. the old
  `/opt/homebrew/bin/chrome-devtools-mcp` from `npm i -g`) uses that binary
  verbatim instead. Launched with `--isolated`, `--no-usage-statistics`,
  `--no-performance-crux` and `--ignoreDefaultChromeArg=--enable-automation`
  (no "controlled by automated test software" bar; `chrome.hideAutomationBanner`).

### A quiet `dsh web` terminal

chrome-devtools-mcp (1.8.0 and 1.9.0 alike) prints ~12 lines of stderr per launch. Each is
switched off at its source where a switch exists, and the one that has none is
filtered (`servers.mjs` `CHROME_STDERR_NOISE`, `index.js` `chromeSpec`):

| Line | Off switch |
|---|---|
| `Update available: 1.8.0 -> 1.9.0` (+ a daily `npm view` subprocess) | env `CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1` |
| `Performance tools may send trace URLs to the Google CrUX API…` | `--no-performance-crux` |
| `The connecting client did not negotiate the MCP roots capability…` | the client declares `roots` and answers `roots/list` with the session cwd — quiet, and file-writing tools stay scoped (cwd + the server's temp dir) instead of `--allow-unrestricted-paths` (which 1.9.0 turns on by default for its CLI; our roots still win) |
| `(node:N) ExperimentalWarning: localStorage is not available…` | env `NODE_OPTIONS=--localstorage-file=<tmp>/dsh-chrome-<pid>-<session>-localstorage.json` (4 kB, removed when the instance's process ends) |
| `chrome-devtools-mcp exposes content of the browser instance…` (3 lines) | no flag exists: stderr is piped (`stderr: 'pipe'`), these lines dropped, everything else goes to `ctx.logger.warn` + `traceFile` as `chrome-stderr` events |

`chrome.quietStderr: false` forwards every line to the logger instead of
filtering (useful when the server misbehaves). Safari's driver still inherits
stderr — it has never been noisy.

## Install

Dev overlay (`../../cordis.dev.yml`) or a permanent row in a profile's patch
layer (what the `web` profile uses):

```yaml
- insert:
    - id: tali-browser-automation
      name: '/Users/tali/github/tali-dash-plugins/plugins/browser-automation/index.js'
      config:
        subagents: true         # child agents get their own sessions too
        idleMinutes: 30         # 0 = never auto-close
        chrome:
          headless: false
        # traceFile: /tmp/browser-automation-trace.log   # JSON lifecycle lines
```

Full config surface: top of `index.js`. Module code changes need a host
restart (`dsh web` has module HMR disabled; only the patch file is
live-reloaded).

## Checks

- `pnpm run check` — offline smoke: config, preflight messages, the 42
  registered tools per agent (child filter, disposal), window-id rules
  (numbering, ambiguity, cross-session, browser mismatch), YouTube and
  geometry helpers, page-content unwrapping (inline / spilled-to-file), the
  page-read pipeline's planning, cleanup and script syntax; plus a freshness
  check of `docs/tools.md`.
- `pnpm run docs` — regenerate `docs/tools.md` after changing a tool.
- `pnpm run live:windows` — the live matrix through the real tool executes:
  two Safari windows, isolation, zero-or-one rule, window/isolated reads,
  element screenshot, save, auto-open, two Chrome windows, snapshot/evaluate/
  screenshots, cleanup to zero processes.
- `pnpm run live:page-read` — expand / scope / section / selectors /
  markHeadings / structure / prepare on a real docs page, isolated and window
  mode (hide-and-restore leaves the page intact).
- `pnpm run live:chrome-read` — the same through `chrome_get_page_content` /
  `chrome_get_page_structure` (headless): temporary page, window mode, warm
  reader instance, zero processes after unload.
- `pnpm run live:reader`, `live:youtube [url]`, `live:screenshot [url] [selector]`.

## Gotchas learned the hard way

- `ctx.logger` output of host plugins does not reach `/tmp/dsh-web.log` (only
  child stdio does); use `traceFile`.
- The `defineTool` DSL rejects `required: false` (omit the key) and requires
  explicit `additionalProperties` on nested object schemas.
- `ctx.tools.restrict()` masks only global tools — one more reason to own the
  forwarding rather than mount raw MCP tools and try to hide some.
- `chrome-devtools-mcp` sets a bare process title, so `ps`/`pgrep -f` never
  show its `--isolated` args; count *your own* children (`pgrep -lP <pid>`,
  listed as `node`) when checking for leaks.
- Apple's `get_page_content` spills results past ~40 kB (routine for
  `json`/`html`) to a temp file and answers `Saved large output to '<path>'`;
  `unwrapPageContent` (servers.mjs) follows it in both modes. Tool output must
  be lossless JSON — never emit `undefined` fields.
- pi-web's bridge (`rho/extensions/mcp.ts`) runs one bare `safaridriver --mcp`
  per pi process: all its sessions share one automation window, labeled
  `rho-mcp-bridge`.

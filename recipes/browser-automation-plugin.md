# Per-chat browser automation (Safari Technology Preview + Chrome) for DSH

Gives every DSH chat (and, optionally, every subagent) its own browser windows
through a curated set of `safari_*` / `chrome_*` tools, plus an isolated
"page reader" for `read this URL` requests that beats `web_fetch` on
JavaScript-rendered or bot-blocked pages (YouTube, docs sites, SPAs).

Plugin: `~/github/tali-dash-plugins/plugins/browser-automation` — **read its
`README.md` and `docs/tools.md` for the tool-level story**; this recipe owns
the system-level one. Built 2026-09, local-only (machine-specific paths).

## Why a plugin at all (and not just MCP config)

| Want | What it takes |
|---|---|
| One browser shared by the whole host | Config only: a `dsh-mcp-client` stdio row running `safaridriver --mcp` or `chrome-devtools-mcp`. Every chat drives the **same** window — concurrent agents collide. |
| A browser **per chat**, started lazily, closed when idle | A plugin: it must know agents (`ctx.agents.list()`, `agent/created`, `agent/disposed`), register tools per agent, and own the child processes. |

pi-web (the `rho` bridge) does the former: one bare `safaridriver --mcp` per
pi process, banner `rho-mcp-bridge`. The "exa" Tali remembered was
pi-web-access's Exa.ai *search* provider, unrelated to browsing.

## The Safari facts that shape the design

- Only **Safari Technology Preview** ships `safaridriver --mcp`
  (`/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver`).
  Stable `/usr/bin/safaridriver` (Safari 26.x) has no `--mcp`; there is no
  classic-Safari fallback, so the plugin fails with an explicit message.
- **One `--mcp` process = one automation session = one STP window** with the
  banner *"This window is controlled by ‹clientInfo.name›."* — the MCP
  handshake's client name is the label, so each window says which chat owns it.
- The first session launches STP (`--automation -ApplePersistenceIgnoreStateQuietly`)
  and only *that* session's teardown quits it → orphaned STP with no windows if
  other sessions were alive. The plugin counts live Safari connections and
  quits STP itself when the count hits zero (`osascript quit`, then SIGTERM).
- Clean stdin EOF exits the driver in ~20 ms and closes its window; SIGTERM
  leaks windows. The MCP SDK's `close()` does stdin-end → 2 s grace → SIGTERM,
  which is fine.
- `evaluate_javascript`'s `expression` is a **function body** (needs `return`).
  `get_page_content` defaults `maxWordsPerParagraph` to 15 (silently truncates
  prose) and spills results past ~40 kB to a temp file, answering
  `Saved large output to '<path>'` — follow the pointer.
- `requestAnimationFrame` does not fire in occluded windows; poll with
  `setTimeout`.
- WebKit's extractor returns only **rendered** text: closed `<details>`,
  collapsed accordions and unselected tab panels are absent; headings come out
  as plain lines; link text that also appears in the href is dropped
  (`[](https://npmjs.com/package/mcp-remote)`). The plugin's `page-read.mjs`
  works around all of these (expand / scope / markHeadings / clean) and adds
  `safari_get_page_structure` so an agent can target a section by selector.

`format: markdown` in both browsers is the plugin's own DOM serializer
(`dom-markdown.mjs`); WebKit's markdown survives as `webkitMarkdown`. Measured
on four real pages the serializer matched WebKit's speed and kept the code
fences, inline code, heading levels and tables WebKit's drops. It must walk
shadow DOM (MDN keeps code examples in `<mdn-code-example>` shadow roots) and
must not turn layout tables into pipe tables (Hacker News). Chrome has the same
read surface (`chrome_get_page_content`, `chrome_get_page_structure`);
`chrome-devtools-mcp` has **no text extractor** (its snapshot is the
accessibility tree), so it reuses that serializer and the same expand / scope /
probe scripts. Chrome hides closed `<details>` children with
`content-visibility`, which `getClientRects()` does not see — use
`element.checkVisibility()`. `chrome-devtools-mcp` also sets a bare process
title: `pgrep -f '--isolated'` never matches it; count your own node children.

Chrome side: `chrome-devtools-mcp`, pinned to an exact version in the plugin's
`package.json` and run by the host's `node` (was a Homebrew-npm global install
until 2026-09-15; see Troubleshooting "what to update"), with
`--isolated --no-usage-statistics --no-performance-crux --ignoreDefaultChromeArg=--enable-automation`
(the last one removes the "controlled by automated test software" bar). One
isolated instance per chat; "windows" are its pages, routed by `pageId`.

## Install / wire-up (what exists now)

1. Plugin code: `~/github/tali-dash-plugins/plugins/browser-automation`
   (`pnpm install` there; dependencies are `link:` paths into the DSH checkout's
   `node_modules/.pnpm` for `@modelcontextprotocol/sdk` and `sharp`, so a DSH
   upgrade that changes those versions breaks the links — re-point them).
2. Live web profile row in `~/.dsh/profiles/web/cordis.patch.yml`:

   ```yaml
   - id: tali-browser-automation
     name: '/Users/tali/github/tali-dash-plugins/plugins/browser-automation/index.js'
     config:
       subagents: true      # each subagent may open its own browser
       idleMinutes: 30      # close a chat's windows after 30 min without a browser call
       chrome:
         headless: false
       traceFile: /tmp/browser-automation-trace.log   # remove when done debugging
   ```

   The profile hot-reloads (`patchReload: live`) but **module code does not**
   (`cordis-plugin-hmr` is disabled in this profile): every code change needs
   `dsh web` restarted by Tali. `ctx.logger` output never reaches
   `/tmp/dsh-web.log` (child stdio only) — that is what `traceFile` is for.
3. Also registered in the repo's `cordis.dev.yml` for the preview server
   (`tali-dash-plugins/PREVIEWING.md`); never load both overlays into the same
   host — duplicate loader id (`preview-identity.md`).

## Verify

```sh
cd ~/github/tali-dash-plugins/plugins/browser-automation
pnpm run check           # offline: config, 44 tools per agent, window ids, helpers, docs freshness
pnpm run live:windows    # two Safari + two Chrome windows, isolation, screenshots, zero leftover processes
pnpm run live:page-read  # expand / section / selectors / structure on a real docs page (Safari)
pnpm run live:chrome-read # the same through Chrome (headless), incl. warm reader instance + zero leftovers
```

From a fresh chat: `safari_open` twice on different sites, `safari_get_screenshot`
with `querySelector: "h1"` on the second, `safari_close`. Afterwards
`pgrep -fl "safaridriver --mcp"` should show only the host's warm pooled reader
(one process, disappears after `safari.reader.idleMinutes`).

## Failed attempts (don't repeat)

| Attempt | Why it failed |
|---|---|
| Host-scoped `dsh-mcp-client` rows for Safari/Chrome | One browser for all chats; concurrent agents fought over it. |
| Eager per-agent MCP mounts at `agent/created` | 11 process pairs leaked — Web sessions are never disposed by the session controller. Mount lazily on first tool call, close on idle. |
| Hiding raw MCP tools with `ctx.tools.restrict()` | It masks only global tools. Own the forwarding instead and register only curated tools. |
| `mcp__safari__*` tool names | DSH does not require the prefix (only `dsh-mcp-client` produces it); plain `safari_*` won. |
| `sips --cropOffset 0 0` for element crops | Offset 0 is treated as unset (center-crops). Use `sharp`. |
| rAF-based "settled" loop for screenshots | Hangs in occluded windows. `setTimeout` polling, 3 stable samples. |
| `h.textContent = '## ' + text` to mark headings | Destroys React-owned nodes; the next re-render throws and unmounts content (bodies vanished from the extraction). Write into the first text node's `data` instead, and put a layout tick between mutations and extraction. |
| `format: json` in window mode | Failed with "value is not lossless JSON": the 40 kB spill pointer wasn't followed and `undefined` fields leaked. Fixed in `servers.mjs` `unwrapPageContent`. |
| Treating "no image block" from `take_screenshot` as failure | chrome-devtools-mcp 1.8.0 (`build/src/tools/screenshot.js:256`) writes any capture ≥ 2 MB to `mkdtemp(<tmp>/chrome-devtools-mcp-XXXXXX)/screenshot.png` and answers with **text only** ("Took a screenshot of the current page's viewport.\nSaved screenshot to …"). A retina viewport of a colourful page (tensatory's plasma slider, 2400×1884, 2.6–4.1 MB PNG) hit it on every plain viewport shot, and the plugin reported the server's *success* line as `chrome screenshot failed: Took a screenshot …` — nothing for the agent to act on. Fixed 2026-09-15: `captureChrome` reads the spilled file back (`servers.mjs` `savedFileOf`) and removes the per-call temp dir; failures now quote the server, name the target/request and append a remedy (`explainFailure` / `FAILURE_HINTS` in `curated-tools.mjs`). Regression case in `scripts/smoke-config.mjs`. |

## Failure reporting (what an agent sees when a tool fails)

Every `safari_*`/`chrome_*` failure passes through `explainFailure` in
`curated-tools.mjs` (the same wrapper that strips `undefined`):

- `<curated tool>: server tool <raw name> failed: <server's own words>` — the
  raw MCP tool name (`take_snapshot`, `evaluate_javascript`, …) is kept for
  provenance because the model never sees those names otherwise.
- MCP-SDK timeouts (`-32001 Request timed out`) are explained in terms of
  `toolCallTimeoutMs` with the usual causes (blocking dialog, endless
  navigation, hung script) and the way out (`*_handle_dialog`, `*_close`).
- `Request: {…}` — the call's arguments, so the failure text is self-contained.
- `Hint: …` — the first matching remedy from `FAILURE_HINTS` (stale uid →
  re-snapshot; open dialog → handle it; page closed → reopen; not-interactive
  element → scroll/wait; `no element matches` → check the selector; model has
  no image input → `read_image`). `chrome_interact` step reports carry the
  same hint inline. Add a row there when a new opaque server message shows up.
- Screenshots additionally report size/format, whether the capture was read
  back from disk, and a `NOTE:` when the server says it captured something
  other than what was requested (uid asked, viewport delivered). Safari's
  capture checks that `safaridriver` actually wrote the file it claims to have
  written. Aborts (`AbortError`) pass through untouched so DSH still
  recognises a stopped turn.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Safari Technology Preview is required…` | STP not installed, or `safari.driver` points at classic `safaridriver`. |
| Windows stack at the same screen position | Expected: every `--mcp` session opens at the same coordinates. The banner tells them apart. |
| STP keeps running with no windows | An older build before `SafariInstanceOwner`; or a driver was SIGTERM'd. `osascript -e 'quit app "Safari Technology Preview"'`. |
| Read is missing a section that is visibly on the page | It is collapsed. Pass `expand: true` (window mode) or use `safari_get_page_structure` → `section:`. The header's `NOTE:` says what stayed collapsed. |
| Chrome shows the automation infobar | `chrome.hideAutomationBanner` was turned off. |
| `chrome screenshot failed: Took a screenshot of the current page's viewport. Saved screenshot to /tmp/chrome-devtools-mcp-…/screenshot.png.` | Host is running a plugin build older than 2026-09-15: the capture was ≥ 2 MB and spilled to disk (see Failed attempts). Restart `dsh web` to load the fix; meanwhile `read_image` the quoted path, or request `format: "jpeg"` / a `uid` crop to stay under 2 MB. |
| Screenshot summary says `(≥ 2 MB: chrome-devtools-mcp wrote it to disk; read back by the plugin …)` | Informational. The image is fine; use `format: "jpeg"` or a `uid` crop if payload size matters. |
| `Element with uid N_M no longer exists on the page` / `Element uid "…" not found on page` | uids are minted by `chrome_snapshot` and die on re-render/navigation. Re-snapshot; never reuse a uid across a `chrome_navigate` or after clicking something that re-renders. |
| `MCP error -32001: Request timed out` | The browser server stalled for `toolCallTimeoutMs` (60 s default). Check for a blocking dialog (`chrome_handle_dialog` / `safari_handle_dialog list`), then `*_close` and reopen if it persists. |
| Leftover `/tmp/chrome-devtools-mcp-*/screenshot.png` (2–4 MB each) | Spilled captures from before the fix; the plugin now removes the per-call dir after reading. Safe to delete. |
| `pnpm dsh web` terminal spammed per Chrome launch: `Update available`, `exposes content of the browser instance…`, `Performance tools may send trace URLs…`, `did not negotiate the MCP roots capability…`, `ExperimentalWarning: localStorage…` | Plugin build older than 2026-09-15. Since then: `CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1`, `--no-performance-crux`, `roots` capability (session cwd) instead of `--allow-unrestricted-paths`, `NODE_OPTIONS=--localstorage-file=<tmp>/dsh-chrome-…-localstorage.json`, and piped+filtered stderr for the disclaimer (no flag exists). Table in the plugin README, "A quiet dsh web terminal". `chrome.quietStderr: false` shows everything again. Unfiltered lines appear as `browser-automation: chrome-devtools-mcp c:<n>: …` warnings and `chrome-stderr` trace events. |
| `Update available: 1.8.0 -> 1.9.0` — what to update? | Since 2026-09-15 the server is a **pinned exact dependency** of the plugin (`plugins/browser-automation/package.json`, `chrome-devtools-mcp: "1.9.0"`), run by the host's `node` (`chromeServer()` in `index.js`; `chrome.command: ''`). Upgrade: edit the version, `pnpm install` in the plugin dir, `pnpm run check` (asserts exact pin + bin present, greps nothing else), skim the upstream CHANGELOG for `screenshot.js` (the ≥ 2 MB spill) and `McpPage.js` uid messages (our `FAILURE_HINTS` match them), restart `dsh web`. The global `/opt/homebrew/bin/chrome-devtools-mcp` (1.8.0) is no longer used; `npm rm -g chrome-devtools-mcp` is safe, or point `chrome.command` at it to compare versions. The banner itself is suppressed by `CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS`. |

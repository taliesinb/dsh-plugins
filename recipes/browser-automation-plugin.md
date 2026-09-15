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

Chrome side: `chrome-devtools-mcp` (installed globally via Homebrew npm) with
`--isolated --no-usage-statistics --ignoreDefaultChromeArg=--enable-automation`
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

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Safari Technology Preview is required…` | STP not installed, or `safari.driver` points at classic `safaridriver`. |
| Windows stack at the same screen position | Expected: every `--mcp` session opens at the same coordinates. The banner tells them apart. |
| STP keeps running with no windows | An older build before `SafariInstanceOwner`; or a driver was SIGTERM'd. `osascript -e 'quit app "Safari Technology Preview"'`. |
| Read is missing a section that is visibly on the page | It is collapsed. Pass `expand: true` (window mode) or use `safari_get_page_structure` → `section:`. The header's `NOTE:` says what stayed collapsed. |
| Chrome shows the automation infobar | `chrome.hideAutomationBanner` was turned off. |

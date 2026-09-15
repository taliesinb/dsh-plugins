# Dash docsets as native DSH tools (`dash-docsets` plugin)

Recipe for giving DSH agents the documentation installed in **Dash 8** (the
macOS docs browser, Setapp build here): `dash_list_docsets`, `dash_search`,
`dash_get_page`. Plugin code and its README live in
`~/github/tali-dash-plugins/plugins/dash-docsets/`; this recipe owns the
system-level story: what exists, what was decided and why, how to
(re)install, and what went wrong.

Built 2026-09-14 against Dash 8.1.1 (`/Applications/Setapp/Dash.app`,
bundle id `com.kapeli.dash-setapp`), Node 26, pnpm 11.

## 1. Prior art — what already existed

- **Kapeli's official [dash-mcp-server](https://github.com/Kapeli/dash-mcp-server)**
  (Python, FastMCP, v1.1.2): `list_installed_docsets`, `search_documentation`,
  `load_documentation_page`, `enable_docset_fts`. It is a thin wrapper over a
  **local HTTP API built into Dash 8** (Dash ▸ Settings ▸ Integration ▸ API
  Server). Requires Python 3.12 + `uv`.
- No Dash CLI exists. `dash://query`, `dash-plugin://keys=…&query=…` and the
  ohmyzsh `dash` plugin only *open the Dash UI*; `dasht` reads docset SQLite
  indexes directly (no Dash needed, but no Dash features either).

**Decision:** speak Dash's HTTP API natively from a Node plugin (like
`browser-automation` speaks to `safaridriver --mcp`) instead of wrapping the
MCP server — same data, no Python/uv, curated tool names, and our own
page conversion. `enable_fts` was dropped (see §3 on FTS).

## 2. The Dash API, as probed (facts the plugin depends on)

| Item | Observed |
|---|---|
| Enable | `defaults write com.kapeli.dash-setapp DHAPIServerEnabled -bool YES` (direct-download build: domain `com.kapeli.dashdoc`). Dash picks it up **live** (~100 ms). The key does not exist until toggled once. |
| Port | `~/Library/Application Support/Dash/.dash_api_server/status.json` → `{"port":53649}`. Per launch (the API port happened to be reused across a restart; the page-server port was not). **Stale file stays behind when the server is disabled** → always confirm with `GET /health`. |
| `GET /health` | `{"status":"ok","timestamp":…}` |
| `GET /docsets/list` | `{docsets:[{name, identifier, platform, path, full_text_search}]}` — 51 here. `identifier` is an opaque 8-letter code (`shofitzl` = PyTorch). |
| `GET /search?query&docset_identifiers&max_results&search_snippets` | `{results:[{name,type,platform,load_url,docset,description,language?,tags?}], message?}`. Fuzzy over **index names** (symbols, section titles, nLab entries). `[{}]` when empty; often `max_results+1` rows. All 51 docsets: ~0.25 s (4 s cold). |
| `load_url` | `http://127.0.0.1:<other port>/Dash/<code>/…#anchor` — raw docset HTML from a second server. Anchors: `#id`, `#//apple_ref/Type/Name` (Dash-injected `<a name>`), `#//dash_ref_<n>/Type/Name/0`. |
| Errors | HTML pages, message in `<h1>`: 400 `Docset with identifier 'x' not found…`, 403 `API access blocked due to Dash trial expiration`; unknown paths 501. |

## 3. Design decisions

- **Three tools, `dash_` prefix** (house style of `safari_*`/`chrome_*`):
  `dash_list_docsets(filter?, details?)`, `dash_search(query, docsets?, types?,
  maxResults?, snippets?)`, `dash_get_page(url, section?, format?, maxChars?)`.
- **No `dash_docset_info` tool** (considered 2026-09-14): the API exposes
  nothing beyond the listing, but the docset bundle does — entry counts per
  type from `docSet.dsidx` (sqlite3; two schemas), landing page and upstream
  site from `Info.plist` (plutil). Folded into `dash_list_docsets({ details:
  true })` (≤ 20 docsets) to keep the surface at three tools. The landing-page
  url needs the `/Dash/<code>/` prefix plus the page-server port. The code is
  per-docset and stable (Dash prefs: `"DHWebServerFullPath - <docset>/Contents/
  Resources/Documents/" = <code>`) but recorded only for docsets Dash has
  already served, and the port is stored nowhere — so one throwaway search
  learns both; candidates are GET-verified because feed docsets ship packed
  (`tarix.tgz`, no `Documents/` folder). Details also report `documentsPath`
  (the conventional `Contents/Resources/Documents/`, when present — readable
  with `grep`/`read`) or `packed`.
- **Model-friendly keys, not identifiers.** Keys derive from the docset
  `platform` (Dash's own keyword: `numpy`, `nlab`) unless it is generic
  (`crate`, `github`, `manPages`, `usercontrib*`, `docgen*`) → versionless
  name (`tokio`, `pytorch`, `kitty`). Resolution accepts key, name, platform,
  identifier or a unique fragment (`torch`). Ambiguity is an error listing
  candidates.
- **`docsets` defaults to all** — fast enough (measured).
- **Page reading in-process** (linkedom + turndown + mathml-to-latex), *not*
  via `safari_get_page_content`: docset pages are static (nLab: 1 MB, 345
  `<math>`, 0 scripts), conversion takes 20–125 ms vs 1.5–4 s in STP, no STP
  dependency, and MathML → LaTeX beats WebKit's flattened glyphs. Default
  scope = the anchored section; `section: "outline"` for big pages.
- **No `enable_fts` tool.** `/search` returns `Full-Text Search` rows for some
  docsets (HTML/MDN, NumPy) and never for others (PyTorch, Python) although all
  report `full_text_search: enabled`; unreliable, so it is documented as a
  bonus, not exposed as a knob.
- **Global tool registration** (`ctx.tools.register` in `apply`): no
  per-session state, so none of browser-automation's per-agent attach
  machinery; subagents get the tools automatically.
- **Auto-launch / auto-enable on demand**, config-gated (`autoLaunch`,
  `autoEnableApi`), nothing contacted until a tool runs. Verified: Dash quit →
  first tool call relaunches it hidden in 1.7 s (`open -g -j -b`); API off →
  re-enabled in ~100 ms.

## 4. Install / run

Preview (no live-config change), from the DSH checkout:

```sh
cd ~/github/deepseek-harness
DSH_HOME=/tmp/tali-dash-plugins-home pnpm dsh web \
  --patch /Users/tali/github/tali-dash-plugins/cordis.dev.yml --port 3081 --no-open
```

The dev overlay already contains the row. For the live web GUI, add to
`~/.dsh/profiles/web/cordis.patch.yml` (hot-reloads the running server — only
when Tali asks):

```yaml
- insert:
    - id: tali-dash-docsets
      name: '/Users/tali/github/tali-dash-plugins/plugins/dash-docsets/index.js'
```

Config surface and defaults: top of `plugins/dash-docsets/index.js`
(`maxChars: 60000`, `defaultMaxResults: 20`, `docsetCacheSeconds: 300`,
`traceFile`).

Headless end-to-end test in an isolated home (real model call, real Dash):

```sh
mkdir -p /tmp/dash-docsets-home && cp ~/.dsh/.credentials.yaml ~/.dsh/settings.yaml /tmp/dash-docsets-home/
cat > /tmp/dash-docsets-headless.yml <<'EOF'
- insert:
    - id: tali-dash-docsets
      name: '/Users/tali/github/tali-dash-plugins/plugins/dash-docsets/index.js'
      config: { traceFile: /tmp/dash-docsets-trace.log }
EOF
cd ~/github/deepseek-harness
DSH_HOME=/tmp/dash-docsets-home pnpm dsh --profile headless --patch /tmp/dash-docsets-headless.yml \
  "dash_search 'Tensor.view' in docset torch, maxResults 1, then dash_get_page its url; report the first line."
```

Offline: `pnpm run check` in the plugin dir (75 assertions, fake Dash client,
saved PyTorch/nLab fixtures). Live: `pnpm run live`.

## 5. What failed and why

| Symptom | Cause | Fix |
|---|---|---|
| Real host: `tool "dash_get_page" returned invalid output: value is not lossless JSON` while every offline test passed | `scope.label` was `undefined` for `dl` anchors. DSH snapshots tool values as lossless JSON; `undefined` is rejected. | All optional fields are `null`; `scripts/check.mjs` walks every returned value for `undefined`. |
| Headless test: `plugin tree failed to load … preview-identity: pending (waiting for service: webServer)` | The repo dev overlay includes web-only plugins; the `headless` profile has no web server. | Use a one-row overlay for headless tests (above). Not a dash-docsets problem. |
| `TypeError: Cannot read properties of undefined (reading '0')` in turndown-plugin-gfm | Its table rule uses `table.rows`, which linkedom does not implement. | Pass turndown the region's **HTML string** (it re-parses with domino). Inside domino `<math>` has a lowercase `nodeName`. |
| Formulas doubled on PyTorch pages (`$d,d+1,…,d+kd, d+1, \dots, d+k$`) | KaTeX emits MathML *and* a TeX `<annotation>`; `textContent` concatenates both. | MathML/KaTeX rule prefers the `annotation`, else mathml-to-latex on the `<math>`. |
| nLab display equations/diagrams silently vanished | They are inline `<svg>`; turndown treats text-less elements as blank *before* rules run. Then its escaping produced `\[diagram\]`. | Swap `svg`/`img` for text placeholders in the DOM first; unescape in `tidy`. |
| rustdoc `Vec::push` anchor returned 64 chars (header only) | Dash's `<a name="//dash_ref_…">` sits in `<summary><section>`; the docs are a sibling `div.docblock` inside `<details>`. | Grow a tiny anchor extent into enclosing containers until it has ≥ 120 chars (never past 50 % of the page). |
| Sphinx field lists rendered `****a**array_like**` | `<dt><strong>a</strong><span class="classifier">…</span></dt>` inside a bold `dt` rule. | Field-list `dt` → `**name** (classifier)`. |
| `defaults read … DHAPIServerEnabled` → "does not exist" | Never toggled. | Absence = off; write the key. |
| Old page URLs → `ECONNREFUSED` | Page-server port changes per Dash launch. | Error text says to run `dash_search` again. |
| `dash_search "transpose"` in PyTorch never lists `Tensor.transpose` | Dash returns **one row per distinct name** (same-name collapse, as in its UI); the API cannot expand the group. Not the plugin's page grouping — verified on the raw API (27 rows, one named `transpose`). | Qualify the query (`Tensor.transpose`); tool description says so. `types` filtering is plugin-side over an over-fetched window (4× `maxResults`, min 60, max 1000) and cannot recover collapsed rows. |
| Man Pages: details show no entries | Its bundled `docSet.dsidx` has an empty `searchIndex`; Dash indexes man pages live in `Data/manIndex.dsidx`. | Rendered honestly as "none in the docset index". |

## 6. Ideas not done

- `dash_get_page` could accept a search-result index instead of a url
  (rejected: stateless tools are simpler; urls also come from page links).
- A `renderer: safari` escape hatch through browser-automation's isolated
  reader (rejected for v1: nothing in docsets needs JS; the model can pass the
  loopback url to `safari_get_page_content` itself if it ever does).
- Direct SQLite reads of `docSet.dsidx` for offline use without Dash running
  (would lose Dash's fuzzy ranking, user-contributed/docgen docset discovery,
  and FTS; the API path launches Dash in 1.7 s anyway).

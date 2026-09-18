# tali-dash-plugins

Tali's plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH),
one directory per plugin under `plugins/`, plus Tali's DSH fork as the git
submodule `deepseek-harness/`. Clone with `--recurse-submodules`. See
`AGENTS.md` for the development guide and **`INSTALLING.md`** for setting up
a fresh Mac (fork build, plugins, Dock app, Tailscale remote).

## Quick start

```sh
git clone --recurse-submodules https://github.com/taliesinb/dsh-plugins tali-dash-plugins
cd tali-dash-plugins/deepseek-harness && pnpm install && pnpm run build   # the fork
cd .. && for p in plugins/*/; do (cd "$p" && pnpm install); done           # plugin deps (build client plugins: pnpm build)
pnpm install-plugins                     # all live plugins into ~/.dsh/profiles/web as bundles
cd deepseek-harness && pnpm dsh web      # run
```

Tooling: `pnpm install-plugins` / `remove-plugins`, `pnpm deploy-remote user@host`
(ship the built fork to another Mac), `pnpm remote-status|logs|restart|stop`.

Recipes — one Markdown file per completed DSH setup/change, written so a
future agent can reproduce it — live in `recipes/` (index in `AGENTS.md`).

## Plugins

- `agent-status-indicator` — floating emoji at the bottom-right of the chat
  area showing the agent's state: 🙂 waiting · 🤨 thinking · 😶 error ·
  per-tool icon while a tool call runs ([>] terminal SVG for bash, ✏️ edit/write, 👁️ read,
  🔍 grep/glob/search, 🌐 web, 🤖 subagent, 🔧 fallback; rule table ported
  from pi-web's toolIcons system) · ✋ badge when blocked on your input.
- `browser-automation` — per-chat Safari (Technology Preview) and Chrome with a
  curated `safari_*` / `chrome_*` tool set: per-session windows addressed by id
  (`s:0:1`, `c:0:0`), isolated page readers (`safari_get_page_content`,
  `safari_get_youtube_notes`), element-aware inline screenshots. Owns the MCP
  forwarding (private SDK connections to `safaridriver --mcp` and
  `chrome-devtools-mcp`); host-only. See its README.
- `dash-docsets` — native `dash_list_docsets` / `dash_search` / `dash_get_page`
  tools over the loopback HTTP API of Dash 8 (macOS docs browser): fuzzy
  symbol search across installed docsets, pages (or just the anchored section)
  as Markdown with MathML → LaTeX; launches Dash hidden and enables its API
  server on demand. Host-only, no MCP. See its README.
- `enforce-model-preset` — bind agent presets to model selections: on a
  committed `model/selection` event in a still-blank session, switch its preset
  per a first-match rule table (`provider`/`model` → `preset`), so tiny local
  models get tiny compositions instead of the ~8.3k-token standard toolbelt.
  Host-only. Background: `recipes/apple-foundation-model-provider.md`.
- `foreign-link-opener` — when the GUI runs as a Safari "Add to Dock" web app,
  links that leave the DSH server (other ports, other hosts) open in the real
  Safari via `open -a` instead of another DSH-branded window. Needed because a
  web app's scope is host-only (the port is not part of it) and `window.open`
  never leaves the app. Browser half intercepts clicks; host half runs `open`.
- `local-model-supervisor` — host local model servers (AFM, llama.cpp, …) from
  dsh itself: start on first `model/selection` for a carried provider, reuse
  across sessions, adopt (and never kill) externally started instances, stop
  owned servers once idle and unselected. Host-only.
- `preview-identity` — red whale `/favicon.svg` + "DSH-dev" `/manifest.webmanifest`
  (and `<title>`) for the preview/dev web server, so a Dock-installed preview
  is distinguishable from the live instance. Load **only** in `cordis.dev.yml`.
- `settings-shortcut` — ⌘. (Ctrl+. off macOS) toggles the web GUI's Settings
  panel in Chrome, Safari and the Dock-installed Safari web app. Browser-only.
  ⌘, is impossible in Safari (the app consumes it before the page sees it);
  its README records the real-keystroke verification.
- `wolfram-kernel-supervisor` — per-chat Wolfram Language kernels
  (`wl:<session>:<kernel>`) supervised over Mathematica's own AgentTools MCP
  server: `wolfram_eval` / `wolfram_run` / `wolfram_show` (retina plots shown
  inline to the user, `.wl` source written beside each PNG) / `wolfram_symbol` /
  `wolfram_lint` / `wolfram_kernel_*` lifecycle tools. Host + browser halves;
  no `mcp__*` names reach the model. See its README.

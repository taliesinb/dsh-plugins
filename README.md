# tali-dash-plugins

Local-only plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
One directory per plugin under `plugins/`. See `AGENTS.md` for the full development guide.

## Quick start

```sh
cd plugins/agent-status-indicator
pnpm install
pnpm build          # or: pnpm watch

# from the DSH source checkout:
cd <dsh-src>
pnpm dsh web --patch <this repo>/cordis.dev.yml
```

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
- `settings-shortcut` — ⌘. (Ctrl+. off macOS) toggles the web GUI's Settings
  panel in Chrome, Safari and the Dock-installed Safari web app. Browser-only.
  ⌘, is impossible in Safari (the app consumes it before the page sees it);
  its README records the real-keystroke verification.

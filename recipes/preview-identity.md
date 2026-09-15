# Recipe: distinguishable preview server (red icon + "DSH-dev" Dock label)

Reproduces the setup that makes the tali-dash-plugins **preview** `dsh web`
server visually distinct from the live one: a red whale icon and a "DSH-dev"
Dock label, so two Dock-installed instances can't be confused. Verified
2026-09-05.

## Background: DSH already serves a web app manifest

"Add to Dock" works because the shipped web app serves a real manifest and
favicon from its built `dist/`:

- `/manifest.webmanifest` — `name: "DeepSeek Harness"`, `short_name: "DSH"`,
  `display: "fullscreen"`, `start_url: "/"`.
- `/favicon.svg` — the whale, one `<path fill="#000">` with a
  `@media (prefers-color-scheme: dark)` style block flipping it to white.

These are served by `@deepseek-ai/dsh-host-frontend-static` through the
webserver's **fallback** seat (`registerFallback`). Named routes
(`WebServer.register`, `kind: 'exact'`) are matched **before** the fallback, so
a plugin can override `/favicon.svg` and `/manifest.webmanifest` with no DSH
source change and no rebuild. There is also `ctx.webServer.tapIndex(html)`
for raw HTML transforms (the manifest does not retitle the browser tab).

## The plugin

`~/github/tali-dash-plugins/plugins/preview-identity/` (`tali-preview-identity`):

- `/favicon.svg` → `favicon-preview.svg`: the stock whale recoloured `#E5484D`,
  with the dark-mode style block removed so it stays red on any background.
- `/manifest.webmanifest` → `short_name: "DSH-dev"`, `name`/`id` carrying the
  port, so macOS installs the preview as a **separate** app rather than the
  same one.
- `<title>` → `DSH preview :<port>` via `tapIndex`.
- Both responses send `cache-control: no-store` — the Dock and browsers cache
  icons otherwise.

Load it **only** in the dev overlay (`cordis.dev.yml`), never the live profile.

## Install to the Dock

1. Start the preview: `cd ~/github/deepseek-harness && pnpm dsh web --patch
   ~/github/tali-dash-plugins/cordis.dev.yml --port 3081 --no-open`
   (stdout prints the tokened URL).
2. Open that URL in Safari → File → Add to Dock.
3. macOS reads the manifest **at install time** — re-add the app after changing
   the icon or label.

## Gotcha that surfaced: dev overlay vs live profile collision

The preview runs `--patch cordis.dev.yml` **against the live home** (no
`DSH_HOME`), so its composition is: profile bundles + `~/.dsh/profiles/web/cordis.patch.yml`
+ the overlay. When a plugin is installed in the live profile AND listed in the
overlay under the same id, the boot fails:

```
Error: dsh: plugin tree failed to load: ... duplicate loader entry id: tali-browser-automation
```

Renaming the overlay id is NOT a fix — it loads the plugin twice (double tools,
double servers). The fix: the overlay is a **complement** to the live profile,
not a complete list — drop from it any plugin already installed live. Current
ownership (2026-09-05):

| Row | Live profile | Dev overlay |
|---|---|---|
| enforce-model-preset | ✅ | — |
| browser-automation | ✅ | — |
| local-model-supervisor | ✅ | — |
| reverse-proxy | ✅ | — |
| agent-status-indicator | — | ✅ |
| preview-identity (red icon) | — | ✅ |

`pnpm dsh web --dump-config --patch cordis.dev.yml` verifies the composition
without booting (exit 0, no `duplicate` line).

Note: PREVIEWING.md recommends a throwaway `DSH_HOME=/tmp/...` for fully
isolated trials; that flow needs the overlay to be *complete*, so copy the
live-profile rows back in when using it. The live-home + overlay combo is what
the real 3081 preview uses.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Boot fails `duplicate loader entry id` | Same plugin in live profile and overlay — remove it from the overlay |
| Dock shows the old black icon | macOS captured the manifest at install time — re-add the Dock app |
| Icon doesn't redraw on the Dock | `no-store` sent, but Safari caches aggressively — close/reopen or re-add |
| `<title>` unchanged | `tapIndex` runs, but the index is auth-gated (401) so curl can't show it — check in the browser |
| Red icon but wrong label | `short_name` is the Dock tooltip; `name` is the app name — both are in the plugin's manifest |

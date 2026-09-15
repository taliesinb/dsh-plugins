# Keyboard shortcut for the DSH Settings panel (`settings-shortcut` plugin)

**Goal (2026-09-15):** press one chord in the web GUI to open DSH's Settings
panel — in Chrome, Safari, and the Dock-installed Safari web app ("Web App"
process) that Tali normally uses. Original wish was ⌘, ; shipped as **⌘.**
Plugin code: `~/github/tali-dash-plugins/plugins/settings-shortcut/` (README
owns the plugin details; this file owns the system-level story).

## Facts that shaped the design

### 1. Safari never delivers ⌘, to the page — so ⌘, is impossible

Safari (and Safari web apps) resolves ⌘, as the app's own *Settings…* menu
key equivalent **before** WebKit dispatches the key event to web content. No
`keydown` fires; there is no web API to claim it. VS Code gave up on ⌘, for
vscode.dev in Safari for exactly this reason
([microsoft/vscode#149478](https://github.com/microsoft/vscode/issues/149478):
"we should not use `cmd+,` on Safari as the default keybinding for
settings"). Chrome *does* deliver ⌘, (only tab/window chords like ⌘W/⌘T/⌘N
are reserved).

Empirical verification (do this for any candidate chord — see §4):

| Chord | Safari Technology Preview | Chrome 152 |
|---|---|---|
| ⌘, | page listener never fired; STP Settings window opened | intercepted, no Settings tab |
| ⌘. | intercepted (Safari's View ▸ Stop does not take precedence) | intercepted |

If literal ⌘, in Safari is ever wanted, the only route is a system-level
remap (Karabiner / BetterTouchTool rule scoped to Safari / the "Web App"
process) mapping ⌘, → ⌘. — outside DSH.

### 2. DSH has no shortcut system and no "open settings" API

- The client has no keybinding registry; the only `metaKey` handling in
  `packages/client/*` is the composer's ⌘‑Enter submit
  (`ui-conversation/src/client/input/editor/keymap.ts`). A plugin installs its
  own `window.addEventListener('keydown', …, true)`.
- The Settings panel (`packages/client/ui-settings-general/src/client/SettingsRoot.tsx`)
  keeps `open`/`activeId` as **component-local React state** — deliberately:
  "No store is registered — modal open state and active section id are
  component-local viewing state." No store action, slot, or host RPC opens
  it (`settings/openSettingsDocument` opens the *YAML file*, not the panel).
  The only seam is clicking the trigger button in the sidebar foot.
- Shell CSS-module classes are `[hash]_[local]`
  (`packages/client/tsdown.client.ts`, `cssModules: { pattern: '[hash]_[local]' }`),
  so `[class$="_settingsArea"]`, `[class*="_trigger"]`, `[class$="_panel"]`,
  `[class$="_close"]` are stable across rebuilds; the hash prefix is not.
  Open state = the trigger's `aria-expanded`. Note several other buttons have
  `aria-haspopup="dialog"` (TurnUsagePanel, ContextMeter, MessageFeedback) —
  scope the selector to the settings area.

### 3. Plugin shape

Browser-only client plugin (`dsh.client.platform: web`, `./client` export →
`lib/client.js`, esbuild banner/footer wrapping per
`tali-dash-plugins/AGENTS.md`). Host half is an empty-ish `apply` that logs.
Modelled on `foreign-link-opener`. Chord match is exact (⌘ without ⌃/⌥/⇧,
not `repeat`) and accepts `key === '.'` OR `code === 'Period'` OR
`code === 'NumpadDecimal'` — System Events synthesizes ⌘. as
`NumpadDecimal`, and a non-Latin layout may report a different `key`.

### 4. Testing a chord properly needs a REAL keystroke

Browser-automation key events (CDP `Input.dispatchKeyEvent`, WebDriver) are
injected below the browser's menu handling and would "prove" any chord
works. Use System Events instead, targeting the chat's private browser
window by title (sandbox: needs `danger-full-access` / approvals disabled —
`osascript` + System Events is denied under `workspace-write`):

```applescript
tell application "System Events"
  set prevApp to first application process whose frontmost is true
  -- find the process ("Google Chrome" / "Safari Technology Preview") whose window title contains the test page title
  set frontmost of target to true
  delay 0.6
  keystroke "." using command down
  delay 1.0
  set frontmost of prevApp to true
end tell
```

Test page: a `keydown` capture listener that `preventDefault`s the chord and
writes "INTERCEPTED" into the DOM; read it back with
`chrome_evaluate_expression` / `safari_evaluate_expression`. Restoring the
previous frontmost app matters — the keystroke steals focus for ~1 s.

## Install / preview commands

```sh
cd ~/github/tali-dash-plugins/plugins/settings-shortcut
pnpm install && pnpm typecheck && pnpm build        # lib/client.js (gitignored; must exist before the server boots)
```

Isolated preview (throwaway home; onboarding "Internal Testing Notice"
overlays the panel on first open — click Continue):

```sh
printf -- "- insert:\n    - id: tali-settings-shortcut\n      name: '/Users/tali/github/tali-dash-plugins/plugins/settings-shortcut/index.js'\n" > /tmp/settings-shortcut-patch.yml
cd ~/github/deepseek-harness
DSH_HOME=/tmp/settings-shortcut-home pnpm dsh web --patch /tmp/settings-shortcut-patch.yml --port 3091 --no-open
# open the printed tokened URL; console must show "[settings-shortcut] ⌘. toggles Settings"
```

Safari gotcha: `safari_navigate` to the tokened URL landed on
"authentication required" once; setting `location.href` to the tokened URL
from inside the page fixed it.

Live install — row in `~/.dsh/profiles/web/cordis.patch.yml` (hot-reloads
the running server; only with explicit confirmation):

```yaml
    # ⌘. toggles the Settings panel (Safari swallows ⌘,).
    # Source: ~/github/tali-dash-plugins/plugins/settings-shortcut
    # Recipe: ~/projects/deepseek-harness/settings-keyboard-shortcut-plugin.md
    - id: tali-settings-shortcut
      name: '/Users/tali/github/tali-dash-plugins/plugins/settings-shortcut/index.js'
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| ⌘, opens the browser's/web app's settings | Expected in Safari; unfixable from web code. Use ⌘. or a system-level remap. |
| Console: `[settings-shortcut] no-trigger` | Shell markup changed (sidebar `_settingsArea` wrapper or trigger `aria-haspopup`). Update selectors in `src/client/index.ts` after reading `ui-sidebar/SidebarRoot.tsx` + `ui-settings-general/SettingsRoot.tsx`. |
| Console: `no-close` | Panel close button class changed (`_close` inside `[role=dialog]._panel`). |
| Chord does nothing, no console line | Bundle not loaded: check `window.__DSH_BOOT__` for `tali-settings-shortcut`, and that `lib/client.js` existed when the server booted. |
| `osascript` "privilege violation (-10004)" / `ps: Operation not permitted` | Session sandbox is `workspace-write`; System Events needs the wider mode (approval prompt or `danger-full-access`). |
| System Events reports `code: NumpadDecimal` | Normal for synthesized ⌘.; the matcher accepts it. |
| Preview onboarding dialog covers Settings | Fresh `DSH_HOME` shows the testing notice + API-key step; click Continue / "Configure later". |

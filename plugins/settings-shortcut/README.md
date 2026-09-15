# tali-settings-shortcut

**⌘.** (Ctrl+. off macOS) toggles the DSH web GUI's **Settings** panel. Works
in Chrome, Safari, and a Dock-installed Safari web app.

## Why ⌘. and not ⌘,

The obvious chord, ⌘, , cannot be made to work in Safari: Safari (and a
Safari "Add to Dock" web app) resolves ⌘, as its own *Settings…* menu
equivalent **before** WebKit dispatches the key to the page. The page never
receives a `keydown`, so `preventDefault` has nothing to act on. Verified
with a real OS-level keystroke (System Events `keystroke "," using command
down`) against a capturing `keydown` listener in Safari Technology Preview:
the listener never fired and STP's Settings window opened. Chrome *does*
deliver ⌘, to the page, but one chord for both browsers was the goal. VS Code
hit the same wall for vscode.dev
([microsoft/vscode#149478](https://github.com/microsoft/vscode/issues/149478)).

⌘. was verified the same way in both STP and Chrome: the page receives it
and `preventDefault` suppresses the browser's own equivalent (Safari's
View ▸ Stop).

## How it works

Browser-only plugin; `index.js` (host half) just logs.

`src/client/index.ts` installs one capture-phase `keydown` listener on
`window`. On the chord it `preventDefault`s + `stopPropagation`s, then:

- trigger `aria-expanded="false"` → `.click()` the sidebar's Settings trigger
- trigger `aria-expanded="true"` → `.click()` the dialog's close button (so
  the shell's own focus-restore path runs, exactly as for a mouse close)

DOM clicks are the only seam: `ui-settings-general`'s `SettingsRoot` keeps
the panel's open state as component-local React state — no store, slot, or
host RPC opens it. The selectors rely on the shell build naming CSS-module
classes `[hash]_[local]` (`packages/client/tsdown.client.ts`,
`cssModules: { pattern: '[hash]_[local]' }`), so the `_settingsArea`,
`_trigger`, `_panel`, `_close` suffixes survive rebuilds:

| what | selector |
|---|---|
| trigger | `[class$="_settingsArea"] button[aria-haspopup="dialog"]` (fallback `button[aria-haspopup="dialog"][class*="_trigger"]`) |
| close | `[role="dialog"][class$="_panel"] button[class$="_close"]` |

If the shell's markup changes, the plugin logs
`[settings-shortcut] no-trigger` / `no-close` to the console instead of doing
anything.

Chord matching: exact — primary modifier only (no ⌥/⇧; ⌘ without ⌃ on Apple,
⌃ without ⌘ elsewhere), not `repeat`, and `key === '.'` **or**
`code === 'Period'` **or** `code === 'NumpadDecimal'` (the last is how
System Events synthesizes ⌘. and covers the keypad).

## Build / test

```sh
cd plugins/settings-shortcut
pnpm install && pnpm typecheck && pnpm build     # -> lib/client.js
```

Isolated preview (throwaway home, this plugin only):

```sh
cat > /tmp/settings-shortcut-patch.yml <<'EOF'
- insert:
    - id: tali-settings-shortcut
      name: '/Users/tali/github/tali-dash-plugins/plugins/settings-shortcut/index.js'
EOF
cd ~/github/deepseek-harness
DSH_HOME=/tmp/settings-shortcut-home pnpm dsh web --patch /tmp/settings-shortcut-patch.yml --port 3091 --no-open
```

Open the printed tokened URL, confirm the console shows
`[settings-shortcut] ⌘. toggles Settings`, press ⌘. twice. A synthetic key
event from browser automation (CDP / WebDriver) bypasses the browser's menu
handling, so a meaningful test needs a real keystroke — e.g. System Events
`keystroke "." using command down` with the window frontmost.

## Install (live web profile)

Add to `~/.dsh/profiles/web/cordis.patch.yml` (hot-reloads the running
server):

```yaml
    - id: tali-settings-shortcut
      name: '/Users/tali/github/tali-dash-plugins/plugins/settings-shortcut/index.js'
```

Then **reload the GUI page once**: the live reload adds the row to the boot
graph, but a page that is already open only fetches the bundles its graph
listed at load time (HMR swaps existing bundles; it does not inject new
modules). Recipe: `recipes/settings-keyboard-shortcut-plugin.md`.

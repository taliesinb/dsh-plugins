# Dock app: integrated macOS title bar, traffic lights in the sidebar, frosted glass

The `dsh-tailscale-remote` Dock app (`~/Applications/DSH.app`, a WKWebView
wrapper — [`dock-app-via-tailnet.md`](dock-app-via-tailnet.md)) used to draw a
stock opaque title bar ("DSH" + traffic lights) above the page. Done
2026-09-22 (macOS 27, Command Line Tools swiftc): the bar is gone, the page
fills the window, the traffic lights sit in the sidebar's top strip beside
the collapse toggle, the sidebar is real translucent window material, and the
window drags from the strip and the conversation header. Everything lives in
`plugins/dsh-tailscale-remote/dock-app/Sources/main.swift`; the plugin README
("Integrated title bar") owns the mechanism list, this recipe owns the
findings and the how-to-test.

## The finding that made it cheap

The shipped client already has the whole layout. The upstream Electron shell
(`apps/desktop`) opens its window with `titleBarStyle: 'hiddenInset'`,
`trafficLightPosition: { x: 16, y: 18 }`, `vibrancy: 'sidebar'`, and its
preload marks `<html data-platform="darwin">`. Every client package keys its
macOS-desktop variant on that attribute (`isDarwinDesktop()` in ui-primitives
reads it at render time):

| where | what `data-platform="darwin"` changes |
|---|---|
| `ui-sidebar/SidebarRoot` | a 52px `topStrip` (drag region) with the collapse toggle at its right, clears the lights at (16, 18); the collapsed sidebar has **no rail** |
| `ui-sidebar/HeaderLeadingControls` | open-sidebar + New Session buttons in `conversation.session.header.leading` while the sidebar is collapsed |
| `ui-conversation/ConversationRoot` | the title row is a drag region, its controls opt out |
| `ui-layout/AppFrame`, `web/base.css` | `html, body, .frame` transparent; the sidebar column a 60% tint; the centre column paints its own opaque base |

So the wrapper only had to (1) set that attribute at document start, (2) make
the window look like Electron's, (3) supply what WKWebView lacks.

## What WKWebView lacks, and the substitutes

- **`-webkit-app-region: drag` is Chromium-only.** A document-start script
  reports a primary `mousedown` on `[class*="_topStrip"], [class*="_titleRow"]`
  (the `<hash>_<local>` names CSS modules compile to; within the top 60px) whose
  target is not a control, with `e.detail`; the wrapper runs
  `window.performDrag(with: NSApp.currentEvent!)` — the message arrives after
  the event, the drag is still in progress (Tauri's `data-tauri-drag-region`
  works the same way). `detail >= 2` applies `AppleActionOnDoubleClick`
  (Zoom default / Minimize / None) instead.
- **Traffic-light position.** AppKit lays the buttons out for a 28px bar;
  there is no public offset. `layoutTrafficLights()` grows the
  `NSTitlebarContainerView` to `2·18 + buttonHeight` (52 with 16px buttons,
  50 with macOS 26's 14px ones) and moves each `standardWindowButton` to
  `(16 + i·spacing, 18)`; a button outside its container's bounds is not
  hit-testable, hence the container resize. Re-run on resize, exit full
  screen, become key. Measured with a temporary hit-test probe: under the
  whole bar `hitTest` returns the WKWebView except on the buttons — the
  title bar of a `.fullSizeContentView` window passes clicks through.
- **Rollover glyphs on moved buttons.** The frame asks the window the private
  `_mouseInGroup:` before drawing each button; with the group moved, AppKit's
  own tracking never says yes. `DockWindow` overrides that selector with a
  flag fed by an `NSTrackingArea` over the moved buttons (Electron's fix).
- **Transparency.** `webView.setValue(false, forKey: "drawsBackground")`
  (private `_drawsBackground`, the switch Electron uses; a wrong key would
  crash at launch — it does not) and an `NSVisualEffectView(.sidebar,
  .behindWindow, .active)` as the window's content view with the web view on
  top. `window.appearance` follows `html[data-ds-theme-source]` so the
  material follows the page's theme. On macOS 26+ View ▸ Window Material ▸
  Liquid Glass puts an `NSGlassEffectView(.clear)` between the blur and the
  page — no permission-free way to see either from an agent (below), the
  operator confirmed both render and the material shows.
- **The client's 60% sidebar tint** was tuned for Electron's flatter
  vibrancy; the wrapper's identity CSS sets
  `html[data-platform="darwin"] [class*="_sidebarCol"]` to an 18% tint
  (specificity (0,2,1) over the module's (0,2,0), no `!important`).

## Testing without Accessibility or Screen Recording

The agent's shell had neither permission: `System Events` → `-10004`,
`screencapture -l <window>` → "could not create image from window". What
works:

- **A process may capture its own windows.** `kill -USR1 <pid>` makes the
  wrapper write `~/Library/Logs/DSH Dock/<app>-<unix>.png`
  (`CGWindowListCreateImage(.optionIncludingWindow)`; also View ▸ Save
  Window Snapshot). The material comes out as a flat fill (the blur is the
  window server's), everything else is exact.
- **Window ids without Accessibility:** a 10-line Swift tool over
  `CGWindowListCopyWindowInfo` (compile with `-module-cache-path` under
  `/tmp` — the sandbox denies the default clang module cache).
- **A/B against a test copy, not the installed app:** copy
  `~/Applications/DSH.app` to `/tmp/…/DSH Test.app`, swap in
  `dock-app/build/DSH`, give it its own `CFBundleIdentifier`
  (`…dsh-dock-app.test`, so UserDefaults/WebKit stores do not collide),
  `codesign -s -`, launch with `open` (a child of the sandboxed shell cannot
  write the log; `open` escapes it). The tailnet URL admits it with no cookie.
- **Hit-testing** — a temporary `SIGUSR2` handler logging
  `frame.hitTest(point)` at the lights, the toggle, the header and the page,
  removed before commit.

Nothing here needs `sudo`, TCC prompts, or a restart of DSH; the installed
app is replaced with `pnpm dock-app:install --name DSH --url <same url>
--fallback http://127.0.0.1:3083/` from the plugin directory (the URL is in
`~/Applications/DSH.app/Contents/Resources/dsh-dock-app.json`; passing it
skips the tailscale lookup). Other wrappers built from the same source
(remote-Mac apps) pick the change up on their next `pnpm remote-app …`.

## Failed / rejected on the way

| Attempt | Outcome |
|---|---|
| `pnpm dsh …` from the sandboxed shell | pnpm 12 tries to install the pinned pnpm into a temp dir the sandbox denies ("create the temporary package manager install directory"); run `node --import tsx/esm apps/cli/src/bin.ts …` directly |
| `xcrun swiftc` for a helper tool | default module cache under `$TMPDIR` is denied; `-module-cache-path /tmp/<dir>` |
| Judging the glass from a snapshot | impossible: single-window captures render vibrancy as a flat fill |
| `NSToolbar` with `.unified` style to get a 52px bar "for free" | not tried — an empty toolbar view sits above the content and would take the clicks the page needs |

## Native drag regions (2026-09-29): "sometimes it grabs, sometimes it selects text"

The first drag bridge (page `mousedown` → `postMessage` → `performDrag(with:
NSApp.currentEvent)`) was fickle by construction: the message crosses from
the WebContent process *after* WebKit has already started a text selection,
and by then `NSApp.currentEvent` is often no longer the press, so the guard
failed and the click merely selected header text. Worse, only elements
carrying the `_topStrip` / `_titleRow` classes counted — the title row is a
30px strip inside a 76px header, so the header's padding was undraggable, and
the session title is a `<button>` (the session picker's crumb), so the one
thing everybody grabs was excluded as a control.

Replaced by the Chromium/Electron model, `DockWebView` (a `WKWebView`
subclass) + the bridge script:

- **The page reports a hit-tested map of the top 52 CSS px**: every 6px
  column of each 8px strip is probed with `elementFromPoint`; a point is
  draggable unless it lands on a *hard control* — `button[aria-label]`
  (icon buttons: sidebar toggles, QR, ⋯, right sidebar), buttons under
  `_headerActions` / `_headerUtilities` / `_headerCorner` (background jobs),
  tabs, inputs, menus/popups, the sidebar resize handle (`_handle`, any
  `resize`/`grab` cursor). Text, padding, the wordmark, the title crumb and
  the mode chip are draggable. Re-reported ≤ 10/s on mutations, resize,
  scroll, transition/animation end (coalesced; trailing 250ms).
- **`DockWebView.mouseDown` consumes a press inside the map before WebKit
  sees it** and tracks it with `window.nextEvent(matching:)`: ≥ 3pt of
  movement → `window.performDrag(with: press)`; release without movement →
  `super.mouseDown` + `super.mouseUp` replayed, so a click on the title still
  opens its picker. Double-click → the Desktop & Dock title-bar action.
- The old JS path stays as a fallback for a one-frame-stale map, now with
  `preventDefault()` so no selection can start; the title regions are also
  `user-select: none`.

Measured facts along the way:

- `WKWebView` on macOS is `isFlipped == true` with one `WKFlippedView` child
  that handles no events — overriding `mouseDown` on the subclass is
  sufficient. CSS px = view points ÷ `pageZoom`; with `magnification != 1`
  the mapping is skipped (falls through to WebKit).
- **CGEvent mouse events posted to the pid never reach a view** (keyboard
  events do — the `ax-drive` chords): AppKit drops mouse events without a
  window, and tagging `mouseEventWindowUnderMousePointer` does not help. So
  the wrapper has a headless **test hook**: launched with `DSH_DOCK_TEST=1`
  (run the executable directly; `open` cannot pass env), it listens for the
  distributed notification `io.github.taliesinb.dsh-dock-app.test-event`
  `{ x, y, clicks, kind: down|up }` (points from the window's top-left) and
  dispatches a real `NSEvent` through `window.sendEvent`; a drag decision is
  logged as `native drag at x,y` instead of performed (a synthetic press
  cannot drive a window-server drag). Verified the map and the double-click
  path that way; the drag itself was verified by hand — ask the maintainer
  to drag, it is faster than any probe.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Traffic lights back at the top-left corner of a 28px bar after leaving full screen | `layoutTrafficLights` did not run — it hooks `windowDidExitFullScreen`; check the delegate is set |
| Cannot drag the window from the sidebar strip | the bridge script's selectors no longer match (`_topStrip` / `_titleRow` renamed upstream) or the click was on a control; `~/Library/Logs/DSH Dock/<app>.log` shows nothing for drags — add a log line to `titlebarMouseDown` to check the message arrives |
| Sidebar opaque gray, no desktop showing through | `drawsBackground` KVC no longer honoured (WebKit change) or the client's darwin tint rule changed class names; View ▸ Save Window Snapshot cannot show this — look at the screen |
| Page content hidden under the lights | the client did not get `data-platform="darwin"` before first paint (script order in `installUserScripts`) — the sidebar then has no top strip |
| Traffic lights never show × – + on hover | `DockWindow._mouseInGroup:` override not called (AppKit renamed the private selector) — the buttons still work, only the glyphs are missing |

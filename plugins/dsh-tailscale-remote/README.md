# dsh-tailscale-remote

**Linux desktop client:** `nix run .` from the repository root launches the
Electron thin client with automatic loopback forwarding. See
[linux-app/README.md](linux-app/README.md) for setup and usage.

Drive this DeepSeek Harness Web GUI from another device on your tailnet, at

```
https://<node>.<tailnet>.ts.net/dsh/
```

One feature, on purpose. `dsh-full-remote` does tunnels, invites, device
approval, audit logs and a Tailscale route; this plugin does only the
Tailscale part, from scratch, in ~600 lines:

- a **loopback reverse proxy** (`proxy.mjs`) in front of DSH that
  authenticates each request and rewrites it so DSH's own `/api` Host/Origin
  fence and cookie auth are satisfied;
- a **Tailscale Serve path route** (`tailscale.mjs`):
  `tailscale serve --bg --yes --https=443 --set-path=/dsh http://127.0.0.1:3083`;
- a **"Tailscale remote"** settings section (`src/client/index.tsx`):
  Enable / Disable, the URL with copy-to-clipboard, a comma-separated list of
  allowed Tailscale users, a QR code of the URL *with* the access token, and a
  **This Mac** group with the two pieces below;
- a **per-session QR button** in the Session header (top right, beside the
  right-dock toggle; `src/client/session-qr.tsx`): a QR code and link that
  open *that one Session* chrome-less on a phone ([below](#per-session-qr-code));
- a **Dock app** for this Mac (`dock-app/`, `dock-app.mjs`): a WKWebView
  wrapper built with `swiftc` that opens the tailnet URL — admitted by the
  node's *own* Tailscale identity, so it never holds a token or an expiring
  cookie — and falls back to the loopback relay + token when Tailscale is off;
- an **always-on relay** (`relay/`) installed as a LaunchAgent: the port
  `tailscale serve` targets is always answered; when DSH is not running the
  relay starts `dsh web` and shows a self-reloading "starting" page.

English only.

## Requires the patched DSH

Tailscale strips the mount prefix before proxying (`/dsh/x` arrives as `/x`),
and stock DSH anchors its computed URLs at the origin (`/api/...`, the
`/api/remote.mux` WebSocket, `/plugins/...` bundles, `<base href="/">`). The
DSH branch **`fix/tailscale-mounting`** (worktree `~/github/deepseek-harness-tailscale`)
makes every Host URL *document-relative*, so the same build works at
`http://127.0.0.1:3080/` and behind the `/dsh/` mount. Run DSH from that
branch; on `master` the remote page loads its HTML and then 404s on
everything else.

## Topology

```
phone / this Mac's Dock app ─▶ https://<node>.ts.net/dsh/
  └▶ tailscaled (TLS; injects Tailscale-User-*) ─▶ relay 127.0.0.1:3083 (LaunchAgent)
       └▶ proxy 127.0.0.1:3084 (inside DSH) ─▶ DSH 127.0.0.1:3080
```

`publishPort` (3083) is what Serve targets; `listenPort` (3084) is the proxy.
Set `publishPort: 0` to publish the proxy directly and skip the relay.

## How a request is admitted

First the same-origin fence: `Host` must be the tailnet FQDN (with or without
`:443`), the relay's or the proxy's own loopback authority — anything else is
`421` (DNS rebinding) — and an attached `Origin` must equal that Host or the
request is `403`. Then exactly one of, in this order:

1. **Allowed Tailscale user.** Serve injects `Tailscale-User-Login` (tailnet
   verified; a client-supplied copy is overwritten). It is trusted only when
   the request also looks like a Serve peer — loopback socket and a rightmost
   `x-forwarded-for` inside `100.64.0.0/10` or `fd7a:115c:a1e0::/48` — and the
   lower-cased login is in the allowlist **or is this node's own login**
   (`tailscale status --json` → `Self.UserID`; tagged nodes have none). Serve
   injects the node's login for requests the node makes to itself, which is
   how the Dock app and Safari on this Mac get in with no credential at all.
   Empty allowlist = nobody else by login.
2. **Token.** `GET /?token=<token>` (what the QR encodes) with the exact
   standing token sets the proxy's own `HttpOnly` cookie and redirects to
   `/dsh/` (behind Tailscale) or `./` (on the loopback listener). The token
   is 192 bits, persisted 0600 in `$DSH_HOME/tailscale-remote.json`.
3. **Cookie.** `dsh-tailscale-remote=<HMAC(token)>`. Rotating the token
   invalidates every cookie; allowed users are unaffected.

Everything else is `401`. `/manifest.webmanifest` and `/favicon.svg` pass
anonymously (DSH serves them public too; browsers fetch manifests without
cookies). The plugin's own control channel `/tailscale-remote/*` is answered
`403` and never forwarded for non-operators — they can view the section but
cannot flip the route or read the token.

**Who operates.** This node's own requests (rightmost `x-forwarded-for` is one
of `Self.TailscaleIPs`) always; and, with `identityOperators: true` (the
default), every request **admitted by Tailscale identity** — the same
Serve-injected login the allowlist trusts. Token/cookie holders (QR) are never
operators. Operator index responses carry
`globalThis.__DSH_TRANSPORT__ = { ownsHost: true }`, so the shell reports
`ctx.connection.isLoopback`, Settings persist on the host as at
`http://127.0.0.1:3080/`, and host-settings panes (e.g. a plugin's
kernel-location card) appear; other devices stay memory-only. Why identity: on a shared machine
with one DSH per account, the person an instance belongs to is never "the node
itself", so the self-address rule alone left every owner with a read-only
panel and no host settings (2026-09-21). Set `identityOperators: false` for
the old hybrid-era policy where admission and administration are separate.

Admitted requests are forwarded to `http://127.0.0.1:<dsh port>` with
`Host`/`Origin` rewritten to that authority, `sec-fetch-site: same-origin`,
the browser's cookies replaced by the DSH browser-session cookie the plugin
obtained by exchanging its own launch token (`ctx.connection.authenticatedUrl`),
Tailscale identity headers stripped, and `x-forwarded-*` re-derived.
WebSocket upgrades take the same gate. Index responses get a head script that
turns `https://node/dsh` into `https://node/dsh/` — both arrive as `/`, and
without the slash the shell's relative asset URLs resolve at the site root.

The token exchange keeps every other query parameter, like DSH's own
(`?token=…&embed=<id>` → `<mount>/?embed=<id>`), which is what the
per-session links rely on.

**Threat model note.** Any local process can connect to the loopback
listener and forge the identity headers — that equals full local access,
which a local process already has. The gate protects against the tailnet,
not the machine.

## Config (`cordis.patch.yml`)

| key | default | |
|---|---|---|
| `instance` | `''` | `preview` etc.: suffixes the relay label (`….preview`), its symlink/logs (`-preview`), the Dock app bundle id (`….preview`) and the state file (`tailscale-remote-preview.json`), so a second DSH's remote coexists with the main one |
| `listenHost` | `127.0.0.1` | proxy bind address (keep loopback) |
| `listenPort` | `3084` | proxy port |
| `publishPort` | `3083` | port `tailscale serve` points at — the relay; `0` publishes the proxy itself |
| `mountPath` | `/dsh` | path mount on the node |
| `servePort` | `443` | HTTPS port on the node (the Tailscale cert covers the FQDN only) |
| `tailscalePath` | `''` | CLI override; default resolves PATH, then `/Applications/Tailscale.app/Contents/MacOS/Tailscale`, `/usr/local/bin`, `/opt/homebrew/bin` |
| `stateFile` | `''` | `$DSH_HOME/tailscale-remote.json` |
| `cookieName` | `dsh-tailscale-remote` | |
| `relayStart` | `pnpm dsh web --no-open` | what the relay runs (in a `zsh -lc` login shell) when DSH is down |
| `relayCwd` | `''` | where it runs; `''` = the cwd of the DSH that installed the agent |
| `relayLogDir` | `''` | `$DSH_HOME/logs` (`relay.log`, `dsh-web.log`) |
| `dockAppName` | `DSH` | `~/Applications/<name>.app` |
| `identityOperators` | `true` | identity-admitted users may use the control channel and get `ownsHost`; `false` = this node's own device only |
| `dockAppGlyphColor` / `dockAppTileColor` | `#000000` / `#ffffff` | icon: `dock-app/icon.svg` on a rounded tile |
| `loopbackForward` | `admitted` | who may forward this host's loopback ports to their device ([below](#loopback-port-forwarding)): `admitted` (anyone the proxy let in), `operators`, `off` |

Persisted: `{ enabled, allowedUsers, token }`. tailscaled persists the route
itself; on boot the plugin restarts the proxy when `enabled` and republishes
the route if `serve status` no longer shows it. Unloading the plugin closes
the listener but leaves the route (it comes back with the next boot).

### Directory picker pinned to the in-app browser

The bundle patch also disables the web-app's `directory-picker` row (the
`-auto` chooser) and inserts `directory-picker-browse` +
`ui-directory-picker-browse`. Stock DSH on a loopback bind with a local display
resolves `-auto` to the **native OS folder dialog**, which opens on the host's
screen — a phone or laptop on the tailnet (and any browser automation) cannot
see or drive it, so "Add workspace" would silently hang remotely. The in-app
browser works from every client. Bundle layers are read at profile start, so
this needs a DSH restart after installing the plugin (`launchctl kickstart -k
gui/$UID/io.github.taliesinb.dsh-web-relay`). To get the native chooser back
anyway, override in the profile's `cordis.patch.yml` (later layer wins per row):

```yaml
- id: directory-picker
  disabled: false
- id: directory-picker-browse
  disabled: true
- id: ui-directory-picker-browse
  disabled: true
```

Do not *also* insert those two ids from another layer — duplicate ids fail the
boot. (`dsh-full-remote` carried the same pin; it disappeared with that plugin's
removal on 2026-09-16, which is when the native dialog first appeared.)

## Per-session QR code

The QR-glyph button in the Session header's utilities row (slot
`conversation.session.header.utilities`, after the `…` menu) opens a panel
with a QR code for the Session on screen and one checkbox, **Only you**
(ticked by default). The link itself is never displayed; clicking the QR
code copies it ("Link copied").

```
https://<node>.ts.net/dsh/?embed=<sessionId>                          # Only you ✓ — identity only
https://<node>.ts.net/dsh/?token=<standing token>&embed=<sessionId>   # Only you unticked — the token rides along
```

`?embed=<sessionId>` is the DSH fork's chrome-less presentation (branch
`feat/embed-session`, the same page `dsh-remote-workspaces` frames): one
Session, no sidebar, navigation pinned to it and its subagent children,
composer and approvals intact, persisted browser state namespaced per
Session. At phone width it lays out well as it is. Facts and limits:

- **It is a presentation choice, not a permission.** A tokened link admits
  the device exactly like the Settings QR code does — drop `?embed=` and the
  whole GUI is there. Identity-only links need the device's Tailscale login
  on the allow list. Rotating the token voids every tokened link.
- The public URL and the token come from the control channel's `status`
  (operators only). Off the host — a tailnet tab, a direct-remote Dock app —
  the panel falls back to the document's own directory URL, token-less, with
  **Only you** ticked and disabled. On a loopback tab with the route off it
  explains instead of showing a QR.
- The button is not registered inside an embedded page itself
  (`embedPresentation()` set), so a phone never sees it.
- Session ids keep their `session-` prefix; a bare UUID shows the blank hero.
- The QR is rendered in the browser (`uqr`, bundled); nothing runs while the
  panel is closed, and opening it makes one `status` call.
- Not verified on a real phone yet: iOS "Add to Home Screen" (separate
  cookie store; the saved URL is the post-exchange one without the token) and
  the right dock at phone width.

## Control channel

`POST /tailscale-remote/<endpoint>`, a `webServer` prefix route gated by
`ctx.connection.requestRejection` (DSH's Host/Origin fence + cookie), JSON envelope `{type:'client-request', rpcId,
method, payload:{args}}`: `status`, `enable`, `disable`,
`set-users {allowedUsers: "a, b"}`, `rotate-token`, `install-dock-app`,
`uninstall-dock-app`, `install-relay`, `uninstall-relay`, `server-status`,
`server-act {target, action}`. The proxy forwards the channel for **this
node's own** admitted requests (Dock app, Safari on the Mac) and, by default
(`identityOperators`), identity-admitted users; token holders get 403 and a
read-only panel.

## The "Server" pane (`server.mjs`)

A second settings section right after *Tailscale remote*:

- **Processes** — the relay (LaunchAgent pid; *Restart* = `launchctl kickstart -k`,
  which takes DSH down with it, *Stop* = `bootout`), **dsh web** (this
  process; *Restart*/*Quit* = graceful SIGTERM after the reply — the relay
  starts it again on the next request and the page comes back through the
  "Starting DSH…" screen), the **Dock app** (*Launch*/*Relaunch*/*Quit* by
  bundle path) and **afm** when running (*Stop*; the supervisor restarts it on
  demand). Uptime/RSS from `ps -o etime=,rss=` (macOS has no `etimes`).
- **Clients** — everyone who reached this DSH in the last 2 minutes, from a
  tracker on DSH's own `http.Server` (`ctx.webServer.server`, TypeScript-private
  but plain JS property access; guarded): Tailscale login and tailnet IP for
  proxied clients (the proxy sets `x-dsh-tailscale-remote-{admitted,login,self}`
  after admission; client copies are dropped), `local` + socket peer for direct
  loopback tabs, a short user-agent label (`DSHDock/1.0` → "DSH Dock app"),
  open `/api/remote.mux` WebSockets (= live GUI tabs), request count, and the
  last `POST /api/session/*` body's `sessionId`/`cwd` (observed, never
  consumed) resolved to a workspace via the sessions store. The Typert wire
  shape is `payload.args` keyed by **parameter name** — `session/prompt`
  arrives as `{ args: { request: { sessionId, … } } }` — so the sniffer looks
  one level down (it found nothing until it did; measured 2026-09-21).

## The `sessionOwners` service (`owners.mjs`)

DSH itself is single-user: a session carries no person. The tracker above,
though, sees both the Serve-verified login of every proxied request and the
session id inside every `POST /api/session/<method>` body, so this plugin
joins them and offers the result to other **host** plugins as `ctx.get('sessionOwners')`
(optional coupling — absent means "single-user machine"):

```js
owners.of(sessionId)  // → { owner, actor, first, last, logins } | undefined
owners.list()         // every attributed session
owners.selfLogin()    // this node's own login (what loopback requests count as)
```

`owner` is the login of the first request that *drove* the session
(`session/prompt`, `updateQueue`, `fork`, `selectModel`, `rename`; a mere
look — `attach`, `history` — becomes owner only if nobody ever drove it),
`actor` the latest driver. Identity of a request: the proxied login; the
node's own login for direct loopback requests (Dock app / tab on the Mac
itself) and for `self` proxied ones; the literal `token` for QR/cookie
clients. Persisted, debounced, mode 0600, at `$DSH_HOME/session-owners[-<instance>].json`
(config `ownersFile`). Attribution, not authorization: it records who asked
and grants nothing. First consumer: the `symba-dsh` plugin (private
symbolica-ai/symba repo, `integrations/dsh/`), which puts the actor's short
login into the Forge node name (`dsh:tali:0`) so chats of different people
behind one shared DSH host — all running `symba` as the host's tailnet
identity — can be told apart and guarded.

## The Dock app (`dock-app/`)

Why not Safari's *Add to Dock*: that web app authenticates with DSH's 30-day
browser cookie and has no URL bar to renew it, and it cannot be created by
anything but Safari — Launch Services refuses template-app bundles whose
signature is not in a data vault only Safari's private
`com.apple.private.launchservices.templateapp.creation` entitlement can write
(measured: a byte-identical bundle with a fresh UUID is "executable is
missing"). The wrapper needs no permission of any kind.

`dock-app/Sources/main.swift` (~350 lines, AppKit + WebKit): probes the tailnet
URL with a HEAD (any HTTP answer counts — the relay's 503 splash included),
else loads `fallbackUrl` (`http://127.0.0.1:<publishPort>/?token=…` read from
the state file), else an offline page that retries every 5 s. Injects
`__DSH_TRANSPORT__.ownsHost` itself, opens out-of-scope links and every
`window.open` in the default browser, persistent data store, menu bar (⌘R
reload, Reconnect, zoom, full screen, ⌘⇧O open in browser, ⌘⇧C copy address),
frame autosave, real second windows for in-scope `window.open`/`target=_blank` (until 2026-09-22 the URL was loaded into the main window — an inline-image click replaced the whole GUI and the red button then closed the app; popups share the app's cookie store and `window.close()` works), a menu fix (WKWebView's mousedown default on a Radix `menuitemradio`/`menuitemcheckbox` row moves focus to `<body>`, the menu's focus-outside guard unmounts it before `pointerup`, and the click selects nothing — model and reasoning-effort rows were unselectable in every Dock app until 2026-09-21; the wrapper now `preventDefault()`s that mousedown, radio/checkbox rows only, plain `menuitem`s such as "Model ›" work unaided and break when touched), page diagnostics to `~/Library/Logs/DSH Dock/<app>.log` (uncaught errors, unhandled rejections, console.error/warn, failed or non-GET fetches, WebSocket closes, RPC replies carrying `ok:false`), a one-shot `open-panel` hint from the page (`dshDock` message: start directory, hidden files, prompt — used by `/import-api-keys` to open in `~/.pi/agent`), `isInspectable` (Safari ▸ Develop ▸ this Mac), downloads to
~/Downloads. Not Safari: no Web Notifications, no Safari extensions.

**Loopback links (2026-09-23).** A `localhost` / `127.0.0.1` URL in the page
names the *remote's* loopback (an agent's dev server, `$DSH_WEB_URL`), so
before such a URL loads the wrapper forwards that port from the DSH host to
this Mac and lets the navigation proceed — see [Loopback port
forwarding](#loopback-port-forwarding). View ▸ **Forwarded Ports** lists and
closes them.

**View ▸ Desktop / Mobile (2026-09-23).** A layout switch for trialing phone
styling on the Mac, radio items in the View menu (Desktop is the default and
normal state). **Mobile** stamps `<html data-dsh-view="mobile">` — a
document-start user script re-registered on every toggle so reloads carry
it, plus a live `evaluateJavaScript` for the current page — publishes it as
`__DSH_DOCK__.view`, persists it in the app's UserDefaults
(`dsh-dock-app.viewMode`, so a relaunch keeps the mode), remembers the
current frame (`dsh-dock-app.desktopFrame`) and resizes the window to
iPhone content size **390×844** (top-left anchored, clamped to the screen;
`minSize` width lowered 480 → 360). **Desktop** removes the attribute and
restores the remembered frame. Plugins key their phone rules on the
attribute beside their `max-width` media query — `tali-phone-ui` emits every
rule twice for exactly this — so the flag alone selects the mobile view at
any window width, while the resize makes the real media queries fire too.
The page's own state (session, scroll position) is untouched; the toggle is
logged to `~/Library/Logs/DSH Dock/<app>.log` (`view mode: mobile`).
Headless test: `dock-app/Tools/ax-drive.swift` (PID-keyed Accessibility
driver — System Events resolves same-named "DSH" processes to the live one;
see `recipes/phone-ui.md`).

**<App> ▸ Settings… (⌘,) (2026-09-22).** The standard macOS chord toggles
the GUI's Settings panel. Safari swallows ⌘, before any page sees it (why
`tali-settings-shortcut` ships ⌘. — `recipes/settings-keyboard-shortcut-plugin.md`),
but this wrapper owns its menu bar, so a real menu item carries the key
equivalent and its action drives the page: `evaluateJavaScript` dispatches
the plugin's ⌘. chord as a synthetic `keydown` on `window` (the plugin's
capture listener `preventDefault`s it → `dispatchEvent` returns false → done,
logged `settings: plugin`); when no plugin claims it, the same script clicks
the sidebar's Settings trigger / the open panel's close button itself (the
plugin's selectors; `settings: opened|closed`), so an instance whose server
lacks the plugin (a remote Mac) works too. `no-trigger`/`no-close` (shell
markup changed) beeps and logs. Verified with real ⌘, keystrokes posted by
PID (`CGEvent.postToPid`, virtual key 43) to DSH Preview (fallback path) and
the script against the live GUI (plugin path), 2026-09-22.

**Integrated title bar (2026-09-22).** The window has no title text and no
bar fill (`titlebarAppearsTransparent`, `titleVisibility = .hidden`,
`titlebarSeparatorStyle = .none`, `.fullSizeContentView`); the page fills
the window and the traffic lights float over it at Electron's
`trafficLightPosition: { x: 16, y: 18 }`, which is the geometry the shipped
client's macOS-desktop layout is drawn for. That layout is switched on by a
document-start script setting `<html data-platform="darwin">` — the same
mark the upstream Electron shell's preload sets — and gives: a 52px sidebar
top strip with the collapse toggle beside the lights, the open-sidebar and
New Session buttons in the conversation header while the sidebar is closed
(no rail), a transparent page background, and drag regions
(`-webkit-app-region: drag` on the sidebar strip and the conversation title
row — which **WKWebView ignores**, so a second document-start script posts
a `titlebar` message for a primary mousedown on those elements that is not
on a control, and the wrapper calls `performDrag(with: NSApp.currentEvent)`;
a double click applies the System Settings title-bar action — Zoom,
Minimize or None from `AppleActionOnDoubleClick`). Moving the lights:
AppKit lays them out for a 28px bar, so `layoutTrafficLights()` (on launch,
every resize, leaving full screen, becoming key) grows the title-bar
container to `2·18 + button height` and sets each button's origin; a button
outside its container is not hit-testable, hence the container. Moved
buttons also lose AppKit's rollover (the × – + glyphs), which the frame
decides by asking the window the private `_mouseInGroup:` — `DockWindow`
overrides it with a flag kept by a tracking area over the moved group (what
Electron does for `trafficLightPosition`). Hit-testing verified: the page
receives clicks under the whole bar except on the buttons themselves.
**Window material:** the web view paints no background (`drawsBackground =
false` via KVC, the private switch Electron uses) and sits on an
`NSVisualEffectView` (`.sidebar`, `.behindWindow`, `.active`), so the
desktop blurs through the page's sidebar column; the client tints that
column 60% (tuned for Electron), and the wrapper's identity CSS thins it to
18% so the material is what one sees. View ▸ **Window Material** switches
between *Frosted* (that, the default) and *Liquid Glass* (macOS 26+: an
`NSGlassEffectView(.clear)` hosting the page over the same blur), persisted
as `dsh-dock-app.windowMaterial`. The page's theme choice
(`html[data-ds-theme-source]`, watched by the bridge script) sets
`window.appearance` so the material follows light/dark/system. A
single-window capture (`kill -USR1 <pid>` → `~/Library/Logs/DSH Dock/
<app>-<time>.png`, or View ▸ Save Window Snapshot; an app may capture its
own window without Screen Recording permission) shows the material as a
flat fill — the blur is composited by the window server — so judging the
glass needs eyes on the screen. Popup windows keep a standard title bar.

**Identity (2026-09-21).** The wrapper carries its own name and icon colour
into the page: a document-start script sets `globalThis.__DSH_DOCK__ =
{ name, glyphColor }` and appends a `<style>` (all rules `!important`) that
renames the sidebar wordmark "DSH Local Build" → the app name
(`span[class*="_localBuildTitle"]{display:flex;font-size:0}` +
`::before{content:"<name>"}`), colours the whale like the Dock icon
(`_brandMark`/`_railMark`, skipped for `#000000` = stock), and quietens the
build-version chip; the window title substitutes the app name for the client's
generic product title. `glyphColor` is written into `dsh-dock-app.json` by the
installer. These are the same rules the `tali-instance-identity` DSH plugin
injects server-side (that plugin's title script defers to `__DSH_DOCK__.name`),
so a remote whose server lacks the plugin still reads right inside its Dock
app, and inside the app the app's name always wins. Rebuild + reinstall after
editing `main.swift`: `pnpm dock-app:install …` / `pnpm remote-app …` with the
existing spec (`dock-app:build` alone only refreshes `dock-app/build/`).

`dock-app.mjs` builds it (`xcrun swiftc`, cached by mtime, ~5 s cold;
`Tools/make-icon.swift` renders `icon.svg` onto a rounded tile → `.icns`),
assembles `Info.plist` + executable + icon + `dsh-dock-app.json`, ad-hoc signs
(`codesign -s -`), replaces `~/Applications/<name>.app` **only** when that is a
Safari web app or an earlier copy of ours (anything else: refuses), registers
it with `lsregister`, pins a Dock tile unless one already points at the path
(the Dock plist holds `<data>` blobs, so tiles are read/written as XML — a
JSON round trip fails silently), and launches it. Bundle id
`io.github.taliesinb.dsh-dock-app` is stable, so WebKit data persists across
reinstalls.

## Loopback port forwarding

**The problem.** An agent on the DSH host starts a dev server and writes
`http://127.0.0.1:5173/`; the GUI turns that into a link (Markdown allowlist,
inline-code URLs — see `recipes/inline-links-remote-audit.md`). In the Dock
app that link names *this Mac's* loopback: connection refused, or the wrong
service. Nothing in DSH knows that "loopback" means the server's. The same
applies to `$DSH_WEB_URL` (`http://127.0.0.1:3080`), which the model is told
is "this GUI".

**The mechanism** — one WebSocket per TCP connection, through the channel the
page already uses, so the URL works *verbatim* (Host header, absolute paths,
cookies, HMR socket):

```
client Mac                                                    DSH host
Dock app                                                       dsh-tailscale-remote
  NWListener 127.0.0.1:5173 ──URLSessionWebSocketTask──▶ <mount>api/loopback-forward?port=5173
        ▲              (Serve: TLS + identity; proxy.mjs forwards any admitted upgrade)   │
        │ WKWebView / Safari                                   forward.mjs on DSH's http.Server ──▶ net.connect(127.0.0.1:5173)
   http://127.0.0.1:5173/  (verbatim)                          (uid guard via lsof, then a byte pipe)
```

- **Host half, `forward.mjs`** — an exact-path upgrade route
  (`ctx.webServer.registerUpgrade`) behind DSH's own browser-session gate.
  Policy, in order: (1) `loopbackForward` — `admitted` (default; a token
  holder already drives an agent with a shell here, so forwarding this
  account's ports adds no privilege), `operators` (`x-dsh-tailscale-remote-self`
  = this node's own device / identity-admitted users), `off`; direct loopback
  callers (no proxy headers) pass. (2) **Reserved ports** — this instance's
  DSH, proxy and relay ports are 403 `reserved` (the remote serves them; a raw
  forward would only bypass the fence). (3) **The uid guard** —
  `lsof -nP -iTCP:<port> -sTCP:LISTEN -F pcun` must show the listener and every
  visible one must belong to the uid running this DSH. On the shared remote machine
  with one DSH per account that is exactly "a server *this account's* agent
  started"; other accounts' listeners are invisible to an unprivileged `lsof`
  → 404 `nothing-listening`. Denials are HTTP statuses **before** the 101
  (`X-Dsh-Forward-Error: reserved|nothing-listening|foreign-owner|disabled|
  not-operator|connect-failed|lsof-unavailable|too-many-connections`), so the
  client can tell them apart; after the handshake the server sends a text
  frame `{"type":"connected",port,pid,command}` and then pipes binary frames
  both ways (own RFC 6455 framing, no `ws` dependency — the remote deploy
  installs third-party deps from a pinned manifest). Cap 64 connections,
  connect timeout 5 s, close code 1000 on target EOF / 1011 on target error.
- **Client half, `dock-app/Sources/PortForward.swift`** — `LoopbackLink`
  recognises `localhost`, `127.*`, `[::1]`, `0.0.0.0`, `*.localhost`;
  `PortForwarder.ensure(remotePort:)` opens one **probe** WebSocket (the
  remote's verdict arrives as the HTTP status via `task.response`, or as the
  `connected` frame), then binds `127.0.0.1:<same port>` with `NWListener`
  (`requiredInterfaceType = .loopback`; **a `newConnectionHandler` must be set
  before `start` or the bind fails with EINVAL**), falling back to a free port
  when the number is taken here (the URL is rewritten to it; still loopback,
  so Vite's default host check stays happy). Each accepted connection is a
  `ForwardConnection`: NWConnection ↔ `URLSessionWebSocketTask`, one ordered
  outbound queue (the browser speaks first; its bytes wait for `connected`),
  high-water pause at 32 chunks, teardown from either side. The request
  carries the WKWebView data store's cookies for the host (token-exchanged
  fallback entry); on the tailnet path tailscaled injects identity anyway.
  Listeners live until quit, View ▸ Forwarded Ports ▸ Close, or an idle hour.
- **Where the app intercepts (`main.swift`).** `decidePolicyFor
  navigationAction` (fires for **subframes** too — the GUI's Sidebar Browser
  iframe, kept as a fallback although WKWebView then blocks the mixed-content
  load) and `createWebViewWith` (target=_blank, `window.open`, the Browser
  tab's "Open in system browser", and — via the browser half — every plain
  click on a loopback link): a loopback URL outside the app's own entry
  points → `forwardLoopback` → the URL goes to the default browser (or the
  iframe is allowed to proceed for the subframe path). A `reserved` refusal means "the remote DSH itself": the link is
  mapped onto the app's mount (`$DSH_WEB_URL/…` → `https://node/dsh/user/…`)
  and loaded in the app. Other refusals show one sheet per port per 30 s and
  are logged to `~/Library/Logs/DSH Dock/<app>.log`.

**Tests.** `pnpm test` covers the host half (policy helpers, frame codec,
real `lsof` on a listener we own, the upgrade handler end to end with Node's
`WebSocket` client). `pnpm forward:smoke` compiles `PortForward.swift` with a
CLI harness (`dock-app/Tools/forward-smoke.swift`) and runs it against the
real route: refusal codes reach Swift, the listener binds (on a substitute
port here, since the echo target is on the same Mac), 3 MiB round-trips in
order, target close propagates. Needs swiftc.

**Measured on the real remote (2026-09-23).** The chain through Serve + proxy
works for every server shape tried (IPv4-only, **IPv6-only** — the guard reads
the `[::1]` binding from `lsof` and connects there — wildcard, Vite + HMR, a
hand-rolled WebSocket page, an 8 s slow reply, a 20 MB download); `lsof -F`
on the remote's macOS matches the parser. **WKWebView blocks the
`http://127.0.0.1:N` iframe inside the `https://…/dsh/` page as mixed content**:
the port was forwarded (View ▸ Forwarded Ports listed it) but the Sidebar
Browser pane stayed blank, while ⌘-click → Safari worked through the same
tunnel. Hence the browser half now takes plain clicks on loopback links
**before** Chat does when `__DSH_DOCK__` is present (capture-phase `click` on
`document`, propagation stopped, `window.open`) so they follow the ⌘-click
path and no blank pane is created (`installDockLoopbackLinks` in
`src/client/index.tsx`). The first probe on a port also surfaced a proxy bug:
refused upgrades lost their `X-Dsh-Forward-Error` header (fixed, relayed now).

## The relay (`relay/`)

`relay/relay.mjs` accepts every connection on `publishPort`. If the proxy port
answers, bytes are spliced (pure TCP: WebSockets and Serve's identity headers
pass untouched). If not: when DSH's own port is up the request is answered
`503` with an HTML "Tailscale remote is off" page; otherwise `relayStart` is
spawned once (`/bin/zsh -lc`, own process group, output to `dsh-web.log`) and
the request gets a `503` "Starting DSH…" splash that polls with HEAD and
reloads itself when the `X-DSH-Relay` header disappears. Five exits within
30 s in a row → "could not be started". SIGTERM stops the relay and the DSH it
started (process group).

`relay/launch-agent.mjs` writes `~/Library/LaunchAgents/io.github.taliesinb.dsh-web-relay.plist`
(RunAtLoad, KeepAlive, `ProcessType Interactive`, the installer's `PATH` and
`DSH_HOME` baked in) whose program is a symlink
`~/Library/Application Support/dsh-tailscale-remote/dsh-web-relay → node`, so
System Settings ▸ Login Items names it `dsh-web-relay`. `bootout` is
asynchronous — the installer waits for the label to vanish and retries
`bootstrap` (EIO 5 otherwise). Restart everything:
`launchctl kickstart -k gui/$UID/io.github.taliesinb.dsh-web-relay`.

## Scripts (macOS only; no-ops elsewhere)

```sh
pnpm relay:install [--cwd DIR] [--start "pnpm dsh web --no-open"]   # LaunchAgent on :3083 → :3084
pnpm relay:status | pnpm relay:uninstall
pnpm dock-app:build                                                   # compile + icon only
pnpm dock-app:install [--name DSH] [--url https://node.ts.net/dsh/] [--fallback http://127.0.0.1:3083/]
pnpm dock-app:status | pnpm dock-app:uninstall
pnpm dock-app:remote <host[/path] | URL> [--name "DSH Host"]             # BLUE app straight to another Mac's DSH
pnpm dock-app:local --name N --url http://127.0.0.1:PORT/ --token-file F  # RED app for a loopback dsh web (pnpm canary)
```

`dock-app:remote` builds a **direct-remote** app: the same wrapper, pointed at
another Mac's route over the tailnet, with **no relay, no fallback and no
token** — identity admission or nothing (an offline page if the remote does not
answer). Target `host[/path]`: a bare host label is resolved to its MagicDNS
name through `tailscale status` (this node, a peer, else the tailnet suffix);
the path defaults to `/dsh`. An ssh-style `user@host` is **rejected**, not
ignored — admission is by tailnet identity, so a user in the target is a
mistake worth surfacing. Default name `DSH <Host>` (title-cased first label),
glyph Radix blue-9 `#0090FF` beside the black live app and the red preview,
bundle id `io.github.taliesinb.dsh-dock-app.remote-<host>-<path>` so every
remote keeps its own WebKit cookies and can sit in the Dock next to the others.
It skips the hybrid Remotes model entirely — no frame, just `dsh web` in a
window.

`dock-app:local` builds a **local** app: the wrapper pointed at a loopback
`dsh web` with **no fallback**, its per-launch token read from `--token-file`
(JSON `{"token": "…"}`) on every connect — with a `tokenFile` and no
`fallbackUrl` the wrapper tokens the primary URL itself, so a restarted server
with a new token reconnects on the 5 s retry or ⌘R. Glyph red `#E5484D`,
bundle id `io.github.taliesinb.dsh-dock-app.<instance>` (`--instance`, default
`local-<name>`). This is what `pnpm canary` (repo root) installs per branch;
see `recipes/canary-instances.md`.

The same actions are buttons in Settings → Tailscale remote → *This Mac*.
Every script takes `--instance preview` to address the preview pair.

## Two instances side by side

The live row sits in `~/.dsh/profiles/web/cordis.patch.yml`; the preview
server runs against **its own home** `~/.dsh-preview`, whose
`profiles/web/cordis.patch.yml` inserts the same plugin with `instance: preview`,
ports 3085/3086, `mountPath: /dsh-preview`, `dockAppName: DSH Preview`, a red
glyph and `relayStart` = `pnpm dsh --profile web --patch …/cordis.dev.local.yml --no-open --port 3088`
(the LaunchAgent carries `DSH_HOME=~/.dsh-preview`; `relay:install --dsh-home`):

```
DSH.app          → /dsh          → relay :3083 (io.github.taliesinb.dsh-web-relay)         → proxy :3084 → dsh web :3080  (~/.dsh)
DSH Preview.app  → /dsh-preview  → relay :3085 (io.github.taliesinb.dsh-web-relay.preview) → proxy :3086 → dsh web :3088  (~/.dsh-preview + dev overlay)
```

Opening either Dock app cold starts *its* DSH. Separate homes are not
optional for a long-lived preview: session write ownership is a cross-process
`flock` on `session.lock`, so two servers over one `$DSH_HOME` fight over any
session both GUIs list (`SessionAlreadyOwnedError … resume failed`).

## Develop

```sh
pnpm install && pnpm build          # lib/client.js (esbuild, CJS factory bundle)
pnpm typecheck                      # tsc against the linked checkout d.ts
pnpm test                           # node:test — proxy gate/forwarding against a fake DSH, state, helpers
pnpm watch                          # rebuild on save (HMR hot-swaps the open GUI)
```

Preview against a throwaway home from the patched worktree:

```sh
cat > /tmp/tailscale-remote-preview.yml <<'EOF'
- insert:
    - id: tali-tailscale-remote
      name: /Users/USER/github/tali-dash-plugins/plugins/dsh-tailscale-remote/index.js
EOF
cd ~/github/deepseek-harness-tailscale
DSH_HOME=/tmp/tailscale-remote-home pnpm dsh web --patch /tmp/tailscale-remote-preview.yml --port 3081 --no-open
```

System-level story, facts and troubleshooting: `recipes/tailscale-remote-plugin.md`.

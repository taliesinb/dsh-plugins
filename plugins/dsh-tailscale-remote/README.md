# dsh-tailscale-remote

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
`403` and never forwarded — the remote page can view the section but cannot
flip the route or read the token.

Index responses for the node's own requests (rightmost `x-forwarded-for` is
one of `Self.TailscaleIPs`) also carry
`globalThis.__DSH_TRANSPORT__ = { ownsHost: true }`, so the shell reports
`ctx.connection.isLoopback` and Settings persist on the host as they do at
`http://127.0.0.1:3080/`. Other devices stay memory-only for Settings.

Admitted requests are forwarded to `http://127.0.0.1:<dsh port>` with
`Host`/`Origin` rewritten to that authority, `sec-fetch-site: same-origin`,
the browser's cookies replaced by the DSH browser-session cookie the plugin
obtained by exchanging its own launch token (`ctx.connection.authenticatedUrl`),
Tailscale identity headers stripped, and `x-forwarded-*` re-derived.
WebSocket upgrades take the same gate. Index responses get a head script that
turns `https://node/dsh` into `https://node/dsh/` — both arrive as `/`, and
without the slash the shell's relative asset URLs resolve at the site root.

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
| `dockAppGlyphColor` / `dockAppTileColor` | `#000000` / `#ffffff` | icon: `dock-app/icon.svg` on a rounded tile |

Persisted: `{ enabled, allowedUsers, token }`. tailscaled persists the route
itself; on boot the plugin restarts the proxy when `enabled` and republishes
the route if `serve status` no longer shows it. Unloading the plugin closes
the listener but leaves the route (it comes back with the next boot).

## Control channel

`POST /tailscale-remote/<endpoint>`, a `webServer` prefix route gated by
`ctx.connection.requestRejection` (DSH's Host/Origin fence + cookie), JSON envelope `{type:'client-request', rpcId,
method, payload:{args}}`: `status`, `enable`, `disable`,
`set-users {allowedUsers: "a, b"}`, `rotate-token`, `install-dock-app`,
`uninstall-dock-app`, `install-relay`, `uninstall-relay`.

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
frame autosave, `isInspectable` (Safari ▸ Develop ▸ this Mac), downloads to
~/Downloads. Not Safari: no Web Notifications, no Safari extensions.

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
```

The same actions are buttons in Settings → Tailscale remote → *This Mac*.
Every script takes `--instance preview` to address the preview pair.

## Two instances side by side

The live row sits in `~/.dsh/profiles/web/cordis.patch.yml`; the preview
server runs against **its own home** `~/.dsh-preview`, whose
`profiles/web/cordis.patch.yml` inserts the same plugin with `instance: preview`,
ports 3085/3086, `mountPath: /dsh-preview`, `dockAppName: DSH Preview`, a red
glyph and `relayStart` = `pnpm dsh --profile web --patch …/cordis.dev.yml --no-open --port 3088`
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
      name: /Users/tali/github/tali-dash-plugins/plugins/dsh-tailscale-remote/index.js
EOF
cd ~/github/deepseek-harness-tailscale
DSH_HOME=/tmp/tailscale-remote-home pnpm dsh web --patch /tmp/tailscale-remote-preview.yml --port 3081 --no-open
```

System-level story, facts and troubleshooting: `recipes/tailscale-remote-plugin.md`.

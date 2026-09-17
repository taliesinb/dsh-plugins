# DSH Dock app over the tailnet, with a relay that starts DSH on demand

Replaces Safari's "Add to Dock" web app for the DSH GUI with a native
WKWebView wrapper (`~/Applications/DSH.app`) that loads
`https://tali-macbook-air.tailbce956.ts.net/dsh/`, is admitted by this Mac's
own Tailscale identity (no token, no cookie, nothing to expire), and works
when DSH is not running because an always-on relay LaunchAgent starts it.
Everything lives in `plugins/dsh-tailscale-remote` (README there owns the
plugin; this recipe owns the system story). Done 2026-09-17 on macOS 27.0,
tailscale 1.102.3, DSH `fix/tailscale-mounting` (`1c80583ba3`), Command Line
Tools only (no Xcode), no code-signing identity. Builds on
[`tailscale-remote-plugin.md`](tailscale-remote-plugin.md).

## The pathology

`~/Applications/DSH.app` (Safari ▸ File ▸ Add to Dock at `http://127.0.0.1:3080/`)
"frequently" opened to `dsh web authentication required; reopen the URL
printed by dsh web`. Diagnosis from the bundle and `browser-auth.ts`:

- Its `start_url` is `http://127.0.0.1:3080/` — **no token in it**; the
  per-process launch token was never the mechanism.
- Its only credential is DSH's signed browser-session cookie, copied by
  Safari from the tab into the web app's private store **at install time**.
  The cookie has a hard 30-day expiry (`cookieMaxAgeDays`) and is never
  refreshed, and the web app has no URL bar to paste a new `?token=` URL into,
  so once it lapses (or the store is cleared) the app is dead until re-added.
  The signing secret (`~/.dsh/.credentials.yaml`) is durable — the perceived
  "token changes each launch" was the 401 text, not the cause.
- With DSH not running the web app shows Safari's "can't connect" page;
  `tailscale serve` is a plain proxy and **does not start backends**
  (returns 502 when the target port is closed).

## Facts that decided the design

1. **This node is not tagged** (`tailscale status --self --json`: `Tags: null`,
   user `tali@symbolica.ai`), and a request the node makes to *itself*
   through Serve carries `tailscale-user-login: tali@symbolica.ai` and
   `x-forwarded-for: 100.78.174.43` (measured with an echo server on a
   temporary `/hdrtest` path). So the node's own login is a credential that
   never expires. (The older recipe's "no identity for a self-probe" was
   observed while the node was tagged.)
2. **A Safari web-app bundle cannot be fabricated.** `~/Applications/DSH.app`
   is just `Info.plist` (LSTemplateApplication → `com.apple.Safari.WebApp`,
   `Manifest` dict) + icon, ad-hoc signed. A byte-identical copy with a fresh
   UUID: in `/tmp` Launch Services marks it `launch-disabled in-temp-dir`; in
   `~/Applications` it fails with "The application cannot be opened because
   its executable is missing". The LaunchServices binary explains why
   (`strings` on the dyld shared cache): "Expected signature for template
   application was not in data vault", "a signature for the template
   application was not found in the local database of known template
   applications", writable only with
   `com.apple.private.launchservices.templateapp.creation` (Safari).
3. **GUI-scripting Safari was rejected**: Accessibility must be granted to
   whichever process parents `dsh web` (the live one is a child of Ghostty,
   which has none: `System Events … privilege violation (-10004)`), and for a
   LaunchAgent-started DSH that would be the `node` binary; an applet or an
   ad-hoc-signed native installer is re-prompted after every rebuild because
   TCC pins ad-hoc apps by cdhash. `open -a applet --args …` also does not
   deliver `argv` to `on run`.
4. **WKWebView wrapper** needs no permission at all, and lets the app inject
   `__DSH_TRANSPORT__.ownsHost` (the desktop host's own hook → Settings
   persist), open foreign links in the browser natively, and fall back to a
   loopback URL when Tailscale is down. Trade-off: no Web Notifications, no
   Safari extensions. `xcodebuild` needs Xcode (absent); `swiftc` from the
   Command Line Tools compiles it in ~4 s **only through `xcrun`** — the CLT
   binary called directly says "unable to load standard library".
5. **"Start on first connect" is an application-level trick**: the relay
   always accepts the TCP connection; if the proxy port is closed it spawns
   DSH and answers *that* request itself with a 503 splash that polls (HEAD)
   and `location.reload()`s once the `X-DSH-Relay` header is gone. The client
   never sees a refused connection or a timeout. (launchd socket activation
   would do the same at the kernel level but needs `launch_activate_socket`,
   unavailable from Node.)

## Topology

```
Dock app / phone ─▶ https://tali-macbook-air.tailbce956.ts.net/dsh/
  └▶ tailscaled (TLS, identity headers) ─▶ relay 127.0.0.1:3083  (LaunchAgent io.github.taliesinb.dsh-web-relay)
       └▶ dsh-tailscale-remote proxy 127.0.0.1:3084 (inside DSH) ─▶ DSH 127.0.0.1:3080
```

Proxy admission now: same-origin fence first (`Host` ∈ {FQDN, FQDN:443,
127.0.0.1:3083, 127.0.0.1:3084 …} else 421; `Origin`, when present, must equal
Host else 403 — identity-admitted browsers have no SameSite cookie protecting
them, so without this a cross-site page could ride the Dock app into `/api`),
then allowlisted login **or the node's own login** (implicit, from
`tailscale status`), token, cookie. Self-node index responses get
`globalThis.__DSH_TRANSPORT__={ownsHost:true}` injected after the slash guard.

## Live install (done 2026-09-17)

The session doing this ran *inside* the Ghostty-started live `dsh web`, so
the host process could not be restarted from within; the sequence was chosen
so everything works with the **old** host module until the next start:

1. `~/.dsh/tailscale-remote.json`: `allowedUsers: ["tali@symbolica.ai"]`
   (only needed by the old code; the new code allows the self login
   implicitly). State is re-read on a plugin reload.
2. `~/.dsh/profiles/web/cordis.patch.yml`, row `tali-tailscale-remote`:
   ```yaml
   config:
     listenPort: 3084
     publishPort: 3083
     relayCwd: /Users/tali/github/deepseek-harness
     relayStart: pnpm dsh web --no-open
   ```
   `patchReload: live` re-ran the old `apply` with the new config (schemastery
   keeps unknown keys): proxy moved to 3084, Serve repointed at 3084,
   `https://…/dsh/` answered 200 to this Mac with no cookie.
3. `cd plugins/dsh-tailscale-remote && pnpm relay:install --cwd ~/github/deepseek-harness --start "pnpm dsh web --no-open"`
   → LaunchAgent on 3083 relaying to 3084. Logs `~/.dsh/logs/{relay,dsh-web}.log`.
4. `tailscale serve --bg --yes --https=443 --set-path /dsh http://127.0.0.1:3083`
   (the old panel shows "conflict" until the restart; cosmetic).
5. `pnpm dock-app:install --name DSH --fallback http://127.0.0.1:3083/` →
   replaced the Safari web app at the same path (keeps its Dock slot), launched;
   `com.apple.WebKit.Networking` of the app holds connections to
   `100.78.174.43:443`.
6. Pending for the operator: quit `pnpm dsh web` in Ghostty; the next Dock-app
   open (or `launchctl kickstart -k gui/$UID/io.github.taliesinb.dsh-web-relay`)
   starts DSH with the new host code, which republishes Serve at 3083 and
   injects `ownsHost`. Running `pnpm dsh web` by hand later is fine: the relay
   sees the proxy port up and just relays.

Preview beforehand: `DSH_HOME=/tmp/dock-preview-home`, port 3090, patch with
`listenPort: 3094, publishPort: 3093, mountPath: /dshdock, dockAppName: DSH Dock Preview`,
relay run in the foreground with
`--start "DSH_HOME=/tmp/dock-preview-home pnpm dsh --profile web --patch /tmp/dock-preview.yml --no-open --port 3090"`.
Verified: 503 splash → DSH up in ~2 s → "remote is off" (fresh home) → enable
via the control channel → 200 via tailnet with `ownsHost`, 403 cross-origin,
421 wrong Host; Dock app installed + launched; DSH killed → app reopened →
relay log `exited … → started dsh web → proxy port is back; splicing` in 2 s;
token fallback on `http://127.0.0.1:3093/?token=…` → 303 + cookie → 200;
SIGTERM to the relay stopped its DSH process group.

## Preview instance (done 2026-09-17)

`config.instance` suffixes everything that must not collide: LaunchAgent label
and Node symlink (`dsh-web-relay-preview`, also what Login Items shows), log
files (`relay-preview.log`, `dsh-web-preview.log`), Dock app bundle id
(`io.github.taliesinb.dsh-dock-app.preview` → its own WebKit data store) and
the state file (`tailscale-remote-preview.json`).

**The preview has its own home, `~/.dsh-preview`** — decided after the first
shared-home attempt bit within minutes: I launched *DSH Preview.app*, its GUI
created a blank New Session (`session-510b83c6`) in the shared
`~/.dsh/sessions`, the preview server took the session's write lease (a
cross-process `flock` on `session.lock`, `session-persistence-jsonl/lease.ts`),
the live GUI listed the same blank row, Tali typed into it, and the live server
got `resume failed … SessionAlreadyOwnedError: already owned by an active
write handle`. The old by-hand `:3081` preview against the live home only ever
ran briefly; a relay-managed preview is long-lived, so the homes must differ.
Fix at the time: `launchctl kickstart -k …preview` (process death releases the
kernel lock); the orphaned blank session can be deleted from the live GUI.

Layout: `~/.dsh-preview/profiles/web/cordis.patch.yml` **inserts** the plugin
row with the preview config (an id-targeted override in the dev overlay has
nothing to target in a fresh home); `<plugins>/cordis.dev.yml` stays a pure
complement (plugins under trial). The LaunchAgent plist carries
`DSH_HOME=/Users/tali/.dsh-preview` (`pnpm relay:install --instance preview
--dsh-home ~/.dsh-preview --log-dir ~/.dsh-preview/logs --listen 127.0.0.1:3085
--backend 127.0.0.1:3086 --dsh 127.0.0.1:3088 --cwd … --start "pnpm dsh --profile
web --patch …/cordis.dev.yml --no-open --port 3088"`). The preview is
**local-only by design**: `~/.dsh-preview/settings.yaml` carries just the
`apple` (default, `foundation`) and `lmstudio` providers copied from the live
file, `.agent-presets/minimal-no-tools` is copied, and the profile patch adds
`tali-local-model-supervisor` (afm :9997, adopts a live-started instance) and
`tali-enforce-model-preset` (apple → minimal-no-tools, lmstudio → minimal).
No cloud keys. Further settings persist from its GUI thanks to `ownsHost`. A first `curl http://127.0.0.1:3085/` cold-started it (3 s);
its `?token=` URL is in `~/.dsh-preview/logs/dsh-web-preview.log`, which is how
an agent authenticates to the preview's control channel (`enable`,
`install-dock-app`) — the preview Dock app was installed through that
channel, i.e. the same code path as the panel button. Port 3081 (the older
by-hand preview convention) was avoided because other sessions' ad-hoc servers
use it. `DSH Preview.app` (Safari web app for :3081) was replaced in place.

**Agents and the GUI.** Any browser on this Mac — including the
`browser-automation` Safari Technology Preview windows — is identity-admitted
at `https://tali-macbook-air.tailbce956.ts.net/dsh/` and `/dsh-preview/`, with
no token; that supersedes the "an agent's own browser cannot open the live
GUI" workaround in AGENTS.md for this machine.

Changing host code (`index.js`, `proxy.mjs`, `dock-app.mjs`, `relay/*`) needs
a restart of the affected instance: `launchctl kickstart -k gui/$UID/io.github.taliesinb.dsh-web-relay.preview`
restarts the preview relay **and** the preview DSH it spawned (verified: the
`quitBundle is not defined` slip surfaced only after such a restart).

## Server pane (2026-09-17)

Settings → **Server** (order 41, next to Tailscale remote): processes with
restart/quit/stop and a client table — see the plugin README. Two facts that
shaped it: (1) the control channel had to be **forwarded for self-node
requests** (rightmost `x-forwarded-for` ∈ `Self.TailscaleIPs`), otherwise the
whole panel is read-only from the Dock app, which is now the primary GUI —
other devices still get 403; (2) DSH's gateway keeps its WebSocket registry
per connection (no public list), but the `WebServer` service's `http.Server`
is reachable as `ctx.webServer.server`, so one `request`/`upgrade` listener
sees every client, direct or proxied. Verified on the preview through the
tailnet as this node: launch/relaunch the Dock app, restart dsh web from
inside (503 splash → back in 2 s). The relay no longer counts such a
deliberate restart as a failed start (only runs whose proxy port never
answered count toward the give-up limit of five).

## What failed on the way (keep)

| Attempt / symptom | Cause / fix |
|---|---|
| Fabricated web-app bundle: "executable is missing" | LS template-app data vault (fact 2). Not fixable. |
| `open -a applet --args a b` | `argv` in `on run` is not a list for applets; use a request file or (as done) drop AppleScript entirely |
| `swiftc` from `xcrun --find`: "unable to load standard library for target" | call it as `/usr/bin/xcrun swiftc …` so the SDK is set |
| Relay start `exec DSH_HOME=x pnpm …`: `zsh: no such file or directory: DSH_HOME=x` | `exec` treats the assignment as a command; run the command plainly, `detached: true`, and kill the process group |
| `dsh web --patch` → `unknown option '--patch'` | current CLI syntax is `dsh --profile web --patch FILE --port N --no-open` (global options before the profile's own) |
| `plutil -convert json` on `com.apple.dock`: "Invalid object in plist for JSON format" → tile lookup silently empty → **duplicate DSH Dock tile** and a stale preview tile | the Dock plist holds `<data>`; `dockTileItems()` now parses the XML `<dict>` items and rewrites the array; dedupe done by hand once |
| `launchctl bootstrap` right after `bootout`: `Bootstrap failed: 5: Input/output error` | bootout is asynchronous; wait for `launchctl print` to fail, retry bootstrap |
| Login Items / "App Background Activity" names the agent **zsh** | the item is named after `ProgramArguments[0]`; the agent now runs a symlink `…/Application Support/dsh-tailscale-remote/dsh-web-relay → node` |
| Live GUI hot-swapped a client bundle whose host lacked the new fields | the plugin is installed live, so `pnpm build` in its directory swaps the open GUI; the client now tolerates `dockApp`/`relay` being absent — always keep new client fields optional |
| First relay probe with `Host: node` and no `x-forwarded-proto` → 421 in the WebSocket test | canonical authorities carry an explicit port; tailscaled always sends `x-forwarded-proto: https`, the test now does too |
| Live GUI: `resume failed … SessionAlreadyOwnedError` on a New Session right after the preview Dock app was launched | two servers on one `$DSH_HOME` (see "Preview instance"); the preview now has `~/.dsh-preview` |
| Tracker test: WebSocket "close" never fired after the client destroyed its end | http upgrade sockets are `allowHalfOpen` and a paused socket never sees the FIN; the fixture now reads and ends — the real `ws` server does |
| `ps -o etimes=` empty on macOS | Linux-only column; parse `etime` (`[[dd-]hh:]mm:ss`) |
| Preview `install-dock-app` → `quitBundle is not defined` | a scripted block replacement in `dock-app.mjs` deleted a helper defined inside the replaced span; tests did not cover install (it touches ~/Applications). Restored; restart the instance after host edits |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Dock app shows "Starting DSH…" for long | `tail -f ~/.dsh/logs/dsh-web.log`; five fast exits → "could not be started" page; fix and reopen |
| Dock app shows "Tailscale remote is off" | DSH is up but the plugin is disabled: Settings → Tailscale remote → Enable |
| Dock app shows its own "DSH is unreachable" page | neither tailnet nor `127.0.0.1:3083` answers: Tailscale off **and** relay not loaded (`pnpm relay:status`) |
| Tailnet URL 502 from tailscaled | relay not running: `launchctl print gui/$UID/io.github.taliesinb.dsh-web-relay`, `~/.dsh/logs/relay.log` |
| `421` on the tailnet URL | `Host` not in the public list — `tailscale status` unknown at proxy start; the panel's 15 s status poll refreshes it |
| Settings changes from the Dock app do not persist | `ownsHost` missing: old host code (restart) — the wrapper injects it itself, so this should not happen from the app |
| Panel: "Something else listens on 127.0.0.1:3083" | an older config still runs the proxy on 3083 — set `listenPort: 3084` |
| Two DSH tiles in the Dock | see failure table; `defaults read com.apple.dock persistent-apps \| grep DSH`, remove with `removeDockTile(path, log, { keepFirst: true })` or drag one off |
| Reinstall re-prompts for nothing | expected: the wrapper asks TCC for nothing; ad-hoc signature changes are irrelevant |
| Phone gets 403 on API calls | its page's `Origin` ≠ Host — only happens for cross-site requests, i.e. the fence working |

## Rollback

```sh
cd ~/github/tali-dash-plugins/plugins/dsh-tailscale-remote
pnpm dock-app:uninstall --name DSH            # removes the wrapper + its Dock tile
pnpm relay:uninstall                          # bootout + delete the plist
tailscale serve --bg --yes --https=443 --set-path /dsh http://127.0.0.1:3084   # publish the proxy directly
# then in ~/.dsh/profiles/web/cordis.patch.yml set publishPort: 0 (or drop the config block)
# Safari web app again: open http://127.0.0.1:3080/?token=… in Safari → File → Add to Dock
```

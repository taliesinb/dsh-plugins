# Remote workspaces: mirror another DSH server's workspaces in this GUI (dsh-remote-workspaces + DSH branch feat/embed-session)

Local `dsh web` shows **remote workspaces** in its sidebar — workspaces that live on
another DSH server (typically published over the tailnet by that server's
`dsh-tailscale-remote`). Their sessions render through the *remote's own* GUI,
framed chrome-less in an iframe; list / new / rename / archive go host-to-host over
the remote's RPC. Written 2026-09-16 against DSH `0.1.2-rc.1` lineage. Design and
phase log: [`../notes/remote-workspaces-plan.md`](../notes/remote-workspaces-plan.md);
the heavier "remote execution world" alternative that was *not* built:
[`../notes/remote-workspaces-design-bookmark.md`](../notes/remote-workspaces-design-bookmark.md).

## Shape

```
local browser ──same-origin──▶ local DSH (:3080)                      remote DSH
  sidebar rows (plugin client)   dsh-remote-workspaces                dsh-tailscale-remote → DSH (feat/embed-session)
  <iframe src=/remote/<srv>/?embed=<sid>>  egress proxy /remote/<srv>/* ──https──▶ /dsh/*   (?embed renders one Session, no sidebar)
                                 control channel /remote-workspaces   ──▶ POST /api/<ns>/<method>
```

Why an iframe and not "remote execution": the remote page is served **same-origin**
by the local host's egress proxy, so DSH's `SameSite=Strict` cookie, Host==Origin
fence and cross-site refusal all see one origin, and the remote's credentials stay in
the local *process*. Nothing moves: sessions, model calls, files all stay on the remote.

## Pieces

| Piece | Where | Commits |
|---|---|---|
| DSH branch `feat/embed-session` (off `fix/tailscale-mounting`) | worktree `~/github/deepseek-harness-embed` | `aa123a8fdf` embed mode; `ab58a76bda` `workspace.list` + sidebar seats |
| Plugin `dsh-remote-workspaces` | `plugins/dsh-remote-workspaces/` | this repo |

### The DSH branch

1. **`?embed=<sessionId>`** (`aa123a8fdf`): chrome-less page pinned to one Session.
   `dsh-client-store` gets a page-mode cell (`setEmbedPresentation`) and a per-embed
   `localStorage` namespace `embed:<id>:` — the embedded shell shares its framer's
   origin, so without it `dsh.sessions.current` and drafts would collide with the
   local GUI's. `ui-layout` draws no left column (`ctx.layout.embedSessionId`,
   `data-embedded`); the Session Controller client takes the id as initial selection
   and refuses `open()` of another root; `browser-auth` keeps non-token query params
   through the `?token=` redirect. **Query param, not a path**: the shell resolves
   every Host URL against the document directory (`fix/tailscale-mounting`), so
   `/embed/<id>` would move the mount.
2. **`workspace.list`** unary Remote (`ab58a76bda`): the `follow` baseline as one
   read — a host cannot conveniently hold a mux stream open to another host.
3. **Sidebar seats** (`ab58a76bda`): `sidebar.workspaces.headerAction` (icon buttons
   beside "Add workspace") and `sidebar.workspaces.extra` (groups below the local
   tree). `sidebar.workspaces` itself is a *single* slot owned by `ui-workspace`, so
   without seats a plugin could only replace the whole browser.

The **remote** must run this branch (for `?embed` and `workspace.list`); the local
must too (for the seats). zh README pairs were not translated.

### The plugin

- `index.js` — per server: prefix route `/remote/<id>` + **exact** upgrade route
  `/remote/<id>/api/remote.mux` on `ctx.webServer` (`registerUpgrade` is exact-path
  only; the embedded shell opens exactly that one socket), both gated by
  `ctx.connection.requestRejection` so the proxy is not an open relay. Control
  channel `/remote-workspaces` (Connection envelope): `status`, `servers.probe`,
  `servers.inspectPath`, `workspaces.add|poll|remove|rename`,
  `sessions.rename|archive|start`, `probe`, and — served *for peers* — `fs.inspect`,
  `fs.mkdir` (see "The add-remote modal" in the plugin README, 2026-09-24: short
  server names such as `user@host` resolved with the MagicDNS suffix, and the
  "New workspace" path field with live existence verdicts, `~` resolved on the
  remote, Tab completion, and `mkdir -p` on Done for a missing directory).
- `egress.mjs` — auth bridge (tailnet identity, or token → cookie via `GET ?token=`,
  re-exchanged on 401 / 6 h), header rewriting (Host/Origin → remote, browser
  cookies dropped, `x-forwarded-*` dropped, `Set-Cookie` dropped, `Location` mapped
  back under the mount), WS piping, `call(ns, method, args)`.
- `state.mjs` — `$DSH_HOME/remote-workspaces.json` (0600): servers (+token) and
  mirrored workspaces with cached sessions. Remote workspaces are **not** local
  `dsh-workspace` entries (those need a real directory).
- `src/client/` — `store.ts` (persisted view: expanded/selected/remoteActive; runtime:
  snapshot, polling, frames), `ui.tsx` (button, groups, modal, panel host, frame
  pool), `index.tsx` (registrations). Built with `build.mjs` (esbuild → `lib/client.js`).

Behaviour that matches the spec: collapsed groups never touch the network; expanding
polls (rows keep cached titles with spinners); `↻` re-polls; `+` is disabled until the
first poll; `…` on a session → Rename/Archive (remote RPC); `…` on the group →
Rename (local only)/Remove (local only); the frame pool keeps hidden iframes alive
(WebSocket included) for 10 min, cap 4 LRU; reload restores the remote panel iff it
was the last thing shown.

**Deliberate deviation — "new session":** the local shell *already* creates a blank
session on the host when you open a workspace (`uiWorkspace.connectWorkspace` reuses
an existing blank one) and hides `blank` sessions from the tree. `sessions.start` does
exactly that on the remote and frames the remote's own composer, so model/effort,
attachments and draft persistence are the remote's for free. The blank session shows
as a pinned "New session" row while selected, like the local tree's current blank.

## Install / run

Dev overlay (preview instance, PREVIEWING.md pattern):

```yaml
- insert:
    - id: tali-remote-workspaces
      name: '/Users/USER/github/tali-dash-plugins/plugins/dsh-remote-workspaces/index.js'
      # optional seed (never persisted):
      # config: { servers: [{ id: rv, url: https://robotics-vm.example.ts.net/dsh/, label: robotics-vm, token: '' }] }
```

```sh
cd plugins/dsh-remote-workspaces && pnpm install --ignore-workspace && node build.mjs && node --test tests/*.test.mjs
# launcher flags BEFORE app args:
DSH_HOME=/tmp/x node <checkout>/apps/cli/lib/bin.js --profile web --patch overlay.yml --port 3081 --no-open
```

Live profile: not installed as of this writing (user's call; `dsh plugin --profile web
add <path>` after switching the live checkout to `feat/embed-session` and rebuilding).
The plugin's devDependencies link to the **worktree** (`~/github/deepseek-harness-embed`)
because the new slot types only exist there; repoint when the live checkout moves.

## Two-instance test (what was verified)

Remote = worktree DSH on :3082 (`DSH_HOME=/tmp/dsh-embed-home`), local = worktree DSH on
:3081 (`DSH_HOME=/tmp/dsh-local-home`, overlay above, no seed). In the local GUI: the
add button (globe-badged then; plain since 2026-09-24) → modal → URL `http://127.0.0.1:3082/` → **401 remedy** revealed the
token field → remote launch token → step 2 listed the remote workspace → Done →
group appeared expanded, first session framed; `+` reused the remote's blank session
and framed its composer; a prompt ran there; `↻` showed the auto-titled row; rename
through `…` updated row, remote and live frame title; local "New Session" hid the
frames (documents intact), reselect showed instantly; reload restored the remote
panel (and the local hero when local was last); archive removed the row. A bare DSH's
launch token exchanges exactly like `dsh-tailscale-remote`'s token, which is why two
local instances suffice. **Not exercised:** a real `dsh-tailscale-remote` upstream over
HTTPS in identity mode (no tailnet peer was running DSH).

## Facts that cost time

- Remote RPC args are keyed by the method's *parameter names*: `session.list` →
  `{ _request: {} }` (underscore!), `session.create`/`workspace.create`/`session.rename`
  → `{ request: {…} }`, `workspace.list` → `{}`. A `session.list` item is
  `{ sessionId, updatedAt, running, blank, cwd, projections: { values: { title, … } } }`.
- The center column (`.centerCol`) is an unpositioned flex column: a `position:absolute;
  inset:0` panel host sizes against the whole frame and covers the sidebar. Fill it as a
  flex child instead.
- `main` is a keyed slot that unmounts inactive entries — iframes cannot live there
  (unmount = reload). They live in `shell.overlay` (always mounted, click-through
  layer) positioned over the panel host's measured rect.
- `FramePool`'s mount effect ran before the boot-time panel restore and cleared
  `remoteActive`; hide/show bookkeeping must fire on active→inactive *transitions*.
- Plugin HMR resets in-memory runtime state (frames) — expected; persisted view survives.
- `Menu` owns its anchor (`anchor={<button/>}`), it does not take a ref.
- `pnpm dsh web --patch …` is rejected; `--profile web --patch … --port …` works.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Modal: "the remote DSH did not accept this host" | Remote 401: your tailnet login is not on its allowed list (identity mode) — add it in the remote's Tailscale-remote panel, or paste its token |
| Modal: "the remote DSH lacks workspace.list" | Remote is not on `feat/embed-session` |
| Modal, New workspace: orange "Caution: server is running an older version" instead of "Directory exists" / "Directory will be created" | Neither door of `remote-fs.mjs` answered: the remote has no `dsh-remote-workspaces` **and** no browse `directoryPicker` (a native-picker or pre-fork DSH), **or this GUI's own host still runs a plugin from before 2026-09-25** (host edits need a `dsh web` restart / `/reboot`). Done then takes an absolute directory that already exists there. Diagnose from the laptop: `curl -sS -d '{"type":"client-request","rpcId":"x","method":"directoryPicker/list","payload":{"args":{}}}' -H 'content-type: application/json' https://<host>.example.ts.net/dsh/<user>/api/directoryPicker/list` should answer the remote home listing. **2026-09-25 case:** the shared server's instances deliberately run no `dsh-remote-workspaces` (host policy, `extras/AGENTS.md`), so the plugin-only path check added 2026-09-24 could never work against them — an unrouted POST there is a bare `405`, which the egress reports as `bad-response`; the picker door fixed it with nothing installed on the remote |
| Modal: `https://studio/…` fails TLS / "unreachable" for a short name | No MagicDNS suffix could be found (`tailscale status --json` unavailable and no known `*.ts.net` server) — type the FQDN once; it is then known |
| Frame shows the remote's full GUI with a sidebar | Remote lacks `?embed` support (branch), or the URL lost the query — the mount must be `/remote/<id>/` with the slash (the plugin 301s the slash-less form and keeps the query) |
| Frame shows 401 page | Local browser cookie missing (opened without the token URL once) — the egress is gated by the local session too |
| Session row title empty | Remote session has no title yet; `↻` after its first turn |
| Group says "gone" | The remote deleted that workspace; Remove it locally |
| WebSocket in frame never connects | Check the exact upgrade route `/remote/<id>/api/remote.mux` exists in `status` (`localBase`) and the remote accepts `Origin` = its own origin |

## Deploying app-backed plugins to a remote (2026-09-18)

`tools/deploy-remote.sh` ships `browser-automation` (and, until it moved to
`extras/`, a second app-backed plugin) when the apps exist on the host. Facts
learned:

- **pnpm's node_modules do not survive rsync** (even `-aL`): transitive deps
  (`zod`) live only in `.pnpm`. The deploy syncs plugin files without
  node_modules and runs `tools/remote/install-plugin-deps.sh` on the host,
  which `npm install`s the pinned third-party deps from a `link:`-free
  manifest into `~/dsh/deps/<plugin>` and symlinks them in; `@deepseek-ai/*`
  links are re-pointed at the synced checkout. Same trick for `fs-tools`'
  `@vscode/ripgrep` (1.18: binary in `@vscode/ripgrep-darwin-arm64`, link
  the whole `@vscode` scope).
- **Chrome first launch on a fresh machine** breaks `chrome-devtools-mcp`
  ("Target closed"): clear the cask's quarantine attr and launch Chrome
  once headfully (`open -a "Google Chrome" --args --no-first-run`) before
  automation.
- **Safari Technology Preview's "Allow Remote Automation" IS scriptable**
  (correction, 2026-09-21): `defaults write` is ignored (secure per-user
  store, `DidMigrateWebDriverAllowRemoteAutomation`), but Apple's own
  `sudo safaridriver --enable` flips it — verified over ssh on a shared machine
  for a never-logged-in account, a WebDriver session followed at once. The
  bootstrap runs it after installing STP; until it is run, `safari_*` tools
  error with WebDriverErrorDomain 6 and their remedy text names the command.
- **A kernel plugin's first launch took 62 s** on the remote (package index +
  licence handshake) — past its eval tool's 60 s `timeConstraint`, so the
  very first call fails and the retry succeeds; subsequent cold starts are
  ~1 s. Warm such kernels once after install.
- Loader import failures are only visible as `<row>: failed to import` in
  the launchd log; `node -e 'import("./index.js")'` in the plugin dir gives
  the real error.

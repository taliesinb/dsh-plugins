# Remote workspaces via iframe pass-through — plan

Status: **planning, approved direction**. Companion to
[`remote-workspaces-design-bookmark.md`](remote-workspaces-design-bookmark.md), which
records the heavier "remote execution world" alternative that is *not* being built.
Surveyed against DSH fork `~/github/deepseek-harness` (0.1.2-rc.1 lineage, branch
`fix/tailscale-mounting`) and `plugins/dsh-tailscale-remote` on 2026-09.

## 1. Goal in one paragraph

One local `dsh web` remains the single GUI. A **remote workspace** is a sidebar row
that mirrors a workspace living on another DSH server reached over the tailnet
(`https://robotics-vm.<tailnet>.ts.net/dsh/`, published by that server's own
`dsh-tailscale-remote`). Its sessions are listed locally (cached, refreshed by
polling), but selecting one renders the *remote server's own chat UI* inside an
iframe in the main pane, chrome-less. The local server offers a thin management layer
(create remote workspace, poll, refresh, rename/archive sessions, create sessions) by
acting as an RPC client of the remote. No execution, model, or session state moves —
this is deliberate "cheap remoting."

## 2. Architecture

```
Browser (127.0.0.1:3080)                      Local DSH host                         Remote DSH host (robotics-vm)
┌───────────────────────────┐   same-origin   ┌──────────────────────────┐   tailnet  ┌──────────────────────────┐
│ sidebar: remote ws rows   │──control rpc──▶ │ dsh-remote-workspaces    │──https───▶ │ dsh-tailscale-remote     │
│ main: <iframe             │                 │  • registry/store        │  (cookie   │  (ingress proxy, auth)   │
│   src=/remote/rv/?embed=S>│──GET/WS───────▶ │  • egress proxy          │   bridge)  │        │ 127.0.0.1:port  │
│ iframe pool (keep-alive)  │                 │    /remote/<id>/*        │            │        ▼                 │
│ new-session draft store   │                 │  • gateway client        │            │  DSH web (fork branch)   │
└───────────────────────────┘                 │    (list/create/rename…) │            │  ?embed=<id> chrome-less │
                                              └──────────────────────────┘            └──────────────────────────┘
```

Key property: the iframe is **same-origin** with the local GUI because the local host
proxies the remote under `/remote/<remoteId>/`. That single decision dissolves the
three blockers found in the survey — `SameSite=Strict` browser-session cookies,
`Origin === Host` trust fence, and `sec-fetch-site: cross-site` refusal — and keeps
the remote's credentials out of the browser entirely.

### Why this works with `fix/tailscale-mounting`

That branch makes every URL the DSH shell computes **document-relative** (recipe
`tailscale-remote-plugin.md`). The embedded page at
`http://127.0.0.1:3080/remote/rv/?embed=S` therefore requests `./api/...`,
`./assets/...`, `./plugins/...`, `wss://…/remote/rv/api/remote.mux` — all of which
land on the egress proxy. Two consequences to honour:

- The iframe URL **must carry the trailing slash** (`/remote/rv/`), same rule as the
  `/dsh/` mount. The proxy should 301 `/remote/rv` → `/remote/rv/` (with query).
- The client has **no pathname routing**, so the embed selector must be a **query
  parameter**, not a path segment (`/embed/<id>` would shift the document directory).

## 3. Components

### 3.1 Fork patch (branch off `fix/tailscale-mounting`, e.g. `feat/embed-session`)

Small and self-contained; candidate for upstream later. **Implemented — see §7.**
Learned while implementing:

- The GUI persists its selection and drafts in `localStorage` (`dsh.sessions.current`
  via `dsh-client-store` `persist`). Because the egress proxy serves the remote page
  from the local origin, the embedded shell and the local GUI share `localStorage`.
  Fix: the store engine namespaces every persisted key with `embed:<sessionId>:` in
  embed mode (`setEmbedPresentation`, called by the web boot kernel before plugins).
- Remote unary endpoints are `POST /api/<namespace>/<method>` with the Connection
  envelope `{ type: 'client-request', rpcId, method: '<ns>/<method>', payload: { args } }`
  where `args` keys are the method's *parameter names* (e.g. `{ request: {...} }`
  for `workspace.create`, `{}` for `agentPresets.list`). Response:
  `{ type: 'server-response', rpcId, result: { ok, value | error } }`.
- `session.create({ request: { workspaceId, agentPreset } })` returns `{ sessionId }`;
  `session.rename({ request: { sessionId, title } })`. Both verified against the
  running host from the page.
- `session.list` takes `{ _request: {} }` (underscore — parameter names are literal).
  Item: `{ sessionId, updatedAt, running, blank, cwd, projections: { values: { title, goal, … } } }`;
  `cwd` maps a session to its workspace (compare with the workspace `path`).
- `webServer.registerUpgrade` is exact-path only; the embedded shell opens exactly one
  socket (`…/api/remote.mux`), so one upgrade route per remote suffices. HMR
  `plugins/events` is SSE over HTTP (prefix route) — the `compression` middleware
  skips `text/event-stream` and already-encoded upstream bodies, so relaying
  upstream `content-encoding` is safe.
- Launcher flags precede app args: `dsh --profile web --patch x.yml --port N`.

| Change | Where (likely) | Notes |
|---|---|---|
| Read `?embed=<sessionId>` at client boot; publish `ctx.layout.embedSession` | `packages/client/ui-layout` (or `web` boot) | Store-backed flag, not URL-routed state |
| Chrome-less mode: hide sidebar, panel list, right dock, settings, brand; main pane fills viewport | `ui-layout`, `ui-sidebar` | Behind the flag; zero change when absent |
| Preselect the session and **lock** selection (no `startSession`, no switching) | `ui-conversation` / navigation | Unknown id → friendly "session not found" pane, still chrome-less |
| Preserve query string through the `?token=` exchange redirect (`Location: ./?embed=…`) | `packages/client/connection/src/browser-auth.ts` | Today `Location: ./` drops the query. Only relevant when the egress proxy's auth bridge hits the index; harmless otherwise |
| Optional: `postMessage` from embed → parent on title change / turn end | `ui-conversation` | Lets the local sidebar update the row title without polling. Phase 2 |

Tests: layout snapshot with/without `embed`; browser-auth redirect keeps query.

### 3.2 Host plugin `dsh-remote-workspaces` (new, `~/github/tali-dash-plugins/plugins/`)

Mirror `dsh-tailscale-remote`'s shape (plain ESM host files + `src/client` TSX built
by `build.mjs`, `cordis.patch.yml` insert row, `node --test` tests).

**a) Registry / store** (`state.mjs` pattern, `$DSH_HOME/remote-workspaces.json`, 0600)

```ts
interface RemoteServer { id: string; url: string /* https://host/dsh/ */; label: string; tokenRef?: string /* credentials record id */; lastUsedAt: string }
interface RemoteWorkspace {
  id: string; serverId: string; remoteWorkspaceId: string; title: string /* local display */
  remotePath: string; createdAt: string; order: number
  cache: { sessions: { id: string; title: string; updatedAt?: string }[]; models?: ModelCatalogSnapshot; polledAt?: string }
}
```

Remote workspaces are **not** entries in the local `dsh-workspace` registry (which
requires a real local directory). They live here and are merged into the sidebar by
the client half.

**b) Egress proxy** — reverse of `proxy.mjs`

- Registered as a `webServer` prefix route `/remote/<id>/` (same registration style
  the ingress plugin adopted after `rpc.handle` broke on upstream `0d1f5000`).
- Forwards HTTP and **WebSocket upgrade** to `<server.url><rest>`; rewrites `Host`
  to the remote FQDN; strips local cookies; **attaches the bridged remote cookie**.
- Gate: the *local* request must pass `ctx.connection.requestRejection(req)` (local
  Host/Origin fence + local browser cookie) so the proxy is not an open relay.
- Auth bridge to remote (reuse ingress plugin logic, direction flipped):
  1. If `tokenRef` set: `GET <url>?token=<t>` → expect 303 + `Set-Cookie`; store the
     cookie in memory (refresh after ~6 h or on upstream 401).
  2. Else rely on tailnet identity: tailscaled injects `Tailscale-User-Login` for the
     Mac's user; the remote's allowlist accepts it. No cookie needed.
  3. On 401 from remote surface `auth` error to the client with the two remedies.
- Response rewriting: none needed for the shell (document-relative), **except** the
  slash guard the ingress plugin injects (a `<script>` doing `location.replace` when
  the path lacks the trailing slash) — pass it through; it computes from
  `location`, so it self-corrects under `/remote/rv`.
- Streaming: pipe bodies; do not buffer `remote.mux` frames. Honour heartbeat Pings.

**c) Gateway client** — host-side calls to the remote's Typert Remote endpoints

Unary calls are `POST <url>api/<namespace>.<method>` with the Connection envelope (see
`packages/client/connection` for the request/response envelope; reuse the ingress
plugin's helper that already speaks it for `/tailscale-remote`). Methods needed:

| Purpose | Remote method (namespace.method) | Notes |
|---|---|---|
| Poll workspaces on the remote (modal 1.b) | `workspace.follow` (stream; take baseline then cancel) — or add a unary `workspace.list` in the fork if streaming from host is awkward | Baseline frame contains all workspaces + session ids |
| Create workspace from a directory (1.c) | `workspace.create({ path, title? })` | Remote validates the dir exists |
| Session titles for a workspace | `session.list` (in `control.ts`; headers-only, cheap) | Filter by workspace's `sessionIds` |
| Model/effort catalog for new-session form | `session.modelCatalog` | Fetch at first poll; cache in `RemoteWorkspace.cache.models` |
| New session | `session.create({ workspaceId, model, preset, … })` then `session.prompt(...)` for the initial text | Mirror the local create flow's argument shape exactly |
| Rename | `session.rename` | |
| Archive | `workspace.archiveSession` | |
| Refresh row | `session.list` + workspace baseline | Same as poll |

Verify exact request shapes from `packages/api/*/src/types.ts` before coding; the
generated Remote descriptors are the contract.

**d) Control channel** for the local browser half — `webServer` prefix route
`/remote-workspaces`, gated by `requestRejection`, Connection envelope, so the client
uses `ctx.connection.rpc.call('/remote-workspaces', …)`. Operations: `servers.list`,
`servers.probe(url, token?)`, `workspaces.list/add/remove/rename/reorder`,
`workspaces.poll(id)`, `sessions.rename/archive/create`.

### 3.3 Client half (`src/client/index.tsx` of the same plugin)

Slots available today (from `packages/client/*`): `sidebar.workspaces` is a **single**
slot owned by `ui-workspace` (`WorkspaceBrowser`), with child
`sidebar.workspaces.directoryFlow`. There is no list slot for extra workspace rows,
so two options:

1. **Wrap**: inject our own `sidebar.workspaces` component that renders
   `WorkspaceBrowser` (imported from `ui-workspace/client`) followed by our remote
   rows — cheapest, but ordering/interleaving with local rows is not possible and a
   second injector of a single slot must win deterministically (check `ui-slots`
   single-slot precedence / `order`).
2. **Fork slot**: add a `sidebar.workspaces.extra` list slot (or a row-provider hook)
   in `ui-workspace` on the fork branch. Cleaner; lets remote rows interleave and
   reuse the row component styling.

Recommend starting with (1) for the spike, moving to (2) once the row UX settles.

Pieces:

- **Add-remote button** beside the folder-plus "Add workspace" icon (same icon +
  small "remote" badge). Opens the **Add remote workspace modal** (steps in §4).
- **Remote workspace row**: folder with remote badge; collapsed by default (freshly
  created starts open); RHS actions `↻ refresh`, `+ new session`, `…`.
- **Session rows** under it: cached titles with spinner while a poll is in flight;
  reconcile on poll result (add/remove/retitle). `…` → Rename / Archive.
- **Iframe pool** in the `main` pane: one `<iframe src="/remote/<rid>/?embed=<sid>">`
  per visited remote session; hidden (not unmounted) when another session — local or
  remote — is selected; destroyed after **10 min hidden**; hard cap (e.g. 4) with LRU
  eviction, since each frame owns a WebSocket. Show a local skeleton until the frame
  fires `load`.
- **Main-pane view**: inject a `conversation.view`/`main` entry keyed by remote
  session id. Check how `ui-conversation` scopes `main` to a session (`installScope
  ('session')`) — remote sessions are not local `SessionId`s, so the view likely needs
  its own selection state in the plugin store rather than the local session
  selection. Decide during spike.
- **New session (remote)**: reuse the local hero/composer UI where possible; model /
  effort selectors read from the cached remote catalog; disabled with hint until the
  workspace's first poll completes. Draft text + choices persisted in a
  `dsh-client-store` (localStorage) keyed `remote:<wid>`; cleared only after
  `session.create` **and** the new id appears in the next poll (or is returned by
  create) — then auto-select it (spins up its iframe).

## 4. UX flows (user spec, normalised)

**Add remote workspace**
1. Click remote-add icon → modal "Add remote workspace".
2. *Server URL* field, prefilled with last-used server (from store). Optional
   *Token* field (collapsed "Advanced"); explains tailnet identity is used when empty.
3. On blur/Enter: `servers.probe` → egress auth bridge → `workspace` baseline.
   Failure states: unreachable / 401 (offer token) / not a DSH host. Cannot proceed
   until green.
4. Pick an existing remote workspace (list with titles + paths) **or** type an
   absolute remote directory (creates via `workspace.create` on Done).
5. *Name* prefilled `<remote-hostname>-<workspace basename>`.
6. Done → create (if needed) → `session.list` + `modelCatalog` → store → sidebar row
   appears **expanded** with sessions. Errors keep the modal open with the message.

**Observe**
- Collapsed rows never touch the network. Expanding triggers a poll; cached sessions
  show spinners until reconciled. `↻` repeats it. A failed poll marks the row with a
  warning badge and keeps the cache.

**Select remote session** → iframe (pool semantics above). Switching away hides it;
returning within 10 min is instant.

**`…` on remote session** → Rename (confirm → `session.rename` → update cache) /
Archive (→ `workspace.archiveSession` → drop from cache).

**New session in remote workspace** → §3.3 flow.

## 5. Auth & trust summary

| Hop | Mechanism |
|---|---|
| Browser → local host (`/remote/*`, `/remote-workspaces`) | Existing local browser cookie + Host/Origin fence via `requestRejection` |
| Local host → remote (`https://…/dsh/`) | Tailnet identity (`Tailscale-User-Login` allowlist on remote) **or** standing token → HMAC cookie, exactly the ingress plugin's tiers |
| Remote ingress → remote DSH | The remote's own bridge (unchanged) |

Remote needs **no** `--trusted-host` / `--host` changes; its ingress proxy already
rewrites `Host`/`Origin` to loopback. Token, if used, lives in local `ctx.credentials`,
never in the browser. Rotating the remote token signs the local host out (same as QR
devices) — the row then shows the auth remedy.

Known inherited limitation: inside the embed, `ctx.connection.isLoopback` is false
(the remote page authority is not loopback), so remote **Settings** would persist in
memory only — irrelevant once the embed hides Settings.

## 6. Edge cases to design for

- Remote down while iframe visible: the embedded shell's own reconnect UI shows;
  local row gets a warning badge on next poll. Do not tear down the frame.
- Remote session archived/deleted elsewhere: embed shows "not found"; poll removes
  the row; if it was selected, fall back to workspace hero.
- Two remote workspaces on the same server share one auth bridge + cookie.
- Same remote workspace added twice → dedupe on `(serverId, remoteWorkspaceId)`.
- Local server restart: registry persisted; caches persisted; cookies re-bridged
  lazily on first use.
- Subagent/child sessions on the remote: appear via `session.list` like local ones;
  embed of a child works the same.
- HMR: keep plugin state in the store so client reloads do not drop the iframe pool
  needlessly (frames will reload anyway; acceptable).

## 7. Phases

1. **Spike (fork)** — **DONE 2026-09-16**, commit `aa123a8fdf` on branch
   `feat/embed-session` (worktree `~/github/deepseek-harness-embed`, off
   `fix/tailscale-mounting`). `?embed=<sessionId>` renders one Session chrome-less;
   persisted browser state is namespaced `embed:<id>:` (shared-origin hazard found
   during implementation — see §3.1 notes); the Session Controller client pins the
   selection; the token redirect keeps the query. Verified on a throwaway home
   (`DSH_HOME=/tmp/dsh-embed-home`, port 3082): prompt round-trip, reload pinned,
   ordinary shell's localStorage untouched. zh README pairs not yet translated.
   Live GUI still runs `fix/tailscale-mounting`; switch when convenient
   (`git checkout feat/embed-session` in the live checkout after stopping it, rebuild).
2. **Egress proxy** — **DONE 2026-09-16**: `plugins/dsh-remote-workspaces/`
   (`index.js`, `egress.mjs`, `state.mjs`, 9 node:test cases). Per server: prefix
   route `/remote/<id>` + exact upgrade route `/remote/<id>/api/remote.mux` on
   `ctx.webServer`, both gated by `ctx.connection.requestRejection`. Auth bridge =
   tailnet identity or token→cookie (re-exchange on 401 / 6 h). Control channel
   `/remote-workspaces` with `status`, `probe`. Verified with two worktree instances
   (remote :3082, local :3081 seeded via `--patch`): host-to-host `session.list`
   works; the remote session renders in a same-origin iframe of the local GUI and
   runs a live streamed turn (WS mux through the egress); all 30 embedded-shell
   resources stayed under `/remote/rv/`; local GUI localStorage untouched.
   Not yet exercised: a real `dsh-tailscale-remote` upstream over HTTPS (identity
   mode + its slash-guard script) — first thing to try in phase 3 with a real peer.
3. + 4. **Registry, sidebar, modal, iframe pool, session ops** — **DONE 2026-09-16**.
   Fork commit `ab58a76bda` (unary `workspace.list`; list seats
   `sidebar.workspaces.headerAction` / `.extra` — the "fork slot" option, chosen over
   wrapping the single slot). Plugin browser half in `src/client/`. New-session flow
   deviates from the spec by design: the local shell itself creates/reuses a blank
   session on the host when a workspace is opened, so `sessions.start` does the same
   on the remote and frames the remote's own composer (its models/effort/attachments/
   drafts). Recipe: `recipes/remote-workspaces-plugin.md`.
5. **Polish (open)**: `postMessage` title sync so rows update without ↻; interleave
   remote groups with local ones; remote directory browsing in the modal; test against
   a real `dsh-tailscale-remote` upstream (identity mode, HTTPS); install into the
   live profile once the live checkout is on `feat/embed-session`.

## 8. Open questions (resolve during phases 1–2)

- Exact host-side way to open a Remote **stream** (`workspace.follow`) from Node: can
  we reuse `@deepseek-ai/dsh-api-gateway`'s client mux over `ws`, or add a unary
  `workspace.list` to the fork? (Adding unary is the smaller, more robust path.)
- `main`/`conversation.view` scoping: does a non-`SessionId` selection fit, or does the
  plugin own a parallel "remote selection" and render into `main` when set?
- Single-slot override precedence for `sidebar.workspaces` (wrap approach).
- Does the embedded shell need the HMR `plugins/events` EventSource at all? Proxying it
  is fine but noisy; could 204 it under `/remote/*`.
- Session create request shape: preset + model + effort fields — copy from
  `packages/api/session-controller/src/types.ts` at implementation time.

## 9. Pointers

- Ingress plugin to mirror: `plugins/dsh-tailscale-remote/{index.js,proxy.mjs,state.mjs,src/client/index.tsx}`; recipe `recipes/tailscale-remote-plugin.md` (auth tiers, slash guard, `webServer` route registration, Tailscale mount facts).
- Fork branch: `fix/tailscale-mounting` (document-relative URLs; `host-base.ts`, `browser-auth.ts` redirect).
- DSH seams: `packages/client/connection/README.md` (trust fence, cookie, envelope), `packages/api/gateway/README.md` (unary POST + `/api/remote.mux`), `packages/api/{session,workspace}-controller/src/{commands,control,index}.ts` (method names), `packages/client/ui-workspace/src/client/index.ts` (`sidebar.workspaces` slot), `packages/client/ui-conversation/src/client/apply.ts` (`main` / `conversation.view` slots).

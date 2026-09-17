# dsh-remote-workspaces

Mirror workspaces of **other DSH servers** in this GUI. A remote workspace is a
sidebar row whose sessions live on another DSH host reached over the tailnet
(published there by `dsh-tailscale-remote`). Selecting one of its sessions frames
the remote GUI's chrome-less page — `?embed=<sessionId>`, DSH branch
`feat/embed-session` — in an iframe served **same-origin** by this plugin at
`/remote/<server>/…` through an egress proxy that holds the remote's credentials.
Management (list / create / rename sessions) goes host-to-host through the same
egress and the remote's Typert Remote endpoints (`POST /api/<ns>/<method>`).

Design and status: `../../notes/remote-workspaces-plan.md`.

## Status

- **Phase 2 (done):** egress proxy (HTTP + WebSocket upgrade for `api/remote.mux`),
  auth bridge (tailnet identity, or standing token → cookie, re-exchanged on 401),
  `Location` rewriting back under the mount, control channel `/remote-workspaces`.
- **Phase 3 (done):** persisted registry (`servers.probe`, `workspaces.add|poll|remove|
  rename|reorder`, `sessions.rename|archive|start|reorder`) and the browser half: a
  bottom-anchored **Remotes** section (fork seat `sidebar.workspaces.extra`; header =
  label + refresh-all + badged add, nothing else) with one group per mirrored
  workspace — cached rows + spinners, ↻ / … / + actions, drag-to-reorder groups and
  sessions within a group (local order layered over the remote's),
  add-remote modal (URL → probe → pick or new directory → name), keyed `main` panel
  host + `shell.overlay` iframe pool (10 min hidden TTL, cap 4), reload restore.
  Verified end to end with two local DSH instances; see
  `../../recipes/remote-workspaces-plugin.md`.
- **Not yet exercised:** a real `dsh-tailscale-remote` upstream over HTTPS in
  identity mode. **Later:** title sync without ↻ (postMessage from the embed),
  interleaving remote groups with local ones, remote workspace path browsing.

## View options and hover cards

The section header carries the same View-options icon as the local tree:
**Group by** Workspace (default; collapsed groups cost no network), Server
(one collapsible group per remote, workspaces nested), or In one list
(every remote session, newest first, with a `workspace · server` caption);
**Order by** Manual (the persisted drag order / the remote's order), Last
updated, or Last created (the remote account's position — `session.list`
carries no createdAt). Manual is the only order with drag handles. Server
and flat views need every workspace current, so entering them polls all of
them and then every 60 s while the view is up (`FLAT_POLL_INTERVAL_MS`).

Hovering shows a card like the local rows': a session → title, `workspace ·
server`, relative time, Running/Idle dot, permission mode when the remote
listed one; a workspace → title, `server:path`, the remote's own name when
it differs, its registration time, session count and when it was last
fetched (copy = path); a server → label, URL, workspace/session counts, auth
mode and last bridge failure (copy = URL). Persisted view state:
`groupBy`, `orderBy`, `serverExpanded` in `dsh.remote-workspaces.view`.

## Moving sessions across hosts

Every remote session row's `…` menu has **Move to…**; every local session row
gains **Move to remote…** (contributed through the fork's
`ctx.uiWorkspace.contributeSessionMenu`). One dialog serves both, listing the
other workspaces of the same remote, the other remotes, and (for a remote
source) the local workspaces:

| source → destination | mechanism |
|---|---|
| remote → another workspace of the same remote | the remote's own `session.move` (`sessions.move`) |
| remote → local, local → remote, remote A → remote B | `sessions.transfer`: export at the source (`GET /api/session.export`, ZIP with descendants + attachments), import at the destination (`POST /api/session.import`), then **archive** the source copy — never delete |

Cross-host copies keep the exported id when it is free at the destination and
mint a new one otherwise (the dialog says so); the destination's projection
cache is seeded, so the row shows its title at once. A live source refuses
with `session/move-live` and the dialog offers stop-and-move (which cancels
the running turn first). Local↔local moves are the shell's own dialog, not
this plugin's. The host relay reaches the local API in-process through
`connection.createSharedFetchHandler('/api')` and the remote through the
egress (`call` for JSON remotes, `fetchRaw` for the binary export/import
routes). Not yet: dragging a local row onto a remote group (cross-tree DnD
would need a shared dataTransfer type in the fork's rows).

## Files

| File | Role |
|---|---|
| `index.js` | Plugin entry: mounts `/remote/<id>` (prefix route) + `/remote/<id>/api/remote.mux` (upgrade route) per server, gated by DSH's own browser-session check; control channel. |
| `egress.mjs` | One remote: URL facts, token exchange, header rewriting, request/upgrade forwarding, `call(ns, method, args)`. |
| `state.mjs` | `$DSH_HOME/remote-workspaces.json` (0600): servers + mirrored workspaces with cached sessions. |
| `src/client/{api,store}.ts`, `ui.tsx`, `index.tsx` | Browser half (built to `lib/client.js` by `build.mjs`): control-channel API, persisted view + runtime stores, components, slot registrations. |

## Config

```yaml
- id: tali-remote-workspaces
  name: dsh-remote-workspaces        # or the absolute path to index.js in a dev overlay
  config:
    routePrefix: /remote             # local mount of the egress routes
    stateFile: ''                    # '' = $DSH_HOME/remote-workspaces.json
    servers:                         # seed entries (present every boot, never persisted)
      - id: rv                       # route segment: /remote/rv/
        url: https://robotics-vm.tailbce956.ts.net/dsh/
        label: robotics-vm
        token: ''                    # '' = rely on tailnet identity at the remote
```

## Server names

A remote's default label is `friendlyRemoteName(url)` (egress.mjs): loopback →
`localhost`, a MagicDNS tailnet host → its first label (`alpha` for
`alpha.tailbce956.ts.net`), otherwise the hostname; the port is appended
unless it is the scheme's default, and the mount path is kept because one
host may serve several instances (`localhost:3082`, `alpha/dsh`,
`box.example.com:8443/dsh`). The user's own label (add-modal, rename) wins.
Servers stored under the old derivation (bare first hostname label, e.g.
`127`) are relabelled once on load. The add-modal's suggested workspace name
uses the label with `:`/`/` turned into dashes (`alpha-dsh-<workspace>`).

## Titles of framed sessions

The framed page is a separate document with no channel back to this plugin,
so the sidebar learns about a remote session's first turn (title, activity)
only by polling. Selecting a remote session schedules follow-up polls of its
workspace at +12 s / +40 s / +90 s and then every 2 min while the remote
panel stays active (`scheduleFollowUp` in store.ts), which turns the gray
"New session" placeholder into the titled row without a manual refresh.
The `slug: prompt` naming is done by the remote's own shell (the
`session-title-slug` client plugin must be installed *there* — the deploy
script ships it); a remote whose sessions default to a small on-device model
should pin its titler to a capable model or titles come out like "New
session" (the deploy overlay pins `session-title-llm`).

## Facts worth keeping

- The embedded shell computes every Host URL relative to its document directory,
  so the iframe URL is `/remote/<id>/?embed=<sessionId>` **with the slash**; the
  plugin 301s the slash-less form and keeps the query.
- Remote RPC args are keyed by the method's *parameter name*: `session.list` takes
  `{ _request: {} }`, `session.create` / `workspace.create` / `session.rename` take
  `{ request: {...} }`. A `session.list` item is
  `{ sessionId, updatedAt, running, blank, cwd, projections: { values: { title, … } } }`
  — `cwd` is how sessions map to a workspace.
- Launcher flags come before app args: `dsh --profile web --patch x.yml --port 3081`
  (`dsh web --patch …` is rejected).
- Dev two-instance test: remote = worktree DSH on 3082 with a throwaway home,
  local = worktree DSH on 3081 with another throwaway home and a `--patch` overlay
  seeding `servers: [{ id: rv, url: http://127.0.0.1:3082/, token: <remote launch token> }]`.
  A bare DSH's launch token exchanges exactly like `dsh-tailscale-remote`'s token.

## Tests

`node --test tests/*.test.mjs` — fake remote with token exchange, header rewriting,
Location mapping, 401 re-exchange, WebSocket echo, unreachable remote, identity mode.

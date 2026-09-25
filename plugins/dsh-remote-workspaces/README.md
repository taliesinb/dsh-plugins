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
  label + refresh-all + add, nothing else; the globe badge on the add button and
  the folders went 2026-09-24) with one group per mirrored
  workspace — cached rows + spinners, ↻ / … / + actions, drag-to-reorder groups and
  sessions within a group (local order layered over the remote's),
  add-remote modal (URL → probe → pick or new directory → name), keyed `main` panel
  host + `shell.overlay` iframe pool (10 min hidden TTL, cap 4), reload restore.
  Verified end to end with two local DSH instances; see
  `../../recipes/remote-workspaces-plugin.md`.
- **Not yet exercised:** a real `dsh-tailscale-remote` upstream over HTTPS in
  identity mode. **Later:** title sync without ↻ (postMessage from the embed),
  interleaving remote groups with local ones. Remote path browsing arrived 2026-09-24
  as the add-modal's completing path field (below).

## The add-remote modal (2026-09-24)

**Step 1 — server.** The field takes a full URL or a short form; the host
normalizes it (`resolve.mjs` `normalizeRemoteInput`, called by `servers.probe`
and `workspaces.add`, so the canonical form is what gets stored):

| typed | becomes |
|---|---|
| `user@host` | `https://host.<magic-dns-suffix>/dsh/user/` (one DSH per account on a shared machine) |
| `host/dsh/user`, `host` | `https://host.<magic-dns-suffix>/…/` |
| `host.example.ts.net/dsh/user` | `https://` added |
| `localhost:3082/x`, `127.0.0.1:3082`, `[::1]:3080`, any IPv4 literal | `http://` added (no certificate can name these) |
| `https://…` | kept; a dot-less host still gets the suffix; trailing slash added |

The suffix comes from `tailscale status --json` (`MagicDNSSuffix`, cached 5 min;
the CLI is looked up on PATH and in the macOS app bundle), else from the
`*.ts.net` hostname of any known server, else the host stays bare. It is
needed because the Serve certificate names the FQDN — `https://studio/` fails TLS.

**Step 2 — workspace.** "Connected to *host* in *N* ms", the remote's
workspaces (mirrored ones grayed) and **New workspace**. Picking it shows a
path field that starts at `~/` and talks to the remote *while you type*: every
keystroke (120 ms debounce) asks the local host `servers.inspectPath`, which
goes through the egress to the remote by whichever of two doors it has
(`remote-fs.mjs`): the **remote's own dsh-remote-workspaces** control channel
(`POST <remote>/remote-workspaces/fs.inspect` — `callControl` in egress.mjs,
the same envelope as the `/api` calls; one round-trip, `stat`-exact), else
**DSH's own `directoryPicker` Remote** there (`list(path)` /
`createDirectory(parent, name)`, the in-app directory browser's primitives,
present on every instance whose composed picker is the `browse` backend —
every relay-started / headless instance of the fork; kind and creatability are
read off the listing failures' `ENOENT` / `ENOTDIR`, `~` from the listing's
`home`, and a missing directory is made segment by segment from the nearest
listable ancestor). Once the plugin door answered "no such endpoint" the egress
remembers it and later keystrokes go straight to the picker. Either way the
answer is the remote's view of its filesystem: `~` expanded against *its* home, `kind` (directory / file /
missing), `creatable` (nearest existing ancestor is a directory), and the
completion candidates — child directories of the typed directory whose names
start with the typed last segment (hidden ones only when the segment starts
with `.`, symlinks to directories included, files never; 40 max). Under the
field: **Tab** completes (one candidate → with a slash; several → their common
prefix, then the first; a highlighted one → that one), ↑↓ highlight, Enter on
a highlighted row accepts it, click works too. The verdict line is gray
**Directory exists** / orange **Directory will be created** / red *Not a
directory* or *Cannot create it: … is a file*; the resolved absolute path
sits at its right. `~/` and `/` themselves are not accepted (Done stays
disabled). A path that already is a workspace on the remote is added as that
workspace (grayed when this sidebar already mirrors it). Done sends the
*resolved* path with `create: true` when it is missing: the host asks the
remote to `fs.mkdir` (`mkdir -p`) before `workspace.create`, which itself
requires an existing directory.

A remote with **neither** door — no plugin *and* no browse picker (a native
OS-chooser picker answers `directory-picker/unavailable`; a DSH without the
namespace answers its 404 page) — is reported `remote-workspaces/fs-unavailable`
and the field falls back to the old rule: orange **Caution: server is running
an older version**, Done takes an absolute path on trust (no completion, no
`~`, no creation). The same line shows while the *local* host still runs a
plugin from before `servers.inspectPath` (host module edits need a `dsh web`
restart). Why two doors (2026-09-25): a shared server whose instances must not
act as remote-workspace *clients* runs no dsh-remote-workspaces at all (host
policy), which from 2026-09-24 to 09-25 also silenced the path field for every
laptop adding it — the picker door needs nothing installed on the remote.

Security: `fs.inspect` / `fs.mkdir` are served on this host's control channel
for peers and are gated like everything else (`connection.requestRejection`:
admitted browser session / tailnet identity). They list directory names
anywhere on the filesystem — no more than the shipped browse directory
picker does for any admitted client, and far less than the agent it can run.

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

Every remote session row's `…` menu has **Move to…** / **Copy to…** (this
plugin's dialog, tree-shaped: *This machine* first, then each remote under its
label). Local session rows keep the shell's own **Move to…** / **Copy to…**;
since 2026-09-24 the plugin contributes its remotes to those dialogs through
the fork's `ctx.uiWorkspace.contributeDestinations` (one group per server,
listed after *This machine*) and carries out a pick of one in `run` — so a
local session reaches a remote from the same dialog it reaches another local
workspace, and there are no separate "…to remote…" menu items any more. The
plugin's dialog lists the other workspaces of the same remote, the other
remotes, and the local workspaces:

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

### Copying sessions (2026-09-24)

Beside each Move item sits its non-destructive twin: **Copy to…** on remote
rows (this plugin's dialog in `copy` mode) and, for local rows, the remotes
listed inside the shell's own Copy to… dialog (see above). A
copy stores a *new* session (fresh ids, root and descendants alike) and never
touches the source — no cancel, no archive, a running agent keeps running:

| source → destination | mechanism |
|---|---|
| remote → any workspace of the same remote (its own included = duplicate) | the remote's `session.copy` (`sessions.copy`) |
| remote → local, local → remote, remote A → remote B | `sessions.copyAcross`: export at the source, import at the destination with `mode=copy[&truncate=true][&title=…]`; nothing at the source changes |

The dialog prefills the title as “<title> (copy)” (editable; unchanged =
keep the source's). A running source is refused once with
`session/copy-live`; the dialog then shows **Copy only up to the last
completed turn** (ticked by default: the turn in progress and the prompt that
started it are left out; unticked: everything recorded so far is kept and the
turn is closed as interrupted) and the operator confirms again. Local↔local
copies are the shell's own **Copy to…** (`session.copy`). Recipe:
`recipes/copy-sessions.md`.

## Files

| File | Role |
|---|---|
| `index.js` | Plugin entry: mounts `/remote/<id>` (prefix route) + `/remote/<id>/api/remote.mux` (upgrade route) per server, gated by DSH's own browser-session check; control channel. |
| `egress.mjs` | One remote: URL facts, token exchange, header rewriting, request/upgrade forwarding, `call(ns, method, args)` (`/api`), `callControl(endpoint, args)` (the peer plugin's `/remote-workspaces`). |
| `resolve.mjs` | Add-modal helpers: `normalizeRemoteInput` (short forms → URL, MagicDNS suffix), `inspectPath` / `makeDirectory` (the `fs.*` endpoints served for peers). |
| `remote-fs.mjs` | The same two questions asked *of a remote*: its `fs.*` when it has the plugin, else DSH's `directoryPicker.list` / `createDirectory` there; `fs-unavailable` only when neither door exists. |
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
        url: https://robotics-vm.example.ts.net/dsh/
        label: robotics-vm
        token: ''                    # '' = rely on tailnet identity at the remote
```

## Server names

A remote's default label is `friendlyRemoteName(url)` (egress.mjs): loopback →
`localhost`, a MagicDNS tailnet host → its first label (`studio` for
`studio.tail1234.ts.net`), otherwise the hostname; the port is appended
unless it is the scheme's default, and the mount path is kept because one
host may serve several instances (`localhost:3082`, `studio/dsh`,
`box.example.com:8443/dsh`). The user's own label (add-modal, rename) wins.
Servers stored under the old derivation (bare first hostname label, e.g.
`127`) are relabelled once on load. The add-modal's suggested workspace name
(and the host's fallback when `addWorkspace` gets no title) is the remote
workspace's own name — `Music` for `~/Music` — not prefixed with the server
label (that was `studio-dsh-Music` before 2026-09-24; existing rows keep
whatever title they were added with).

## Titles of framed sessions

The framed page is a separate document with no channel back to this plugin,
so the sidebar learns about a remote session's first turn (title, activity)
only by polling. Selecting a remote session schedules follow-up polls of its
workspace at +12 s / +40 s / +90 s and then every 2 min while the remote
panel stays active (`scheduleFollowUp` in store.ts), which turns the gray
"New session" placeholder into the titled row without a manual refresh.
While a framed blank session is being typed into, its placeholder row shows
the slug live: the frame is same-origin, so `useFramedSlugPreview` reads the
framed composer's text every 300 ms and parses it with the convention the
local `session-title-slug` plugin publishes on
`globalThis.__DSH_SESSION_TITLE_SLUG__` (no plugin locally → no preview,
like local rows). A framed blank session whose persisted draft is non-empty keeps a dimmed
"ghost" row after you switch away (parity with the slug plugin's local ghost
rows): the poll records the workspace's blank session ids
(`cache.blankIds`), and `useDraftGhosts` reads each one's draft from this
origin's localStorage (`embed:<id>:dsh.conversation.<id>` — the framed page
namespaces its stores per embedded session), labelling the row with the
draft's slug or "New session"; clicking it re-selects the frame. Row
highlight follows `remoteActive`, so a remote row is not shown selected
while a local session is on screen. The `slug: prompt` naming itself is done by the remote's own shell (the
`session-title-slug` client plugin must be installed *there* — the deploy
script ships it); a remote whose sessions default to a small on-device model
should pin its titler to a capable model or titles come out like "New
session" (the deploy overlay pins `session-title-llm`).

## For other browser plugins: `ctx.remoteWorkspaces`

The browser half provides an optional Cordis service so sibling plugins can
treat remote sessions like local ones without a build-time dependency —
consume it with `ctx.inject(['remoteWorkspaces'], scoped => …)`, which runs
only while this plugin is loaded and unwinds when it goes (first consumer:
`numbered-switching`, which numbers remote sessions alongside local ones and
brings a remote frame back with ⌘N).

```ts
interface RemoteWorkspacesFace {
  getSelection(): { workspaceId: string; sessionId: string } | undefined  // the remote session ON SCREEN (undefined while a local Conversation / another panel shows)
  has(selection): boolean      // false only on positive evidence (workspace gone, or fetched and not listing the session); unknown = true
  open(selection): void        // what a row click does: select + show the remote panel
  subscribe(listener): () => void  // view (selection, on-screen) + runtime (catalogue) changes
}
```

Row identity for DOM patchers: every remote session row carries
`data-remote-session="<workspaceId>:<sessionId>"` (the frame key).

Fact for such consumers: the framed page is a **same-origin** shell running
the same client plugins, and iframes share the tab's `sessionStorage` — a
plugin with per-window browser state must stay inactive in embedded shells
(`ctx.layout.embedSessionId !== undefined`) or it will fight its outer
instance.

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
Location mapping, 401 re-exchange, WebSocket echo, unreachable remote, identity mode,
`callControl`; `resolve.test.mjs` (input normalization, `inspectPath` over a temp
home); `peer.test.mjs` (two plugin instances on two http servers: local
`servers.inspectPath` → egress → remote `fs.inspect`; `workspaces.add` with
`create` making the directory on the remote; a plugin-less remote → `fs-unavailable`).

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
  rename`, `sessions.rename|archive|start`) and the browser half: badged add button
  (fork seat `sidebar.workspaces.headerAction`), remote groups below the local tree
  (`sidebar.workspaces.extra`) with cached rows + spinners, ↻ / + / … actions,
  add-remote modal (URL → probe → pick or new directory → name), keyed `main` panel
  host + `shell.overlay` iframe pool (10 min hidden TTL, cap 4), reload restore.
  Verified end to end with two local DSH instances; see
  `../../recipes/remote-workspaces-plugin.md`.
- **Not yet exercised:** a real `dsh-tailscale-remote` upstream over HTTPS in
  identity mode. **Later:** title sync without ↻ (postMessage from the embed),
  interleaving remote groups with local ones, remote workspace path browsing.

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

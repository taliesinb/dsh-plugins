# Moving sessions and rehoming workspaces — UI design

Status: **agreed design, implementation starting** (2026-09-16). Supersedes the
surface proposed in [`workspace-moving-tools.md`](workspace-moving-tools.md); that
note's mechanics (header `cwd` is membership; lease = liveness test; inbox-spliced
notice; subagent children move with parents) stand and are referenced here rather
than repeated. Target fork branch: `feat/embed-session` (worktree
`~/github/deepseek-harness-embed`, DSH `0.1.6-alpha.1`).

## 1. Decisions

- **First-class fork operation, not a plugin over private seams.** The
  `replaceHeaderIndex` / header-index internals the third-party plugin used do not
  exist in our fork (persistence memoizes stored logs differently). `session.move`
  lives inside the fork where it can use package-internal persistence code and be
  tested; a model-facing tool may call it later but is not the surface.
- **Sidebar actions, both local and remote:** "Move to…" on a session row, "Rehome…"
  on a workspace row, plus **drag a session onto another workspace = move**.
- **Menu contributions are data, not React.** A registry
  (`ctx.uiWorkspace.contributeSessionMenu / contributeWorkspaceMenu`) that rows read
  when building their `Menu`; `dsh-remote-workspaces` rows consume the same registry
  so remote rows get identical items.
- **Live sessions:** offer *stop-and-move* (dispose the resident agent, move cold,
  resumes in the new workspace on next open). Never move a live session in place.
- **Cross-host moves keep the source as an archived copy** (tombstone title
  "moved to <host>/<workspace>") until the user deletes it; the one place a bug
  would lose work.
- **Membership is exact-path**, so moving into a workspace on the same tree
  (a subfolder) still rewrites `cwd`.
- **Notice is mandatory** (`agent/inbox/spliced`, `target: 'next-step'`,
  `source: {kind:'plugin'|'system'}`), surfaces at the next prompt even with no
  pending turn. Cross-host wording adds: earlier file references may not resolve.
- **Upstream later:** `session.move` + menu seats are generic (PR candidates); the
  cross-host relay stays in the plugin.

## 2. Fork work

### 2.1 Host: `session.move` / `moveMany` (Session Controller)

```ts
move({ sessionId, destination: { workspaceId } | { path }, stopLive?: boolean, notify?: boolean })
  → { sessionId, workspaceId, moved: SessionId[] /* incl. children */ }
moveMany({ sessionIds, destination, stopLive?, notify? })
  → { moved, skipped: { sessionId, reason: 'live' | 'missing' | 'error', message? }[] }
```

Persistence primitive `relocate(id, newCwd, { appendEvents })` in
`session-persistence-jsonl`:

1. `acquireWriteLease` → `SessionAlreadyOwnedError` ⇒ `live`. With `stopLive`, the
   controller disposes the resident Agent first (same path as closing), then retries.
2. Read current log (v0→v3 migration already published by `open('write')`), rewrite
   header `cwd`, append the notice event, validate every row through the generation
   format, re-encode (header frame + events).
3. Backup under `$DSH_HOME/session-move-backups/<uuid>/` → write under
   `sessions/<projectKey(new)>/<id>/` → tombstone the old dir → invalidate the
   memoized stored log and the projcache entry (`identity.cwd`) →
   `old.detachSession` / `new.attachSession` → emit `session/moved` (Client list
   and Workspace projections update) → rollback on any failure.
4. Same-cwd subagent children whose `parentSession` is in the set move too.

**Rehome** = `workspace.create(dest)` if needed (title kept) + `moveMany(members +
children)` + report skipped + optional `workspace.delete(source)` when empty.

Notice text (permission clause from the last `sandbox/mode` event; omitted for
`danger-full-access`):

> NOTE: this session's workspace was changed from `A` (/path/a) to `B` (/path/b);
> your current permissions of `Workspace Write` now grant access to this new directory.

Tests: on a copied throwaway home — cold move, live refusal, stop-and-move,
children follow, rollback on injected failure, projcache miss-not-error, notice
visible on first turn after resume, sandbox root in the runtime-context snapshot.

### 2.2 Client: menu contributions + modals + DnD (`ui-workspace`)

- Registry on `ctx.uiWorkspace`: `contributeSessionMenu(entry)` /
  `contributeWorkspaceMenu(entry)` with
  `{ id, label, icon?, order, danger?, when?(target), run(target) }`; targets
  `{ sessionId, workspaceId?, title }` and `{ workspaceId, path, title }`. Rows
  append contributions after the built-ins; a `session.moved` / registry change
  re-renders.
- Built-in contributions (shipped in `ui-workspace` itself): **Move to…** (session),
  **Rehome…** (workspace).
- **Move modal:** destination list = existing workspaces (local; remote ones
  contributed by the plugin, grouped by server) + "New workspace from directory…"
  (reuses `WorkspacePickFlow` / `sidebar.workspaces.directoryFlow`). Live session ⇒
  checkbox "Stop the running session and move it" (default off, Move disabled until
  ticked). "Tell the agent" checkbox default on.
- **Rehome modal:** same destination picker; shows member count, live count; options
  "also move live sessions (stops them)", "delete the empty source workspace",
  "tell each agent"; result summary lists stragglers.
- **DnD:** the tree's existing session drag accepts a drop on another workspace row
  (or into its member list) ⇒ `move`. Live session drop ⇒ the Move modal opens
  pre-filled instead of moving silently. Remote group rows are drop targets through
  the plugin (see §3).

### 2.3 Host: `session.export` / `session.import` (cross-host)

- `export({ sessionId })` → `{ header, log: <current-format rows>, attachments: { sha256 → base64 }[] }`
  (only blobs the log references; the existing session-log download route is the
  precedent). Size-capped; large sessions stream in chunks (`mode: 'stream'`).
- `import({ workspaceId | path, bundle, keepId?: boolean })` → `{ sessionId }`:
  writes the log under the destination cwd with a rewritten header, ingests
  attachments into `attachments/v1/`, attaches to the workspace, appends the
  cross-host notice; on id collision re-ids and records `session/imported` with the
  origin. Refuses when a live session owns the id.

## 3. Plugin work (`dsh-remote-workspaces`)

- Remotes rows build their `…` menus from the same registry (local contributions
  gain remote targets: `{ sessionId, remote: { serverId, workspaceId } }`).
- Destination picker: plugin contributes remote workspaces (from cached snapshots;
  probes on open) to the Move/Rehome modals.
- Relay in the host half (all via egress `call`):

| Move | Mechanism |
|---|---|
| remote → same remote, other workspace | remote `session.move` |
| local → remote | local `export` → remote `import` → local archive + tombstone title |
| remote → local | remote `export` → local `import` → remote archive |
| remote A → remote B | local host relays `export` → `import` |

- DnD: remote group rows accept local and remote session drops; local workspace rows
  accept remote session drops (plugin registers a drop handler with the tree).
- Cross-host id/cwd facts: ids are uuids (collision handled by `keepId=false`
  fallback); `cwd` always rewritten to the destination's path; hosts may differ in
  OS/home — the notice says so.

## 4. Order of work

1. Fork host — **DONE 2026-09-17**, commit `0945cab815` on `feat/embed-session`.
   Deviations from §2.1 worth knowing: no new `session/moved` event — the existing
   `api-session/added` is an upsert on the client (`mergeSummary`), so the moved
   summary is re-emitted with its new cwd; the workspace registry (not persistence)
   is where the header cache lives (`forgetSessionHeader`); the projection cache
   identity includes cwd, so a `rebind()` keeps the title across the move (without
   it the row falls back to the directory basename until the session is opened);
   `stopLive` works because the controller now retains `AgentHandle`s and
   `retire()`s them; a session stored under the destination but not on its account
   is simply attached (repairs an interrupted move). The retired artifact is the
   **session-log directory only** — `$DSH_HOME/sessions/<projectKey(oldCwd)>/<id>/`
   (log + lock file), renamed into `$DSH_HOME/session-move-backups/<id>-<ts>/`; the
   workspace directory with the user's files is never touched. Successive moves before
   the Agent runs again replace the pending notice (origin carried forward) instead of
   stacking one per hop (`2824719acb`). Archive is registry-global and
   survives a move (an archived session stays hidden in the new workspace — correct,
   but surprising when testing). RPC: `session/move` `{ request: { sessionId,
   destination: { workspaceId } | { path, title? }, stopLive?, notify? } }`,
   `session/moveMany` `{ request: { sessionIds, destination, … } }`.
   **Unblocks the concrete migration from the tools note** (one-off `moveMany` call;
   recipes-workspace → `tali-dash-plugins`) — not yet run against the live home.
2. Fork client — **DONE 2026-09-17**, commit `6667d9d984`. `ISessions.move/moveMany`
   (RemoteResult, not thrown); "Move to…" / "Rehome workspace…" row items; dialogs in
   `rows/MoveDialogs.tsx` reuse `WorkspacePickFlow` as the destination picker;
   stop-and-move offered only after a `session/move-live` refusal (no client-side
   liveness guess); drag onto another group = move (refusal → dialog prefilled);
   `ctx.uiWorkspace.contributeSessionMenu/contributeWorkspaceMenu` + observable
   `menuContributions`. Verified live on the preview. Pre-existing failing test noted:
   `client-runtime/tests/assembly-dependencies` (HMR without Connection) fails on this
   branch before these changes too.
3. Fork host — **DONE 2026-09-17**, commit `2824719acb`. Export already existed
   (`GET /api/session.export?sessionId=&includeDescendants=true`, ZIP with
   `session.v3.jsonl`, `subagents/<id>/…`, `media/`, `files/`). Added
   `POST /api/session.import?workspaceId=|cwd=[&origin=&keepIds=&notify=]` with the
   ZIP as body (`session-log-export/src/import.ts`): strict-restore parse, attachments
   saved (content-addressed → refs stay valid), ids kept when free / re-minted with
   children re-parented, root gets a `session-import` notice, root attached. It is an
   HTTP route, not a Typert Remote (binary body); the plugin relay in step 4 streams
   `export` → `import` through the egress. Verified between two local instances,
   including the resumed Agent seeing the notice and `pwd` in the new workspace.
   Known gap: the destination has no projection cache for the imported session, so the
   sidebar row shows the directory basename until first open (the title lives in the log
   and resurfaces then); bundling `sessionListMetadata`/title hints is a later nicety.
4. Plugin — **DONE 2026-09-17**, commit `b73cb81` (+ fork `250059b520`: a generic
   `session-persistence/stored(header)` event the Session Controller turns into the
   client's `api-session/added` upsert, so import/relocate don't build summaries; import
   seeds the destination's projection cache via `coldSnapshot` so titles show at once).
   Plugin host: `sessions.move` (same remote) and `sessions.transfer` (export → import →
   archive source; stopLive cancels first); egress `fetchRaw`; local API in-process via
   `connection.createSharedFetchHandler('/api')`. Client: "Move to…" on remote rows,
   "Move to remote…" contributed to local rows (`ctx.inject(['uiWorkspace'])` — a plain
   `ctx.get` at apply time ran before the service existed), one `MoveRemoteDialog`.
   Verified all three paths live. **Not done:** dragging a local row onto a remote
   group (the fork's DnD is tree-internal; cross-tree needs a shared dataTransfer type);
   rehome of a remote workspace (remote-side `moveMany` is one RPC away but has no UI).

## 5. Follow-ups

- Cross-tree DnD (local row → remote group and back).
- Rehome for remote groups (call the remote's `session.moveMany`).
- Export bundling of `sessionListMetadata` is unnecessary now (cache seed covers it).
- Run the concrete migration from `workspace-moving-tools.md` against the live home once
  the live server runs `feat/embed-session`: `session.moveMany` of the recipes-workspace
  sessions into `~/github/tali-dash-plugins`.
- Exercise the real tailnet path against alpha (asleep at time of writing).

## 6. Pointers

- Mechanics + reference implementation notes: `workspace-moving-tools.md`.
- Menus: `packages/client/ui-workspace/src/client/rows/Rows.tsx` (`sessionMenuItems` ~417, `workspaceMenuItems` ~129); DnD wiring there and in `tree.ts`.
- Destination picker: `WorkspacePickFlow` in `rows/WorkspaceBrowser.tsx`.
- Persistence: `packages/session/session-persistence-jsonl/src/index.ts` (`open`, `acquireWriteLease`, `locate`, `memoizeStoredLog`, `resolveCurrentLog`), `format.ts` (`projectKey`, sessionDir).
- Registry: `packages/workspace/workspace/src/entity.ts` (`attachSession` 109, `detachSession` 174).
- Session Controller: `packages/api/session-controller/src/{commands,agent,control}.ts`.
- Remote-workspaces plugin: `plugins/dsh-remote-workspaces/` (egress `call`, Remotes section).

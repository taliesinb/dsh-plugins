# Moving sessions between workspaces / rehoming a workspace

Investigation notes, 2026-09-17, against DSH `0.1.6-alpha.1` (checkout
`~/github/deepseek-harness`, live home `~/.dsh`). Motivating case: move every
session of workspace `deepseek-harness` (`~/projects/deepseek-harness`, the
code-free recipes workspace) to a new workspace at `~/github/tali-dash-plugins`,
leaving live/open stragglers behind, and tell each moved agent what happened.

## 1. Not built in

- **Attach happens only at creation.** `packages/api/session-controller/src/commands.ts:101`
  derives `cwd` from the chosen workspace and calls `attachSession` then. The
  `workspace/*` remotes are create / delete / rename / insertBefore /
  archiveSession / unarchiveSession and `insertSessionBefore` (reorder *within*
  a workspace). No attach-existing, no move.
- **Membership is header-validated; editing `storages/workspace.json` is not
  enough.** `packages/workspace/workspace/src/entity.ts:101` — `sessionIds`
  filters to sessions whose header `cwd` canonicalizes to the workspace `path`;
  `attachSession` throws `its cwd resolves to '…'` on mismatch. That is why
  `tools/attach-session-to-workspace.py` worked for imports (cwd already
  matched) and would not work here.
- **The header `cwd` is treated as immutable and drives everything:**
  - on-disk location `sessions/<projectKey(cwd)>/<id>/`
    (`session-persistence-jsonl/src/format.ts:224,253`; e.g.
    `--Users-tali-projects-deepseek-harness--`);
  - resume check `ApiSessionCwdConflict` (`session-controller/src/agent.ts:265,456`);
  - sandbox root: `sandbox-policy/src/index.ts:168` uses `session.header.cwd`;
  - shell/fs tool cwd (`tool-fs/src/session-cwd.ts`), search cwd, the
    "Your working directory is …" prompt line.

  All of these read the header **live**, so once the stored header says the new
  path, permissions, shell cwd and prompt follow automatically — exactly the
  "Workspace Write now grants access to the new directory" semantics wanted.
- **The running server owns `workspace.json` in memory** and rewrites it on any
  mutation. It also keeps a private header/path index (`headers`,
  `sessionPaths`) refreshed only by `replaceHeaderIndex()` (TS-`private`, but
  present at runtime).
- **Other stores:** `rewind-snapshots/<sessionId>/` and content-addressed
  `attachments/v1/` are cwd-free — nothing to do. `archivedSessionIds` is
  registry-global — untouched by a move. `storages/session_projcache/sessions/<id>.json`
  embeds `identity.cwd`, so a moved session's entry becomes an identity miss
  and rebuilds (to verify: miss, not error).
- **Log format:** no hash chain; `seq` must strictly increase
  (`core/session/src/invariant.ts:61`), so appending an event offline is
  feasible. `SESSION_FORMAT_VERSION = 3`; `persistence.open(id,'write')`
  publishes the v0→v3 migration first (`publishStoredMigration`).
- **Agent-notice mechanism:** `agent.inject(UserMessage)` writes an
  `agent/inbox/spliced` event with `target: 'next-step'`; the inbox fold
  (`core/agent-loop/src/inbox.ts`) reconstructs pending input from these on
  resume. `browser-automation` already injects plugin notices this way
  (`source: {kind:'plugin', plugin: …}`; content must be a `ContentBlock[]`,
  see `recipes/plugin-inject-string-content-bug.md`).

### State of the `deepseek-harness` workspace (2026-09-17)

Registry id `80fb22cf-c2d8-4ab4-8dfd-d2f73014c749`, 29 accounted sessions
(23 v0-only logs, 6 v3; 4 dirs hold both generations plus `session.lock`), and
**6 unaccounted subagent-child sessions** in the same cwd dir (`origin: subagent`,
`delegationDepth: 1`, parents `session-f7d28ebb…` ×4 and `session-342f03b5…` ×2)
that should move with their parents. `~/github/tali-dash-plugins` is not yet a
workspace.

## 2. Third-party plugins (found via awesome-dsh-plugin; both cloned and read)

| Plugin | Verdict |
|---|---|
| [Unintendedz/dsh-session-workspace](https://github.com/Unintendedz/dsh-session-workspace) v0.2.0, MIT, ~830 lines readable source + tests | **Host half is well-engineered** and is the right reference: `open(id,'write')` lease (refuses live sessions; publishes v0→v3), header rewrite, whole-artifact re-validation through `persistence.generationFormat.createRestore`, per-generation backup to `$DSH_HOME/session-workspace-backups/<uuid>/`, tombstone-rename + hard-link publish, rollback, then `replaceHeaderIndex` + detach/attach. Every seam it uses exists in our build (`open/locate/acquireWriteLease`, `ctx.connection.rpc.handle(channel, handler)`); two are TS-private (`replaceHeaderIndex`, `generationFormat`); pinned to DSH 0.1.5-rc.1. **Gaps:** one session per click, destination must already be a workspace, no agent notice, and the **browser half is DOM scraping** (`[role=menu]` + `__reactFiber$` walk to recover the session id, splices a menuitem) — fragile and against our slot-based house rules. |
| [hkkz9522/dsh-session-manager](https://github.com/hkkz9522/dsh-session-manager) v0.4.11 | Compiled-only (`lib/`, 139 KB, no source); README says move keeps the live agent and "updates the in-memory session header", contradicting DSH's immutable-header/lease model. Unauditable — **reject**. |

Nothing does "rehome a workspace" (bulk + create destination + notice).

## 3. Plan: `dsh-workspace-rehome` (host-only plugin, this repo)

> **Superseded** by [`workspace-moving-ui.md`](workspace-moving-ui.md): the move
> became a first-class fork operation (`session.move` / `moveMany` on
> `feat/embed-session`) with sidebar dialogs, and **every move — including a
> cold, unblocked one — is confirmed through a modal** (Tali, 2026-09-17). The
> "no browser half needed" surface below is kept only as history; the
> per-session mechanics and notice wording still apply.

**Surface:** model-facing tools via `ctx.tools`: `workspace_rehome` (bulk) and
`session_move` (one-off). No browser half needed — the agent invoking it is by
definition a straggler in the old workspace. Sidebar action later if a
workspace-menu slot exists.

**Per-session move** (shape borrowed from dsh-session-workspace `src/migration.js`;
feature-detect the private seams, fail loud if absent):

1. `persistence.open(id,'write')` → `SessionAlreadyOwnedError` ⇒ live/resident
   straggler, skip and report. Otherwise the v3 artifact now exists.
2. Decode all zstd frames (multi-frame container — see
   `tools/repair-session-string-content.mjs` `decodeAll`), rewrite header `cwd`,
   **append the notice event**, validate every row through `createRestore`,
   re-encode (header as its own checksummed frame, then events).
3. Backup → tombstone-rename originals → hard-link publish under
   `sessions/<projectKey(new)>/<id>/` → `replaceHeaderIndex` →
   `old.detachSession` / `new.attachSession` → rollback on any failure.

**The notice:** an `agent/inbox/spliced` event, `target: 'next-step'`,
`inserted: [UserMessage]` with `source: {kind:'plugin', plugin:'dsh-workspace-rehome'}`
— byte-for-byte what `agent.inject()` writes — text wrapped in
`<system-reminder>`:

> NOTE: this session's workspace was changed from `deepseek-harness`
> (~/projects/deepseek-harness) to `tali-dash-plugins`
> (~/github/tali-dash-plugins); your current permissions of `Workspace Write`
> now grant access to this new directory.

The permission clause comes from the log's last `sandbox/mode` event:
`workspace-write` / `read-only` get it (mutatis mutandis), `danger-full-access`
omits it. Since the artifact is rewritten anyway, the note is validated by DSH's
own catalog before publication. Fallback if the resume-time inbox fold objects:
sidecar marker + `agent.inject` at resume (needs the plugin resident — not
preferred).

**Bulk `workspace_rehome(from, to, {title?, includeSubagents=true, dryRun, deleteEmptySource})`:**
`workspaceRegistry.create(to)` or reuse; enumerate `from.sessionIds` plus
same-cwd subagent children whose `parentSession` is in the set; move each cold
one; report stragglers by id + title; archive set untouched; optionally
`registry.delete(from)` if it ends empty.

**Verification before touching the live home** (AGENTS.md hot-reload warning):
copy `~/.dsh` to a throwaway `DSH_HOME`, run the preview server
(`PREVIEWING.md`), rehome there, resume a moved session and confirm sidebar
placement, sandbox root in the runtime-context snapshot, the note visible on
the first turn, projcache rebuild, no `session.lock` trouble. Then run for real
and write `recipes/workspace-rehome-plugin.md`.

**Alternatives kept for the record:**
- (B) install dsh-session-workspace as-is, add the workspace in the GUI,
  click-move 29 sessions — no note, fragile client, not recommended.
- (C) offline script with the server stopped — simpler mechanics, but kills the
  current session and loses lease/catalog validation; worth keeping as an
  `--offline` mode of the same core module.

## Reference paths

- Registry: `packages/workspace/workspace/src/{index,entity,spec,paths}.ts`
- Persistence: `packages/session/session-persistence-jsonl/src/{index,format}.ts`
- Header type: `packages/core/session/src/types.ts:93`
- Inbox fold / inject: `packages/core/agent-loop/src/{inbox,agent}.ts`
- Sandbox root: `packages/sandbox/sandbox-policy/src/index.ts:168`
- Reference implementation clone: `/tmp/dsh-3p/dsh-session-workspace` (re-clone
  `github:Unintendedz/dsh-session-workspace#v0.2.0` if gone)

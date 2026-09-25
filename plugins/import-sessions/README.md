# tali-import-sessions

`/import-claude` and `/import-pi` — bring **Claude Code** and **pi** coding-agent
transcripts from disk into DSH as real, resumable sessions, grouped into the DSH
workspace whose directory matches the transcript's working directory.

| Source | Store | Session id in DSH |
|---|---|---|
| Claude Code | `~/.claude/projects/<slug>/<uuid>.jsonl` (+ `<uuid>/subagents/agent-*.jsonl`) | `claude-<uuid>` (children `claude-<uuid>-agent-…`) |
| pi | `~/.pi/agent/sessions/--<path>--/<ts>_<uuid>.jsonl` | `pi-<uuid>` |

## What the user sees

Typing the bare command in the web GUI opens **one modal**:

1. **Pick** — one line per place the transcripts can be: *From
   `~/.pi/agent/sessions` on `<your device>` — Upload* (the standard chooser,
   which the Dock app pre-navigates to the store; the store or a workspace
   folder = bulk, one transcript = single; survivors are gzipped and uploaded in
   chunks), and, only when the page is a remote client of a server that has
   the store, *From `~/.pi/agent/sessions` on `<server>` — Choose* (the server
   reads its own store, no chooser).
2. **Decide** — a tree of workspaces → sessions (bulk) or a single-session
   card. Every workspace row / the card has an **Import to** selector:
   the DSH workspace whose path equals the transcript's `cwd` (or a new one
   titled by the directory's basename), any existing workspace, or Ungrouped.
   Sessions already in DSH, and duplicates within the selection, are shown but
   not selectable. When a *selected* session is **large** (estimated
   model-visible surface > `largeTokens`, default 100K), a *Large sessions*
   section offers **Working session** (fold turns before the last `keepTurns`
   behind a checkpoint note; cap tool results at `resultCap` chars) or
   **Archive** (everything as-is — reads and searches, but cannot be prompted).
3. **Import** runs with progress, then a per-session summary (turns, tool
   calls, images, truncations, folded turns, child sessions, token estimate).

Without a GUI: `/import-claude <path>` (transcript, workspace folder or store)
imports headlessly in archive mode; the bare command lists the store.

## Fidelity

- Claude Code writes one record per content block; runs sharing a `message.id`
  are regrouped into one assistant message / one DSH step, so tool results pair
  with their calls (4,056 pairs, zero orphans on the largest local transcript).
  `[Request interrupted]` closes the turn as interrupted; injected context
  (`<system-reminder>`, hook outputs, task notifications, attachments, mode /
  queue bookkeeping) is dropped and counted; `aiTitle` becomes the title.
  Subagent transcripts become child sessions (`parentSession`, `origin:
  'subagent'`) so the subagent tree renders.
- pi logs are trees (edits/regenerations branch); the **main branch** — root to
  the latest leaf — is imported and the abandoned records counted. pi's own
  `compaction` records become DSH compaction brackets whose summary replaces
  the surface before them; `session_info.name` is the title.
- Images (user, tool results) go through DSH's attachment service and render as
  real images. Usage is carried per assistant message.
- Everything is written through DSH's own services — `sessionPersistence`
  (format v3), `attachments`, `sessionProjectionCache` (title in the sidebar
  before first open), `workspaceRegistry.attachSession` — so nothing touches
  the log files directly and no restart is needed.

## Config (`cordis.patch.yml`)

| key | default | meaning |
|---|---|---|
| `claudeRoot` / `piRoot` | `~/.claude/projects` / `~/.pi/agent/sessions` | server-side stores |
| `largeTokens` | 100000 | estimated surface tokens above which a session is "large" |
| `keepTurns` / `resultCap` | 20 / 4096 | working-session defaults offered in the dialog |
| `archiveResultCap` | 0 | archive mode's per-tool-result cap (0 = unlimited) |

Uploads live under `$DSH_HOME/import-sessions/uploads/<id>/` while a dialog is
open and are deleted after the import (or swept after a day).

## Layout

`index.js` host (commands + control channel, see `PROTOCOL.md`) ·
`host/events.mjs` DSH event builder + invariant checker · `host/claude-reader.mjs`,
`host/pi-reader.mjs` · `host/sources.mjs` store discovery + scan ·
`host/uploads.mjs` · `host/picker.mjs` · `host/importer.mjs` · `src/client/` the
modal. `pnpm check` runs the tests; `pnpm build` the browser bundle.

The server-side native chooser (`host/picker.mjs`, `pick` endpoint) is kept
for the headless/API path but no longer surfaced in the dialog.

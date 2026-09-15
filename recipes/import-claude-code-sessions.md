# Importing Supacode / Claude Code transcripts into DSH

How to find coding-agent transcripts that were written under **Supacode**, and
turn them into real, resumable DSH sessions attached to a workspace.

Worked example: the Supacode-era nLab→Dash docset work in
`~/github/ncatlab-dash` (session `4d6f2b87-e481-4140-a28b-0b3f4bff3a4b`,
2026-08-06 → 2026-08-25, 157 MB).

## First: Supacode stores no transcripts

Supacode is a worktree/tab manager that **hosts agent CLIs and delegates
persistence to them**. Confirmed on this machine:

- `~/.supacode/` holds only `layouts.json`, `settings.json`, `sidebar.json`
  (tab titles, per-pane agent busy state, per-surface UUIDs) and `repos/`
  (git worktrees it manages).
- `~/Library/Application Support/app.supabit.supacode/` holds PostHog telemetry
  only. Its `layouts.json` tab titles are the *only* session-ish names it keeps
  (e.g. `✳ Set up SvelteKit graph visualization component`), and only while the
  tab exists.

So "Supacode transcripts" means **the transcripts of whichever agent ran inside
a Supacode surface**. Provenance is visible in the transcript itself: the Claude
records carry `SUPACODE_SOCKET_PATH` / `SUPACODE_SURFACE_ID` in their hook
payloads (the `pi-supacode` extension and Supacode's built-in Claude/Codex
integrations report lifecycle over a Unix socket).

## Where the transcripts actually are

| Agent | Location | Notes |
|---|---|---|
| Claude Code | `~/.claude/projects/<slug-of-cwd>/<sessionId>.jsonl` | one JSONL per session; slug is the cwd with `/`→`-` |
| Claude subagents | `…/<sessionId>/subagents/agent-*.jsonl` | one per Task call |
| Claude memory | `…/<sessionId or project>/memory/*.md` | project memory notes |
| pi | `~/.pi/agent/sessions/--<path>--/` | DSH's `dsh-import-agents` plugin covers this |
| codex | `~/.codex/sessions/` | same plugin |
| opencode | `~/.local/share/opencode/opencode.db` | same plugin |

Find them:

```sh
ls ~/.claude/projects | grep -i <repo>          # which projects exist
ls -la ~/.claude/projects/-Users-tali-github-ncatlab-dash/
grep -o '"aiTitle":"[^"]*"' <session>.jsonl | sort -u   # Claude's own title
```

**Session names.** Claude Code writes an `ai-title` record (hundreds of times,
one per connection) whose `aiTitle` is the session's real name — for the ncatlab
session, `Build nLab Dash docset recipe`. There is no `/rename`-style `summary`
record, and Supacode's tab title was the default `~/github/ncatlab-dash`, so
without `aiTitle` a session has no name of its own.

## The DSH artifact you must produce

```
~/.dsh/sessions/<projectKey>/<sessionId>/session.jsonl.zstd
```

- `projectKey` = `--` + path with separators collapsed to `-` + `--`
  (`/Users/tali/github/ncatlab-dash` → `--Users-tali-github-ncatlab-dash--`).
  Use DSH's own `projectKey`/`logPath` from
  `packages/session/session-persistence-jsonl/src/format.ts` rather than
  re-deriving it.
- **It is a concatenated-Zstandard-frame container, NOT one frame.** The first
  frame must decode to *exactly* the header line; every later frame carries a
  batch of events (`compressZstdFrame` per header and per append batch). The
  reader enforces this in `assertZstdHeaderFrame`
  (`packages/session/session-persistence-jsonl/src/index.ts`), and violating it
  fails **the whole plugin tree**: the loader cannot mount
  `@deepseek-ai/dsh-workspace`, so `dsh web` dies at startup with
  `corrupt Zstandard session log: first frame is not exactly one header line`.
- Event types must be in `packages/core/session/src/known-event-types.ts` (or
  carry `ignorable: true`), or the read path refuses to reconstruct the session.
- The relational rules in `packages/core/session/src/invariant.ts` must hold:
  turns number from 1 without nesting; `assistant/message`, `tool/call`,
  `tool/result` and `assistant/chunk` require an **open step** matching their
  `turn`/`step`; `step/end` clears pending calls; a `tool/result` with
  `surfaceOp: 'append'` requires a prior `tool/call` for the same `callId` in
  the same step; `seq` is contiguous from 0.

## The converter

`~/github/tali-dash-plugins/tools/import-claude-session.mjs` (Node ≥ 22.18; it
imports DSH's `format.ts` directly and relies on Node's TS type stripping).

```sh
node ~/github/tali-dash-plugins/tools/import-claude-session.mjs \
  --source ~/.claude/projects/-Users-tali-github-ncatlab-dash/4d6f2b87-e481-4140-a28b-0b3f4bff3a4b.jsonl \
  --cwd /Users/tali/github/ncatlab-dash \
  --id claude-4d6f2b87-e481-4140-a28b-0b3f4bff3a4b \
  --title "nLab → Dash docset recipe (ncatlab-dash)"

# add --dry-run to see the stats table without writing
```

Mapping (Claude → DSH):

| Claude | DSH |
|---|---|
| user prompt record | `turn/start` + `user/message` |
| assistant message | `step/start` + `assistant/message` (+ real `usage`) |
| `thinking` block | `{type:'reasoning'}` |
| `text` block | `{type:'text'}` |
| `tool_use` block | `{type:'tool-call'}` block **and** a `tool/call` event |
| `tool_result` block | `tool/result`, paired by `callId` inside the step |
| `[Request interrupted by user]` | `turn/end {kind:'interrupted'}` (not a new turn) |
| `aiTitle` | `session/title` at the end of the log |

Deliberate, counted losses: images become text placeholders (DSH's `ImageBlock`
references the attachment service, not inline base64); individual tool-result
bodies are capped (`--cap`, default 8192 chars); injected records are dropped
(`attachment`, `system`, `file-history-*`, `bridge-session`, `mode`,
`permission-mode`, `last-prompt`, `queue-operation`, `<task-notification>`,
`isMeta` reminders). The tool prints every count, then re-reads the file and
validates header frame, seq contiguity, and the turn/step/call relations.

### Traps that cost real time here

1. **Claude writes one record per content block, not per message.** A single
   model response is a run of `assistant` records sharing one `message.id`
   (thinking, then text, then one record per `tool_use`). Grouping by
   `message.id` is mandatory; treating each record as a message puts every
   `tool_use` in its own step and orphans its result (2,455 orphan results in
   the first attempt). The ncatlab transcript had 12,209 user/assistant records
   and only 3,888 distinct message ids.
2. **Never deduplicate on `message.id`** — it is shared by a response's records
   (3,661 legitimate records were dropped that way). `uuid` is unique per
   record.
3. **`scanLog` does not validate framing.** It parses plaintext, so a
   single-frame artifact passes every content check and still kills DSH at
   boot. Validate the first frame explicitly — `node:zlib`'s `zstdDecompress`
   stops after one frame, which is exactly the check:

   ```js
   const first = await promisify(zstdDecompress)(await readFile(logFile))
   if (first.toString('utf8') !== headerLine) throw new Error('bad header frame')
   ```
4. **`src/zstd.ts` cannot be imported** from a script: it uses a TypeScript
   parameter property, which Node's strip-only mode rejects
   (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). Use the `node:zlib` check above.
5. **The `pi-*` sessions in `~/.dsh/sessions/` have no `step/start`.** They were
   imported before the step relation was enforced; copy their *shape* for
   message/id/surface fields, but emit steps properly or the invariant fails.

## The imported session cannot be prompted (and compaction cannot fix it)

An imported transcript is replayed as **live, model-visible history**: every
prompt re-sends the whole surface. A long import therefore exceeds the model
window and every request fails, including the request that would compact it.

Measured on the ncatlab import (240 turns, 4,056 tool calls):

| | |
|---|---|
| Surface | 8,633 nodes (4,333 assistant, 4,062 tool results, 244 prompts) |
| DSH token meter | **1,264,195** tokens vs a 1,000,000 window |
| DeepSeek tokenizer | 1,943,276 |
| Anthropic tokenizer | 2,475,743 |

The log then shows the deadlock exactly: the tool-result pruner *does* run (six
`compaction/prune` records, 12,492 tokens — **1%** of the surface) and stops,
because it only trims results whose text exceeds `thresholdChars: 8192` and the
importer had already capped results at exactly 8192 chars (only 6 results reach
8,280 chars; the median is 152). Compaction then falls through to the LLM
summarizer, whose request carries the same oversized history, so `compaction/end`
records the provider's error and the turn fails with `CONTEXT_WINDOW_EXCEEDED`.

Where the weight is: tool-call **arguments** 3.38 MB, tool results 2.69 MB,
reasoning ~1.32 MB, text 0.58 MB. No pruner touches tool-call arguments, so even
perfect result pruning leaves >1.5M tokens: **tuning compaction cannot make such
a session promptable.**

### Fix: hide the old history from the model, keep it in the log

`~/github/tali-dash-plugins/tools/shrink-session-surface.mjs` applies
compaction's own surface-replace mechanism with no model call:

```sh
# run with the server STOPPED (the running server owns a live session's cursor,
# and appending behind its back makes the log and its state diverge)
node ~/github/tali-dash-plugins/tools/shrink-session-surface.mjs \
  --session claude-4d6f2b87-e481-4140-a28b-0b3f4bff3a4b --keep-turns 20
```

It appends four events in one new zstd frame — `compaction/start` (a standalone
bracket: it requires no open turn) → `compaction/prune` → the replacement
`user/message` carrying `surfaceOp: {op:'replace', start, end}` →
`compaction/end` — and backs the log up to `session.jsonl.zstd.preshrink.bak`
first.

Two contracts make this safe, and both are enforced:

- **Shadow-price adjacency.** The token meter folds a replacement only against a
  claim armed by the *immediately preceding* `compaction/prune`
  (`packages/llm/token-meter/src/surface-projection.ts`), and throws when the
  ranges disagree. Emit the claim and the replacement back to back, with
  `shadowedRange` equal to the replacement's `surfaceOp` range.
- **Span completeness.** `validateShadowedSeqs` requires `shadowedSeqs` to list
  *every* current surface node in the span, in surface order — so reconstruct
  the effective surface first, applying every earlier `surfaceOp` (the pruner's
  own replacements included) before choosing the cut.

`shadowedTokenCount` must come from DSH's fixed estimator
(`packages/llm/token-meter/src/estimate.ts`, `estimateMessage`) rather than a
guess. With it, the tool's computed `surface before` matched the server's own
`contextPressure.surfaceTokens` (1,264,195) exactly — the cheapest way to
confirm the surface reconstruction is right.

Result on ncatlab: surface 1,264,195 → **44,638** tokens (368 nodes), context
meter 0%, and a real prompt answered in 12s. The older transcript stays in the
log — still reachable via "Load earlier", the session-log view, and rewind.

Undo or re-tune (server stopped):

```sh
cp session.jsonl.zstd.preshrink.bak session.jsonl.zstd   # then re-run with --keep-turns N
```

The tool is idempotent: a second run reports nothing to shrink and exits 0.

### Guidance for future imports

Decide up front whether the import is an **archive** or a **working session** —
they are different artifacts. For a working session keep the surface small:
import only the last N turns, cap tool-result bodies well *below* the pruner's
8192 threshold (a cap equal to it silently disables the only model-free rescue),
or drop tool results and reasoning from the surface entirely. An archive may be
as large as it likes: it reads, searches and renders — it just cannot be
prompted.

## Alternative: the installed `dsh-import-agents` plugin

`~/.dsh/profiles/web/node_modules/dsh-import-agents` (third-party; README +
source in that directory) already imports **pi, opencode, codex and
claude-code**, offers a **Sync** button in the composer and `/import-all`,
writes stable ids (`claude-<id>`), and `/attach-workspaces` retro-attaches
imported sessions to a workspace matching their original `cwd`, creating it on
demand with title `basename (~/short/path)`.

Its Claude reader (`lib/claude-reader.mjs`) is deliberately lossy: `tool_use`
becomes a **text marker** and `tool_result` becomes truncated text, so an
imported Claude session has no real `tool/call` / `tool/result` trajectory.
That is why the converter above exists for Claude sessions: it preserves 4,056
paired tool calls with full arguments. Both produce the same session id, and the
plugin is idempotent ("re-imports skip what already exists"), so **whichever
writes first wins** — delete the artifact before switching paths.

## Registering the workspace (do not hand-edit the storage)

- The live registry lives in `~/.dsh/storages/workspace.json` and is **owned by
  the running server**; it keeps the document in memory and rewrites it from
  that state. A hand edit is invisible until a restart and can be clobbered.
- The registry bootstraps from persisted session headers **only while
  `global.initialized` is false**, and then never re-bootstraps — so a session
  imported into an already-initialized home stays "Ungrouped".
- Membership is cwd-exact: a session joins a workspace only when the session
  header's `cwd` equals the workspace path.
- Create/attach through a client: the GUI's **Add workspace** button, or the
  plugin's `/attach-workspaces`.

### Attaching an already-imported session

Creating the workspace is enough for *new* sessions, but an imported one stays
under "Ungrouped", because **nothing attaches an existing session**:
`workspace.attachSession` is called only by the session controller's create and
fork paths, and the workspace controller exposes just `create`, `rename`,
`delete`, `insertBefore`, `insertSessionBefore`, `archiveSession` and a list
stream (`insertSessionBefore` requires the session to be accounted already).
Membership needs both halves to line up: the id in the workspace record's
`sessionIds` **and** the session header's canonical `cwd` equal to the
workspace path.

Three routes, in order of intrusiveness:

1. **Do nothing.** The session is usable, searchable and openable; it is simply
   not grouped.
2. **`/attach-workspaces`** (the installed plugin's command, typed in any
   session's composer). Supported, but global: it walks every `pi-`/`oc-`/
   `codex-`/`claude-` session, creates a workspace per distinct cwd, and
   normalizes every workspace whose title is still its basename to
   `name (~/path)`. On a home with imported pi sessions that means new
   workspaces for those folders plus a rename of every default-named workspace.
3. **Edit the registry, then restart the server.** Precise and sidebar-neutral.
   Use `~/github/tali-dash-plugins/tools/attach-session-to-workspace.py`:

   ```sh
   python3 ~/github/tali-dash-plugins/tools/attach-session-to-workspace.py \
     --session claude-4d6f2b87-e481-4140-a28b-0b3f4bff3a4b --workspace ncatlab
   ```

   It backs the document up, refuses an edit the registry would reject at
   startup (duplicate session account, duplicate path, order drift), and writes
   atomically. **The running server owns this file** and rewrites it from
   in-memory state on any workspace mutation — including every session
   creation, which attaches — so run it with the server stopped, or run it and
   restart promptly (and re-run if it was clobbered; the helper is idempotent).
   The restart is of the **`dsh web` server**, not the app window: the registry
   loads at startup. The browser cookie survives the restart because the
   signing secret is persisted by the credentials store.

### Hazard found on this machine

The `dsh web` on **:3081** was started **without `DSH_HOME`**, so it shares the
live `~/.dsh` while holding a registry snapshot from its start time (Sep 5) —
older than later live writes. Creating a workspace from that instance would
rewrite `workspace.json` from stale memory and drop newer workspaces. Before
trusting a preview instance, confirm its isolation: a genuinely isolated home
has a populated `$DSH_HOME/profiles/<profile>/node_modules` and an empty-ish
`sessions/`; the throwaway `/tmp/tali-dash-plugins-home` had an **empty**
`profiles/web/`, proving the 3081 process was using the live home.

The live server's launch token is minted per process at boot and printed only to
its terminal, so an already-running GUI cannot be authenticated to from a
script — recreate state through the GUI, or run an isolated instance:

```sh
cd ~/github/deepseek-harness
DSH_HOME=/tmp/verify-home DSH_AGENTS_HOME=/tmp/verify-home/agents \
  pnpm dsh web --port 3099 --no-open     # prints the tokened URL on stdout
```

`DSH_AGENTS_HOME` matters: `dsh-import-agents` writes its skills to
`$DSH_AGENTS_HOME/skills`, defaulting to `~/.agents/skills` — a live path even
when `DSH_HOME` is isolated.

## Verification recipe (what "it works" means)

1. `node import-claude-session.mjs … --dry-run` — counts, no writes.
2. Real run — prints `validated: N events, header + seq contiguity + turn/step/call relations OK`.
3. Boot a real server against the artifact (isolated home above). A framing
   mistake fails here, loudly, at plugin load.
4. Open the session in the GUI: the title must be the one you set, tool rows
   must render as real tool cards, and the footer must show the expected
   `N turns · M steps`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `dsh web` dies: `corrupt Zstandard session log: first frame is not exactly one header line` | artifact written as one zstd frame | header must be its own frame; events in later frames |
| `corrupt session log: seq gap in committed region` | gaps or duplicate seqs | emit `seq` contiguously from 0 |
| `tool/result for X with no prior tool/call in this step` | assistant per-block records not grouped, or results landing outside the step | group by `message.id`; open the step before its calls |
| `assistant/message names turn T/step S but open is …` | missing `step/start`/`step/end` | emit steps per assistant message |
| Session shows as "Ungrouped" | registry already initialized, or cwd mismatch | create the workspace via GUI/plugin; check the header's `cwd` equals the workspace path |
| GUI returns `dsh web authentication required` | launch token is per process | use a fresh instance's printed URL, or act in the existing GUI |
| Plugin says nothing to import | its id already exists | it is idempotent; remove the artifact to re-import |
| Every prompt fails with `prompt is too long` / `CONTEXT_WINDOW_EXCEEDED`, and `/compact` fails with the same error | the import's whole surface is re-sent and exceeds the model window; the pruner cannot trim results already at its threshold, and the summarizer needs the same oversized request | run `shrink-session-surface.mjs --keep-turns N` with the server stopped (see above) |
| Context meter shows a plausible number but a lower one than the provider reports | the meter's fixed estimator prices ~4 chars/token; JSON-heavy tool-call text tokenizes nearer 3 | treat the meter as a pressure signal, not a budget: leave real headroom (~2x) on imports |

## Related

- `~/github/tali-dash-plugins/AGENTS.md` — plugin conventions and the
  live-`~/.dsh` hazard rules (this import touches session storage, not plugin
  config, so no hot-reload risk).
- `~/.dsh/profiles/web/node_modules/dsh-import-agents/README.md` — the
  supported importer's exact behavior.
- `preview-identity.md` — the preview server's own recipe.

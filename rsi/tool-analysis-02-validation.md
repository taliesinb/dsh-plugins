# Tool analysis 02 — validating 01 against the whole corpus

Status: **validation of `tool-analysis-01.md`, nothing built**. Written
2026-09-16 with the `transcript_*` tools over **every readable session on the
machine** (56 of 67; 11 refused by the reader — 3 damaged v0 logs, 7 imported
Pi sessions, 1 imported Claude session). 01 looked at 4 sessions / 611 bash
calls; this pass covers **41 sessions with bash activity / 3,076 bash calls**
and every `edit`/`write`/`read`/`grep`/`glob` call (1,000). Scratch data
(exports + classifier) is in the analysing session's cwd,
`~/projects/deepseek-harness/rsi-validate/` (`classify.py`, `all.json`).

## 1. Headline: every quantitative finding in 01 holds corpus-wide

| 01 claim (4 sessions) | corpus (41 sessions) | verdict |
|---|---|---|
| bash is 55–85 % of calls | 3,076 / 5,331 = **58 %** | holds |
| `cd X && …` prefix 82 % | **59 %** (1,825); `workdir` used 7 % (213, of which 132 in one session) | holds, weaker |
| python heredoc edits 91 (15 %) | **555 (18 %)**, + 154 `cat > f <<EOF` + 78 `sed -i` = **787 bash-side mutations** | holds, stronger |
| — | native `edit` 254 + `write` 259 = 513 → bash mutates files **1.5× more** than the tools built for it | new |
| `sed -n 'X,Yp'` reads 151 | **485** (vs 369 native `read`) | holds |
| `grep -rn` searches 171 | **918** (vs 113 native `grep`) → **8:1** | holds, stronger |
| `ls` 119 (no dir tool) | **511** (+57 `tree`/`find -maxdepth`); `glob` used **once** in 56 sessions | holds |
| build/test with `2>&1 \| grep \| head` 107 | **693**, of which **91 %** post-filter output | holds |
| readiness polls 21 + blind `sleep` 13 | **45 curl loops + 46 leading `sleep N`** (103 sleeps total; mode 3 s) | holds |
| `edit` read-guard errors "2×+2×" | **`edit` error rate 19 %** (48/254): 24 `FS_NOT_OBSERVED`, 12 `FS_STALE_VERSION`, 3 "not been read", 8 sandbox | holds, stronger |
| longest commands are python edits (15.4 KB) | max **19.1 KB**; top-8 are all `py_edit`; p90 2.1 KB | holds |

`edit` is the **least reliable tool in the corpus** by error rate among tools
with >100 calls (19 %; next is `write` at 6 %, `bash` at 0.2 %).

## 2. Corrections to 01

### 2.1 The "sandbox asymmetry taught the habit" story (01 §3.1 item 3) is wrong

01 said bash `python3` writes to `~/github/*` were *not* blocked while `write`
was. The corpus says otherwise:

- bash **is** fenced at the OS level. Bash results carry
  `Operation not permitted … [sandbox: file access denied under workspace-write mode]`
  (`create-repo` seq 34 `git config`, `mcp-safari-chrome` 215 `.git/index.lock`,
  `content-some-bug` 388 `cp`).
- In `hybrid-local-remote` the sequence is: `write` denied (131) → user runs
  `/permission danger-full-access` (134) → `write` succeeds (150). **No**
  bash-side write to `~/github` happened before 134.
- Correlating every bash mutation with the sandbox mode in force at that seq
  (from the runtime-context injections): **of 787 bash mutations, 676 ran under
  `danger-full-access`**. The 111 under `workspace-write` are almost all
  tensatory sessions editing their *own* workspace.

The real cause is upstream of the tools: **the user switches to
`danger-full-access` in 23 of the 28 sessions that have a policy timeline**,
usually within the first ~150 events, because the `deepseek-harness`
workspace is code-free (`~/projects/deepseek-harness`) and all real work is in
`~/github/*`, so every write needs an approval. Once in full-access, `edit`
would work fine — and agents still route around it (see §3).

Side finding: after the mode switch, agents retry the denied call *with*
`sandbox_permissions` (as the denial message told them to) and get
`sandbox escalation to "danger-full-access" is not strictly wider than …` —
6 wasted errors corpus-wide (3 `write`, 3 `bash`). The denial hint is stale by
the time it is acted on.

### 2.2 The `cd` prefix is not (mainly) about a wrong cwd

01 explained the 82 % `cd` prefix by "cwd was `~/projects/deepseek-harness`
but the work was in `~/github/…`". True for those sessions, but
`tensatory/initial-review` has cwd **`~/github/tensatory`** and still begins
**471 of 485** bash calls with `cd ~/github/tensatory &&`. The agent does not
trust the cwd (the result never echoes it), full stop.

## 3. Why python heredocs, when `edit` would work?

From the 555 `py_edit` calls:

| property | count |
|---|---|
| ≥ 2 replacements in one call | 374 (67 %) |
| ≥ 2 files in one call | 200 (36 %) |
| defines a `def rep(old,new)` helper | 105 |
| re-implements `edit`'s uniqueness guard by hand (`assert s.count(old)==1`) | **319 (57 %)** |
| chains a build/test (`pnpm typecheck`, `vitest`, …) **in the same call** | **304 (55 %)** |
| chains `git` in the same call | 93 |
| single replacement, single file — `edit` could have done it directly | 164 (30 %) |

So the driver is **round-trips**: edit-many-files-then-typecheck in one
call, with the agent's own assertion standing in for the guard it knows
`edit` has. The read-guard is the second driver: agents "read" with
`sed -n`/`grep -A` in bash (485 + 918 calls), which the observation policy
cannot see, so a following `edit` fails `FS_NOT_OBSERVED`; and a bash-side
mutation after a `read` makes the next `edit` fail `FS_STALE_VERSION`
(mixed-mode trap — `mcp-safari-chrome` 456–472: two edits fail, `read`, the
same two edits succeed). After an `edit` failure the next call was `read`
25×, `edit` again 16×, **`bash` 7×** (giving up on the tool).

Note that several successive `edit` calls to the same file in one step **do**
work (469 → 471 above) — the "one replacement per call" limit is only a
round-trip cost, not a correctness one.

## 4. Other shape facts (corpus)

- **grep features used in bash that the `grep` tool lacks**: context
  `-A/-B/-C` **207**, `-l` files-only **137**, `--include` **106**, `-c` 37,
  `-o` 36; `| grep -v` exclusion **147**; **471 calls run 2+ greps**, 580 use
  `\|` alternation (the tool's regex handles that — it is a habit, not a gap).
  Corpus: the `grep` tool was also abandoned for bash 4× after `rg` errors
  (a missing path, a literal not allowed in a regex).
- **`sed -n` ranges**: median 38 lines, p90 80; 98 calls have 2+ ranges,
  225 also grep and 53 also `ls` in the same call — one bash call replaces
  3–4 tool calls.
- **`ls`**: 181 of 511 calls are `ls`-dominated (nothing else in the call);
  the rest are exploration bundles.
- **build/test**: `npx vitest` 86, `pnpm typecheck` 76, `pnpm run check` 73,
  `make` 65, `tsc` 61, `pnpm dsh` 55; 582 use `2>&1`, 628 pipe to
  `grep`/`head`/`tail`.
- **`| head`** on 1,497 calls (49 %), `| tail` 399.
- `python3 -`/`node -e` for non-edit purposes: 237 + 108 (json munging,
  session-log decoding — 320 calls touch `~/.dsh`, now `transcript_*`).
- `osascript` 55, `open` 34, `tailscale` 192, `ssh` 32 — idiomatic, no tool
  needed.

## 5. Feasibility (checked against `<dsh-src>`)

Everything below is buildable **out-of-tree** (AGENTS.md ground rule):

- `ctx.fs` (`packages/fs/fs/src/index.ts`) already exposes `listDir`,
  `readText`, `stat`, `editText`, `writeText`. A plugin registering
  `list_dir` / `read_many` / `edit_many` over `ctx.fs` gets the sandbox for
  free and can participate in the read-guard by emitting `fs/observed` after
  reads and running `ctx.waterfall('fs/edit-intent', …)` before edits —
  exactly what `tool-fs` does (`packages/fs/tool-fs/src/{read,edit}.ts`).
- The observation policy (`fs-observation-policy`) is an event gate keyed on
  `fs/observed`; it cannot see bash output, and there is no honest way to
  make `sed -n` count as an observation (no version to record). A batch
  `read_many` that *is* observed is the fix, not a bash hook.
- `grep`/`glob` spawn the packaged ripgrep via `ctx.subprocess`; a richer
  grep is the same spawn with more flags.
- `bash` results come from `ctx.shell`; result rewriting on the
  `tools/execute` waterfall (`docs/tool-execution-pipeline.md`) can append
  the effective cwd without touching the tool.
- Readiness waiting: `ctx.jobs` exists; a `wait_for_http` tool is a plain
  tool with a fetch loop.

## 6. Re-ranked proposals

Ordering by (calls removed) × (round-trips saved) × (error class removed):

1. **`edit_many` + `read_many` in one plugin (`fs-batch`)** — removes the
   555 python heredocs (largest, riskiest commands), the 485 `sed -n`, and
   the 39 read-guard errors at once: `read_many([{path, offset, limit}])`
   emits `fs/observed` so a following `edit_many([{file_path, old, new}])`
   (all-or-nothing, uniqueness-checked like `edit`) is authorised. Optional
   `then: {command}` to run a check in the same call would absorb the 304
   edit+typecheck bundles — or leave that to bash `workdir`.
2. **`list_dir(paths[], depth, sizes?)`** — 511 `ls` + 57 `tree`; `glob` was
   used once in 56 sessions, so "files only" is a real hole.
3. **Richer `grep`**: `context`, `mode: files|count|lines`, `include[]`,
   `exclude` pattern, `paths[]` — the 207 + 137 + 106 + 147 feature uses.
4. **Echo the effective cwd (and exit code) in every bash result**, and a
   sticky per-session default `workdir` — 1,825 `cd` prefixes, incl. 471 in
   a session whose cwd was already right.
5. **`bash` output shaping** (`max_lines`, `grep`/`tail` options) — 1,497
   `| head`, 399 `| tail`, 628 filtered build outputs. Cheap; a
   `run_checks` runner is a special case and can wait.
6. **`wait_for_http(url, status, timeout)`** — 45 loops + 46 blind sleeps.
7. **Fix the stale escalation hint**: when the mode has already widened, the
   `not strictly wider` error should say "already in X; retry without
   `sandbox_permissions`" (6 errors, trivial).
8. **`dsh_dev_instance`** — 90 `dsh_launch` calls; real but DSH-specific and
   the preview recipe already documents the steps. Later.

Dropped from 01: "make bash writes obey the same roots" — they already do
(§2.1). The workspace-layout question (code-free cwd forcing
`danger-full-access` in 23/28 sessions) is a **user-side** fix worth raising:
a session whose cwd is the repo being edited keeps `workspace-write` viable.

## 7. Method

`transcript_find` (67 sessions) → `transcript_tool_stats sessions:["*"]` →
`transcript_grep sessions:["*"] kinds:["call"] tools:["bash"] pattern:"[\s\S]"
context_chars:20000 fmt:jsonl out_file:…` to export every bash call's args
(3,080 rows) and the same for `edit/write/read/grep/glob` → `classify.py`
(regex per category, one tag set per call) → `transcript_grep` over
`kinds:["inject"]` for `Current DSH file policy: …` to rebuild each session's
sandbox-mode timeline and join it to the bash mutations by seq →
`transcript_read --errors_only` / `seq_from..seq_to` spot checks of the
causal claims (`hybrid-local-remote` 128–152, `mcp-safari-chrome` 440–476,
`sync-button` 95–125).

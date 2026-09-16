# Tool analysis 01 — what agents do in `bash` that should be a tool

Status: **findings + proposals, nothing built**. Written 2026-09-16 from the
`transcript_*` introspection tools (plugin `session-introspect`), examining the
four DSH sessions that were live in workspace `deepseek-harness` at the time.
Scratch data (raw jsonl exports and a parsed `all.json` of every bash call)
was left in the analysing session's cwd, `~/projects/laptop/.transcript-analysis/`.

## 1. Sessions examined

| session | title | tool calls | errors | notes |
|---|---|---|---|---|
| `session-fb3f57a6` | introspection-tools | 155 | 2 | bash 131, write 16, edit 5 — built the `transcript_*` tools |
| `session-6651162e` | hybrid-local-remote | 432 | 4 | bash 262 + 18 distinct `chrome_*` tools + background jobs; **0 `edit` calls** |
| `session-7420babc` | tailscale-remote-plugin | 215 | 0 | bash 149, read 14, write 10, moderate Chrome verification |
| `session-cec83493` | web-automation-errors | 120 | 3 | bash 66, edit 33 (3 ✗), read 19 — pure code editing |

Across the four: `bash` is 55–85 % of all calls. The only recurring error
classes were `write` → `FS_SANDBOX_DENIED` outside the workspace, and the
`edit` read-guard (`edit requires reading … first`, `file changed since it was
read`), each followed by a `read` round-trip.

## 2. What the 611 bash commands actually do

Programs were tallied once per call, per pipeline segment. Rows overlap
(one call often does several things).

| pattern | calls | existing tool it bypasses |
|---|---|---|
| `cd <dir> && …` prefix | **503 (82 %)** | `workdir` param (used 19×) |
| `grep -rn` / `grep -n` source search | 171 (+206 more as `\| grep` output filters) | `grep` (used 1–2× per session) |
| `sed -n 'X,Yp' file` line-range reads | 151 | `read` with offset/limit |
| `ls …` | 119 | *none — `glob` never returns directories* |
| build/test (`pnpm`, `npx tsc`, `vitest`, `oxlint`) with `2>&1 \| grep -E "error\|failed" \| tail -N` | 107 | — |
| **`python3 - <<'EOF'` search-and-replace file edits** | **91** | `edit` |
| `git …` (status/log/commit -F heredoc/worktree) | 79 | — |
| `~/.dsh` inspection (`zstd -dc session.v3.jsonl.zstd \| python3 …`) | 48 | now: `transcript_*` |
| `for i in …; do sleep 3; curl -s -o /dev/null -w "%{http_code}" …; done` readiness polls | 21 (+13 commands starting with bare `sleep N`) | — |
| `cat > file <<'EOF'` file creation | 20 | `write` |
| `ssh alpha@… 'tailscale …'` | 20 | — |
| `\| head -N` / `\| tail -N` defensive output clipping | 360 / 84 | — |

Other shape facts: median command 300 chars, p90 1.7 KB, max **15.4 KB**;
144 multi-line commands, 125 heredocs, 24 background jobs, 12 non-zero exits.

Per-session breakdown (counts of calls matching each category):

| session | total | py-edit | cat> | sed -n | grep | ls | build/test | git | curl | ssh | .dsh |
|---|---|---|---|---|---|---|---|---|---|---|---|
| hybrid-local-remote | 265 | 46 | 7 | 69 | 105 | 47 | 48 | 21 | 21 | 20 | 1 |
| introspection-tools | 131 | 22 | 5 | 35 | 56 | 35 | 28 | 11 | 0 | 0 | 33 |
| tailscale-remote-plugin | 149 | 19 | 5 | 33 | 66 | 22 | 39 | 37 | 9 | 0 | 7 |
| web-automation-errors | 66 | 7 | 3 | 14 | 30 | 15 | 17 | 10 | 1 | 0 | 7 |

## 3. Findings

### 3.1 Agents route file edits through `python3` heredocs instead of `edit`

91 calls — 15 % of all bash — have the shape

```python
p='src/foo.ts'; s=open(p).read()
old="""…"""; new="""…"""
assert old in s, (p, old[:60])
open(p,'w').write(s.replace(old,new,1))
```

frequently with a `def sub(p, old, new)` helper applying 3–6 replacements across
several files in one call. These are the **longest commands in the corpus**
(15.4 KB, 15.3 KB, 12.0 KB, 11.1 KB, …). Three friction sources, all visible in
the transcripts:

1. **Observation policy mismatch.** `edit` requires a prior `read`, but the
   agents "read" files with `sed -n 120,260p` / `grep -n -A10` in bash, which
   does not count. Result: `edit requires reading "…" first` (2×) and `cannot
   edit "…": file changed since it was read` (2×, after a bash-side write to the
   same file). Every one was followed by `read` then retry.
2. **One replacement per call.** The python idiom batches many edits in many
   files; `edit` is one `old_string` in one file.
3. **Sandbox asymmetry taught the habit.** In hybrid-local-remote the first
   `write` to `~/github/tali-dash-plugins/…` was `FS_SANDBOX_DENIED` (workspace
   was `~/projects/deepseek-harness`), while bash `python3` writing the same
   path was not blocked. The user switched to `/permission danger-full-access`,
   `write` then worked — but the agent had learned "mutate files via bash" and
   made **zero `edit` calls in 432**, even for 20-char changes.

### 3.2 No directory listing tool

119 `ls` calls. The system prompt says `glob` returns files only, never
directories, so every exploration turn opens with
`ls apps packages 2>/dev/null; ls docs/user | head -80`.

### 3.3 `read` is single-file; agents batch with `sed -n`

151 `sed -n 'X,Yp'` reads, typically 2–4 ranges plus an `ls` and a `grep` in one
call, separated by `echo ---`. Common suffix: `| grep -v '^$'` to drop blank
lines and `| head -N`. The driver is round-trips: one bash call replaces four
`read` calls.

### 3.4 `grep` tool lacks what bash `grep` gets used for

Of the 171 search calls, the features used that the `grep` tool does not offer:
`-A/-B` context, `-l` (files only), `-c` and `| sort | uniq -c` (counts),
`-o` (extract matches), `--include=*.ts`, several roots per call, several
patterns per call.

### 3.5 Readiness polling is hand-rolled every time

21 loops of the exact shape
`for i in $(seq 1 10); do sleep 3; c=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3081/); [ "$c" = "401" ] && break; done; echo "local=$c"`
plus 13 commands beginning `sleep 2;` / `sleep 12;` immediately after a
background job launch. Total wall time spent in these: several minutes.

### 3.6 Build/test output is summarised by hand

107 build/test invocations, essentially all as
`pnpm vitest run … 2>&1 | grep -E "error|failed|✓ built" | head -5`,
`npx tsc -p … --noEmit 2>&1 | grep -v "npm warn" | head -3`,
`npx tsx scripts/run-oxlint.ts … 2>&1 | tail -1`. The agent is doing output
reduction the tool could do.

### 3.7 Throwaway DSH instances are assembled by hand

hybrid-local-remote stood up ~8 isolated servers, each as 4–6 calls:
`mkdir /tmp/dsh-local-home; cp ~/.dsh/settings.yaml ~/.dsh/.credentials.yaml …`
→ `cat > overlay.yml <<EOF` → background
`DSH_HOME=… node apps/cli/lib/bin.js --profile web --patch … --port 3081 --no-open`
→ curl poll until 401 → `curl -c jar "…/?token=…"` → JSON-RPC via `curl -b jar`.
introspection-tools did the same with `--profile headless --dump-config` and a
600 s `timeout`. Three more calls spliced YAML blocks into
`~/.dsh/profiles/web/cordis.patch.yml` with `node` + `js-yaml`.

### 3.8 `workdir` is not used

503/611 commands begin `cd ~/github/<repo> && …`. The sessions' cwd was
`~/projects/deepseek-harness` but the work happened in `~/github/deepseek-harness-embed`,
`~/github/tali-dash-plugins/plugins/*`, `~/.dsh/profiles/web`. Either the param is
not discoverable enough, or the agent does not trust that it was honoured (the
result never echoes the effective cwd).

### 3.9 Already covered

The 48 `~/.dsh/sessions/*/session.v3.jsonl.zstd | python3 …` calls are exactly
what `transcript_find/outline/read/grep/tool_stats` now do — the
introspection-tools session was building them. `git` (79) and `ssh` (20) are
used idiomatically and need no dedicated tool.

## 4. Proposals, ranked by payoff

1. **Batch `edit` / `patch` tool.** `edit` accepting
   `edits: [{file_path, old_string, new_string}]` in one call; treat a bash-side
   `sed -n`/`cat`/`head` of a file as observation for the read-guard (or offer
   an explicit `expected_hash`/`force` escape). Removes the 91 python heredocs
   and the largest commands outright. Separately: make bash-side writes obey
   the same roots as `write`/`edit` (AGENTS.md says they should; the transcript
   shows they did not for `~/github/*`), so the asymmetry cannot teach the habit.
2. **`list_dir(paths[], depth, max_entries)`** — directories included, sizes
   and mtimes optional. Kills the 119 `ls` calls.
3. **Batch `read`**: `[{path, offset, limit}]` per call, plus `collapse_blank`
   and `max_lines`. Kills most of the 151 `sed -n` calls.
4. **Richer `grep`**: `context`, `mode: lines|files|count|matches`, `paths[]`,
   `patterns[]`, `include` as a list. Kills most of the 171 search calls and
   many of the 206 `| grep` filters.
5. **`wait_for(url | port, expect_status, timeout)`** — or `job_output` with
   `until: {url, status}`. Kills the 21 poll loops and the 13 blind `sleep`s.
6. **`run_checks` / package-script runner** returning pass/fail + error lines
   only; more generally a `head`/`max_lines`/`filter` option on `bash` itself
   would absorb the 360 `| head` and 84 `| tail` post-filters.
7. **`dsh_dev_instance` (DSH-specific plugin tool)**: spin up an isolated DSH
   home + overlay patch on a port, wait for readiness, return
   `{url, token, jobId}`; companion `dsh_config show|patch` for the profile
   YAML. Collapses 4–6 calls per iteration into one and removes the risk noted
   in AGENTS.md of hot-reloading the live profile by accident.
8. **Sticky/default `workdir`** per session, and echo the effective cwd in every
   bash result, so the 503 `cd X &&` preambles disappear.

## 5. Method

`transcript_find --workspace deepseek-harness` → `transcript_tool_stats` per live
session → `transcript_read --tools bash --raw --fmt jsonl --out_file …` per
session → a python pass over `tool/call` events joined to `tool/result` by
`callId`, classifying by leading program per pipeline segment and by regex
over the command text. Reasoning and result rows were then spot-checked with
`transcript_grep` / `transcript_read --seq_from/--seq_to` to establish *why*
(e.g. the sandbox denial at hybrid-local-remote seq 131 → escalation 142 →
success 150).

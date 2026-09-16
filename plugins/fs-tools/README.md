# tali-fs-tools

Batch filesystem tools for DSH, registered **beside** the in-tree `read` /
`edit` / `grep` / `glob` under new names. They target the four bash habits the
transcript corpus showed agents falling into (see
[`rsi/tool-analysis-02-validation.md`](../../rsi/tool-analysis-02-validation.md)):

| habit (calls in 41 sessions) | tool |
|---|---|
| `python3 - <<'EOF' … s.replace(old, new) …` file edits (555) | `edit_many` |
| `sed -n 'X,Yp' a; echo ---; sed -n … b` range reads (485) | `read_many` |
| `ls` / `tree` / `find -maxdepth` (568; `glob` returns files only) | `list_dir` |
| `grep -rn -A3 --include=*.ts … \| grep -v …` (918) | `search` |

Everything goes through `ctx.fs`, so the session's sandbox mode and the
read-before-edit policy apply exactly as for the built-ins; `search` spawns
the packaged `@vscode/ripgrep` through `ctx.subprocess`.

## Tools

### `list_dir`

```
list_dir { paths?: string[], depth?: 1..6, max_entries?: int, sizes?: bool, all?: bool }
```

Directories included, `/`-suffixed, listed before files. Several roots per
call. Below the first level, `node_modules`, `.git`, `dist`, `lib`, `build`,
hidden directories etc. are shown as one row and not descended unless
`all:true`. A missing or non-directory root is reported inline; the other
roots still list. Stops at `max_entries` (default 300) with a note.

### `read_many`

```
read_many { files: (string | { path, offset?, limit? })[], collapse_blank?: bool, max_lines?: int }
```

Several files, or several ranges of one file, in one call. Each entry renders
like `read` (`<path>…</path>`, `N: text` rows, the range shown). **Every file
read emits `fs/observed`**, so a following `edit` / `edit_many` is authorised
without a separate `read` — this is the fix for the corpus's
`FS_NOT_OBSERVED` errors (agents "read" with `sed -n`, which the policy cannot
see). A missing file is observed absent and reported inline; a directory is
reported inline; the rest of the call still returns. `max_lines` (default
4000) is a total budget across entries.

### `edit_many`

```
edit_many { edits: { file_path, old_string, new_string, replace_all? }[], dry_run?: bool }
```

Several literal replacements across several files in one call, with the same
rules as `edit` (exactly one match unless `replace_all`). Two phases:

1. **validate** — every target resolved; every file passes the read-guard
   (`fs/edit-intent` → `FS_NOT_OBSERVED` if not read this session, exactly as
   `edit`); every `old_string` is found and unique **in the file as it will be
   after the earlier edits of the same call** (so edit #2 may match text
   produced by edit #1). All problems are collected and returned together,
   numbered `#k`; **nothing is written if any fails.**
2. **apply** — in order, through `ctx.fs.editText` with the version guard from
   the intent slot (compare-and-swap in the backend) and an `fs/observed` after
   each, so a bash-side write between read and edit fails `FS_STALE_VERSION`
   *before the first write*, and a following single `edit` needs no re-read.

A failure during apply (a concurrent writer) reports which edits were applied
and which were not. `dry_run` stops after validation. The result lists, per
file, the line of each replacement. UI: a diff card per edit (call and
result), like `edit`.

Sandbox denials render as the shared `[sandbox: file access denied under <mode>
mode]` marker. The tool carries **no** `sandbox_permissions`; for a one-off
escalation the built-in `edit`/`write` remain.

### `search`

```
search { pattern? , patterns?: string[], paths?: string[], include?: string[], exclude?: string[],
         exclude_pattern?: string, mode?: 'lines' | 'files' | 'count', context?: 0..20,
         case_insensitive?, literal?, no_ignore?, hidden?, max_results?: int }
```

ripgrep with the flags bash `grep` gets used for: context (`-C`), files only
(`-l`), per-file counts (`-c`), several roots, several patterns (OR),
include/exclude globs (gitignore semantics — a glob with `/` is anchored at the
root, use `**/dir/**`), a `| grep -v`-style `exclude_pattern` (JS regex over the
matched line, context rows re-trimmed), `-i`, `-F`, `--no-ignore`, `--hidden`.
Output is grouped by file, sorted by path (ripgrep's own order is
nondeterministic), `N:` for matches and `N-` for context rows, `--` between
non-contiguous chunks. Capped at `max_results` matches (lines) or files
(files/count) with a note. Every model value rides in `--flag=value` form or
behind `--`, so no value can become a flag.

## System-prompt hint

With `promptHint: true` (default) one short section after the built-in tool
guidance steers the model to these tools instead of `ls`/`sed -n`/python
heredocs/`grep`, and to bash `workdir` instead of `cd X &&` prefixes. Set
`promptHint: false` to measure unprompted adoption.

## Config

```yaml
config:
  readLimit: 2000          # max lines per read_many entry (and its default)
  readTotalLimit: 4000     # default total line budget of one read_many call
  readMaxLineLength: 2000  # characters kept per line
  listMaxEntries: 300      # default row cap of list_dir
  searchMaxResults: 250    # default cap of search
  searchTimeoutMs: 30000   # cooperative budget of one search
  promptHint: true
```

## Install / run

Dev overlay (already a row in `<plugins>/cordis.dev.yml`):

```sh
cd <dsh-src> && pnpm dsh web --patch <plugins>/cordis.dev.yml
```

Live web profile: an absolute-path row `tali-fs-tools` in
`~/.dsh/profiles/web/cordis.patch.yml` (mounted 2026-09-16). Installed-bundle
alternative: `dsh plugin --profile web add ./plugins/fs-tools` (its
`cordis.patch.yml` inserts the same row id).

## Tests

```sh
cd plugins/fs-tools && pnpm check     # node --test, 18 tests
```

The fake `ctx` (`tests/fake-ctx.mjs`) is a real filesystem under a temp root
with a version counter, the `FS_SANDBOX_DENIED` / `FS_STALE_VERSION` codes of
`dsh-fs-sandbox`/`dsh-fs-local`, and a mini observation policy wired to
`fs/edit-intent` + `fs/observed`, so the guard flow (unread → refused; read_many
→ allowed; bash write → stale; re-read → allowed) is covered without DSH.
`search` tests run the real packaged ripgrep.

Headless end-to-end (real policy, no GUI): see the recipe
[`recipes/fs-tools-plugin.md`](../../recipes/fs-tools-plugin.md).

## Dependencies (link:, machine-specific)

`@deepseek-ai/dsh-tools` (defineTool), `@deepseek-ai/dsh-llm` (HarnessError,
so `code` survives into `result.error`), `@deepseek-ai/schemastery` (Config),
`@vscode/ripgrep` (linked from the checkout's `tool-fs-search`
node_modules). Regenerate `package.json` links if the checkout moves.

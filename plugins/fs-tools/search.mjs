/**
 * search — ripgrep with the flags agents reach for bash `grep` to get:
 *
 *   context (-A/-B/-C)            `context: 3`
 *   files only (-l) / counts (-c) `mode: "files" | "count"`
 *   several roots                 `paths: ["src", "docs"]`
 *   several patterns (-e … -e …)  `patterns: ["foo", "bar"]`
 *   --include / --exclude globs   `include: ["*.ts"]`, `exclude: ["*.spec.ts"]`
 *   `| grep -v X` post-filter     `exclude_pattern: "X"`
 *   -i / -F / --no-ignore         `case_insensitive`, `literal`, `no_ignore`
 *
 * Runs the packaged `@vscode/ripgrep` binary through ctx.subprocess (the same
 * seam the in-tree grep uses) in the session cwd, parses `rg --json`, and
 * renders matches grouped by file with `N:` match rows and `N-` context rows.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { FsToolsError, dropUndefined, plural, positiveInt } from './common.mjs'

export const DEFAULT_MAX_RESULTS = 250
export const MAX_CONTEXT = 20
export const RAW_OUTPUT_MAX_BYTES = 20_000_000
export const STDERR_MAX_BYTES = 64 * 1024
export const TIMEOUT_MS = 30_000
export const MAX_LINE_CHARS = 500

let rgPathPromise
/** Path of the packaged ripgrep binary. */
export function resolveRgPath() {
  rgPathPromise ??= import('@vscode/ripgrep').then(m => m.rgPath)
  return rgPathPromise
}

function stringList(value, name) {
  if (value === undefined || value === null) return []
  const list = Array.isArray(value) ? value : [value]
  for (const v of list) if (typeof v !== 'string' || v.trim().length === 0) throw new FsToolsError(`${name} must be a list of non-empty strings`)
  return list
}

/**
 * @param {any} args
 * @param {{ maxResults: number }} caps
 */
export function parseSearchArgs(args, caps) {
  const patterns = [...(args.pattern !== undefined && args.pattern !== null ? [String(args.pattern)] : []), ...stringList(args.patterns, 'patterns')]
  if (patterns.length === 0) throw new FsToolsError('pattern (or patterns) is required')
  if (patterns.some(p => p.length === 0)) throw new FsToolsError('pattern must be a non-empty string')
  const mode = args.mode ?? 'lines'
  if (!['lines', 'files', 'count'].includes(mode)) throw new FsToolsError('mode must be lines, files or count')
  const include = stringList(args.include, 'include')
  const exclude = stringList(args.exclude, 'exclude')
  for (const g of [...include, ...exclude]) if (g.startsWith('!')) throw new FsToolsError('include/exclude globs must be positive; put exclusions in exclude')
  let excludeRe
  if (args.exclude_pattern !== undefined && args.exclude_pattern !== null) {
    try {
      excludeRe = new RegExp(String(args.exclude_pattern), args.case_insensitive ? 'i' : '')
    } catch (error) {
      throw new FsToolsError(`exclude_pattern is not a valid JavaScript regular expression: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return {
    patterns,
    paths: stringList(args.paths ?? args.path, 'paths'),
    include,
    exclude,
    excludeRe,
    mode,
    context: positiveInt(args.context, 'context', 0, MAX_CONTEXT),
    caseInsensitive: args.case_insensitive === true,
    literal: args.literal === true,
    noIgnore: args.no_ignore === true,
    hidden: args.hidden === true,
    maxResults: positiveInt(args.max_results, 'max_results', caps.maxResults, 5000),
  }
}

/**
 * The ripgrep argv (after the binary). Every model value rides in `--flag=value`
 * form or behind `--`, so a leading dash can never become a flag.
 * @param {ReturnType<typeof parseSearchArgs>} input
 */
export function buildSearchArgv(input) {
  const argv = ['--no-config', '--json']
  if (input.caseInsensitive) argv.push('--ignore-case')
  if (input.literal) argv.push('--fixed-strings')
  if (input.noIgnore) argv.push('--no-ignore')
  if (input.hidden) argv.push('--hidden')
  // Context only matters for the line rendering; files/count aggregate in JS from match records.
  if (input.mode === 'lines' && input.context > 0) argv.push(`--context=${input.context}`)
  for (const g of input.include) argv.push(`--glob=${g}`)
  for (const g of input.exclude) argv.push(`--glob=!${g}`)
  for (const p of input.patterns) argv.push(`--regexp=${p}`)
  argv.push('--')
  argv.push(...(input.paths.length > 0 ? input.paths : ['.']))
  return argv
}

/**
 * Spawn ripgrep through ctx.subprocess when mounted, else node's child_process.
 * @returns {Promise<{ exitCode: number | null, signal: string | null, stdout: string, stderr: string, lossy: boolean }>}
 */
async function runRg(ctx, argv, cwd, signal) {
  const rg = await resolveRgPath()
  const subprocess = ctx.get?.('subprocess') ?? ctx.subprocess
  if (subprocess?.spawn) {
    const handle = subprocess.spawn({
      argv: [rg, ...argv],
      cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: RAW_OUTPUT_MAX_BYTES }, stderr: { maxBytes: STDERR_MAX_BYTES } },
      graceMs: 3000,
      signal,
    })
    const outcome = await handle.done
    const out = handle.collected.stdout?.readFrom(0)
    const err = handle.collected.stderr?.readFrom(0)
    return { exitCode: outcome.exitCode, signal: outcome.signal, stdout: out?.text ?? '', stderr: err?.text ?? '', lossy: out?.lossy === true }
  }
  const { spawn } = await import('node:child_process')
  return new Promise((resolve, reject) => {
    const child = spawn(rg, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'], signal })
    const out = []
    const err = []
    let bytes = 0
    let lossy = false
    child.stdout.on('data', d => { bytes += d.length; if (bytes <= RAW_OUTPUT_MAX_BYTES) out.push(d); else lossy = true })
    child.stderr.on('data', d => err.push(d))
    child.on('error', reject)
    child.on('close', (code, sig) => resolve({ exitCode: code, signal: sig, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), lossy }))
  })
}

/**
 * Parse `rg --json` into per-file ordered records.
 * @returns {Map<string, Array<{ kind: 'match' | 'context', line: number, text: string }>>}
 */
export function parseRgJson(stdout) {
  const files = new Map()
  for (const raw of stdout.split('\n')) {
    if (raw.length === 0) continue
    let rec
    try { rec = JSON.parse(raw) } catch { continue }
    if (rec.type !== 'match' && rec.type !== 'context') continue
    const d = rec.data ?? {}
    const path = d.path?.text
    if (typeof path !== 'string' || typeof d.line_number !== 'number') continue
    const text = typeof d.lines?.text === 'string' ? d.lines.text.replace(/\r?\n$/, '') : '(line is not valid UTF-8)'
    const list = files.get(path) ?? []
    list.push({ kind: rec.type, line: d.line_number, text })
    files.set(path, list)
  }
  return files
}

/** Strip the cwd prefix from absolute paths; leave others. */
export function relativeTo(path, cwd) {
  const prefix = cwd.endsWith('/') ? cwd : `${cwd}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path.replace(/^\.\//, '')
}

/**
 * Apply exclude_pattern and drop context rows no longer near a kept match.
 * @param {Array<{ kind: string, line: number, text: string }>} records
 */
function filterRecords(records, excludeRe, context) {
  if (!excludeRe) return records
  const kept = records.filter(r => r.kind !== 'match' || !excludeRe.test(r.text))
  const matchLines = kept.filter(r => r.kind === 'match').map(r => r.line)
  return kept.filter(r => r.kind === 'match' || matchLines.some(m => Math.abs(m - r.line) <= context))
}

/**
 * Build the canonical result: files in output order with match/context rows, capped.
 * @param {ReturnType<typeof parseRgJson>} parsed
 * @param {ReturnType<typeof parseSearchArgs>} input
 * @param {string} cwd
 */
export function aggregate(parsed, input, cwd) {
  const files = []
  let totalMatches = 0
  let shownMatches = 0
  let truncated = false
  // ripgrep's file order is nondeterministic (parallel walk): sort by path so results are stable.
  const ordered = [...parsed.entries()].sort((a, b) => relativeTo(a[0], cwd).localeCompare(relativeTo(b[0], cwd)))
  for (const [rawPath, records] of ordered) {
    const recs = filterRecords(records, input.excludeRe, input.context)
    const matches = recs.filter(r => r.kind === 'match').length
    if (matches === 0) continue
    totalMatches += matches
    const path = relativeTo(rawPath, cwd)
    if (input.mode !== 'lines') {
      if (files.length >= input.maxResults) { truncated = true; continue }
      files.push({ path, matches })
      continue
    }
    if (truncated) continue
    const rows = []
    let prev
    for (const r of recs) {
      if (r.kind === 'match') {
        if (shownMatches >= input.maxResults) { truncated = true; break }
        shownMatches++
      }
      if (prev !== undefined && r.line > prev + 1) rows.push({ gap: true })
      const text = r.text.length > MAX_LINE_CHARS ? `${r.text.slice(0, MAX_LINE_CHARS - 1)}…` : r.text
      rows.push({ line: r.line, text, match: r.kind === 'match' })
      prev = r.line
    }
    if (rows.length > 0) files.push({ path, matches, rows })
  }
  return { mode: input.mode, files, totalMatches, totalFiles: [...parsed.keys()].filter(k => filterRecords(parsed.get(k), input.excludeRe, input.context).some(r => r.kind === 'match')).length, shownMatches, truncated, maxResults: input.maxResults }
}

/** @param {ReturnType<typeof aggregate>} v */
export function renderSearch(v) {
  if (v.totalMatches === 0) return 'No matches found'
  const head = `Found ${plural(v.totalMatches, 'match', 'matches')} in ${plural(v.totalFiles, 'file')}`
  if (v.mode === 'files') {
    const cut = v.truncated ? ` (showing first ${v.files.length} files; raise max_results or narrow)` : ''
    return `${head}${cut}\n${v.files.map(f => f.path).join('\n')}`
  }
  if (v.mode === 'count') {
    const cut = v.truncated ? ` (showing first ${v.files.length} files; raise max_results or narrow)` : ''
    const width = String(Math.max(...v.files.map(f => f.matches))).length
    return `${head}${cut}\n${v.files.map(f => `${String(f.matches).padStart(width)}  ${f.path}`).join('\n')}`
  }
  const cut = v.truncated ? ` (showing first ${v.shownMatches}; raise max_results, add exclude/exclude_pattern, or narrow paths)` : ''
  const blocks = v.files.map(f => {
    const width = String(Math.max(...f.rows.filter(r => !r.gap).map(r => r.line))).length
    const body = f.rows.map(r => r.gap ? `  ${'-'.repeat(width)}-` : `  ${String(r.line).padStart(width)}${r.match ? ':' : '-'} ${r.text}`).join('\n')
    return `${f.path}\n${body}`
  })
  return `${head}${cut}\n\n${blocks.join('\n\n')}`
}

/**
 * @param {any} ctx
 * @param {{ maxResults: number, timeoutMs: number }} caps
 */
export function createSearchTool(ctx, caps) {
  return defineTool({
    name: 'search',
    description: 'Search file contents with ripgrep, with the options bash grep gets used for: context lines, files-only or per-file counts, '
      + 'several roots, several patterns (OR), include/exclude globs, a `| grep -v`-style exclude_pattern, case-insensitive and literal matching. '
      + `Respects .gitignore unless no_ignore. Returns the first ${caps.maxResults} matches grouped by file ("N:" match rows, "N-" context rows). `
      + 'Use this instead of grep/rg in bash.',
    parameters: {
      pattern: { type: 'string', description: 'Regular expression (ripgrep/Rust syntax; use literal:true for a fixed string).' },
      patterns: { type: 'array', items: { type: 'string' }, description: 'Several patterns; a line matching any of them matches.' },
      paths: { type: 'array', items: { type: 'string' }, description: 'Files or directories to search (relative to the session workspace). Default: ["."].' },
      include: { type: 'array', items: { type: 'string' }, description: 'Only files matching these globs, e.g. ["*.ts", "*.tsx"]. Gitignore semantics: a glob containing "/" is anchored at the search root, so use "**/dir/**" for a directory at any depth.' },
      exclude: { type: 'array', items: { type: 'string' }, description: 'Skip files matching these globs, e.g. ["*.spec.ts", "**/tests/**"] (same anchoring rule as include).' },
      exclude_pattern: { type: 'string', description: 'Drop matching lines whose text matches this (JavaScript) regex — the `| grep -v` filter.' },
      mode: { type: 'string', enum: ['lines', 'files', 'count'], description: 'lines (default): matching lines with numbers; files: file list only (-l); count: per-file match counts (-c).' },
      context: { type: 'integer', description: `Context lines before and after each match (0–${MAX_CONTEXT}; lines mode).` },
      case_insensitive: { type: 'boolean', description: 'Case-insensitive matching (-i).' },
      literal: { type: 'boolean', description: 'Treat patterns as fixed strings, not regexes (-F).' },
      no_ignore: { type: 'boolean', description: 'Also search files ignored by .gitignore (node_modules, build output).' },
      hidden: { type: 'boolean', description: 'Also search hidden files and directories.' },
      max_results: { type: 'integer', description: `Cap on matches (lines mode) or files (files/count); default ${caps.maxResults}.` },
    },
    timeoutMs: caps.timeoutMs,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderSearch(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = parseSearchArgs(args, caps)
      const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd()
      const argv = buildSearchArgv(input)
      let run
      try {
        run = await runRg(ctx, argv, cwd, exec?.signal)
      } catch (error) {
        throw new FsToolsError(`search could not run ripgrep: ${error instanceof Error ? error.message : String(error)}`, 'SEARCH_FAILED', { cause: error })
      }
      if (run.signal !== null || run.exitCode === null) throw new FsToolsError(`search was killed (${run.signal ?? 'unknown signal'})`, 'SEARCH_FAILED')
      if (run.exitCode === 1) return dropUndefined(aggregate(new Map(), input, cwd))
      if (run.exitCode !== 0) {
        const detail = run.stderr.trim().split('\n').slice(-3).join(' ')
        throw new FsToolsError(`search failed (rg exit ${run.exitCode}): ${detail || 'no diagnostic'}`, 'SEARCH_FAILED')
      }
      if (run.lossy) throw new FsToolsError(`search produced more than ${RAW_OUTPUT_MAX_BYTES} bytes of raw output; narrow the pattern, paths or include`, 'SEARCH_TOO_LARGE')
      return dropUndefined(aggregate(parseRgJson(run.stdout), input, cwd))
    },
    presentCall: (args) => {
      const pats = [...(args.pattern ? [args.pattern] : []), ...(Array.isArray(args.patterns) ? args.patterns : [])]
      const where = Array.isArray(args.paths) && args.paths.length ? ` in ${args.paths.join(', ')}` : ''
      return { card: 'generic', title: `Search ${pats.join(' | ')}${where}`, kind: 'search', rawInput: pats.join(' | ') }
    },
  })
}

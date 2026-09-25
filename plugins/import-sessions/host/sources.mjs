/**
 * Source discovery: where Claude Code and pi keep their transcripts, how their
 * per-workspace directory names encode the working directory, and a bounded
 * scan that turns a user selection (root / workspace dir / session file) into
 * the workspace → session tree the modal shows.
 *
 *   Claude Code  ~/.claude/projects/<slug>/<sessionId>.jsonl
 *                  slug = cwd with every '/' AND '.' → '-'  (lossy: `/.supacode` → `--supacode`)
 *                  <slug>/<sessionId>/subagents/agent-*.jsonl  (Task subagents → child sessions)
 *                  <slug>/memory/*.md                           (project memory; ignored)
 *                  *.jsonl.backup                               (ignored)
 *   pi           ~/.pi/agent/sessions/--<path-with-'/'→'-'>--/<ISO-ts>_<uuid>.jsonl
 *                  first line: {"type":"session","version":3,"id","timestamp","cwd"}
 *
 * The slug is only a hint: the real working directory is read from the
 * transcript itself (pi header `cwd`; Claude records carry `cwd`). The scan
 * reads at most HEAD_BYTES + TAIL_BYTES of each file, so a bulk scan of the
 * whole store stays fast even with multi-hundred-MB transcripts; counts that
 * need the whole file (prompts) are reported only when the file was read whole.
 */
import { open, readdir, stat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

export const SOURCES = /** @type {const} */ ({
  claude: { label: 'Claude Code', idPrefix: 'claude-', defaultRoot: '~/.claude/projects' },
  pi: { label: 'pi', idPrefix: 'pi-', defaultRoot: '~/.pi/agent/sessions' },
})

export const HEAD_BYTES = 512 * 1024
export const TAIL_BYTES = 512 * 1024

export function expandHome(path) {
  if (typeof path !== 'string') return path
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

export function collapseHome(path) {
  const home = homedir()
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const CLAUDE_SESSION_FILE = /^([0-9a-f-]{36})\.jsonl$/i
const PI_SESSION_FILE = /^(\d{4}-\d{2}-\d{2}T[\d-]+Z)_([0-9a-f-]{36})\.jsonl$/i

/** Stable DSH id for a source session. */
export function dshSessionId(source, sourceId) {
  return `${SOURCES[source].idPrefix}${sourceId}`
}

/**
 * Best-effort decode of a slug directory name to a path; the transcript's own
 * `cwd` wins whenever one is readable.
 */
export function decodeSlug(source, slug) {
  if (source === 'pi') {
    const inner = slug.replace(/^--/, '').replace(/--$/, '')
    return `/${inner.replace(/-/g, '/')}`.replace(/\/+/g, '/')
  }
  // Claude: '-' stands for '/' or '.'; the path can only be recovered
  // heuristically ('/' everywhere) — callers prefer the record `cwd`.
  return `/${slug.replace(/^-/, '').replace(/-/g, '/')}`
}

/** Read the first `bytes` and last `bytes` of a file as UTF-8 line arrays. */
async function readHeadTail(file, size) {
  const handle = await open(file, 'r')
  try {
    const whole = size <= HEAD_BYTES + TAIL_BYTES
    if (whole) {
      const buffer = Buffer.alloc(size)
      await handle.read(buffer, 0, size, 0)
      return { lines: buffer.toString('utf8').split('\n'), whole: true }
    }
    const head = Buffer.alloc(HEAD_BYTES)
    await handle.read(head, 0, HEAD_BYTES, 0)
    const tail = Buffer.alloc(TAIL_BYTES)
    await handle.read(tail, 0, TAIL_BYTES, size - TAIL_BYTES)
    const headLines = head.toString('utf8').split('\n')
    headLines.pop() // partial
    const tailLines = tail.toString('utf8').split('\n')
    tailLines.shift() // partial
    return { lines: [...headLines, ...tailLines], whole: false }
  } finally {
    await handle.close()
  }
}

function parseLines(lines) {
  const out = []
  for (const line of lines) {
    if (line === '' || line[0] !== '{') continue
    try { out.push(JSON.parse(line)) } catch { /* partial or corrupt line */ }
  }
  return out
}

const INJECTED_PREFIXES = ['<system-reminder', '<local-command', '<command-', '<user-prompt-submit-hook', '<post-tool-use-hook', '<task-notification', 'Caveat: The messages below']
export function isInjectedText(text) {
  const t = String(text).trimStart()
  return INJECTED_PREFIXES.some(p => t.startsWith(p))
}

export function excerpt(text, max = 80) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** Metadata of one Claude Code transcript (bounded read). */
export async function inspectClaudeSession(file) {
  const info = await stat(file)
  const { lines, whole } = await readHeadTail(file, info.size)
  const records = parseLines(lines)
  let cwd
  let title
  let firstPrompt
  let firstTime
  let lastTime
  let prompts = 0
  let sourceId = CLAUDE_SESSION_FILE.exec(basename(file))?.[1]
  for (const r of records) {
    if (typeof r.cwd === 'string' && cwd === undefined) cwd = r.cwd
    if (typeof r.sessionId === 'string' && sourceId === undefined) sourceId = r.sessionId
    const t = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : Number.NaN
    if (Number.isFinite(t)) { firstTime = firstTime === undefined ? t : Math.min(firstTime, t); lastTime = lastTime === undefined ? t : Math.max(lastTime, t) }
    if (r.type === 'ai-title' && typeof r.aiTitle === 'string' && r.aiTitle !== '') title ??= r.aiTitle
    if (r.type === 'summary' && typeof r.summary === 'string' && r.summary !== '') title ??= r.summary
    if (r.type === 'user' && r.isMeta !== true && r.isSidechain !== true) {
      const content = r.message?.content
      const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text) : []
      const real = texts.filter(x => typeof x === 'string' && x.trim() !== '' && !isInjectedText(x) && !x.startsWith('[Request interrupted'))
      if (real.length > 0) { prompts++; firstPrompt ??= real[0] }
    }
  }
  const dir = resolve(file, '..')
  let subagents = 0
  if (sourceId !== undefined) {
    try {
      const entries = await readdir(join(dir, sourceId, 'subagents'))
      subagents = entries.filter(n => /^agent-.*\.jsonl$/.test(n)).length
    } catch { /* none */ }
  }
  return {
    sourceId: sourceId ?? basename(file, '.jsonl'),
    file,
    cwd,
    title: title ?? (firstPrompt !== undefined ? excerpt(firstPrompt) : undefined),
    startedAt: firstTime ?? info.birthtimeMs ?? info.mtimeMs,
    endedAt: lastTime ?? info.mtimeMs,
    bytes: info.size,
    ...(whole ? { prompts } : {}),
    subagents,
  }
}

/** Metadata of one pi transcript (bounded read). */
export async function inspectPiSession(file) {
  const info = await stat(file)
  const { lines, whole } = await readHeadTail(file, info.size)
  const records = parseLines(lines)
  const header = records.find(r => r.type === 'session')
  const match = PI_SESSION_FILE.exec(basename(file))
  let title
  let firstPrompt
  let firstTime = header?.timestamp !== undefined ? Date.parse(header.timestamp) : undefined
  let lastTime
  let prompts = 0
  for (const r of records) {
    const t = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : (typeof r.timestamp === 'number' ? r.timestamp : Number.NaN)
    if (Number.isFinite(t)) { firstTime = firstTime === undefined ? t : Math.min(firstTime, t); lastTime = lastTime === undefined ? t : Math.max(lastTime, t) }
    if (r.type === 'session_info' && typeof r.name === 'string' && r.name !== '') title = r.name // last one wins (renames)
    if (r.type === 'message' && r.message?.role === 'user') {
      const content = r.message.content
      const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text) : []
      const real = texts.filter(x => typeof x === 'string' && x.trim() !== '')
      if (real.length > 0) { prompts++; firstPrompt ??= real[0] }
      const mt = typeof r.message.timestamp === 'number' ? r.message.timestamp : Number.NaN
      if (Number.isFinite(mt)) lastTime = lastTime === undefined ? mt : Math.max(lastTime, mt)
    }
  }
  return {
    sourceId: header?.id ?? match?.[2] ?? basename(file, '.jsonl'),
    file,
    cwd: header?.cwd,
    title: title ?? (firstPrompt !== undefined ? excerpt(firstPrompt) : undefined),
    startedAt: Number.isFinite(firstTime) ? firstTime : info.birthtimeMs ?? info.mtimeMs,
    endedAt: Number.isFinite(lastTime) ? lastTime : info.mtimeMs,
    bytes: info.size,
    ...(whole ? { prompts } : {}),
  }
}

export function isSessionFile(source, name) {
  return source === 'claude' ? CLAUDE_SESSION_FILE.test(name) : PI_SESSION_FILE.test(name)
}

/**
 * Classify a selected path by CONTENT (so an uploaded copy of a store, whose
 * root is not the configured one, classifies the same way):
 *   file that is a session transcript                 → session
 *   directory holding session transcripts             → workspace
 *   directory holding directories with transcripts    → root
 *   directory with exactly one entry (an upload wrapper) → classify that entry
 * The configured root only breaks the tie for an empty directory.
 * @returns {Promise<{kind:'root'|'workspace'|'session', path:string}>}
 */
export async function classifySelection(source, root, selected) {
  const path = resolve(expandHome(selected))
  const info = await stat(path)
  if (info.isFile()) {
    if (!isSessionFile(source, basename(path))) throw new Error(`${collapseHome(path)} is not a ${SOURCES[source].label} session transcript`)
    return { kind: 'session', path }
  }
  if (!info.isDirectory()) throw new Error(`${collapseHome(path)} is neither a file nor a directory`)
  let canonical = path
  try { canonical = await realpath(path) } catch { /* keep */ }
  const entries = await readdir(canonical, { withFileTypes: true })
  if (entries.some(e => e.isFile() && isSessionFile(source, e.name))) return { kind: 'workspace', path: canonical }
  const dirs = entries.filter(e => e.isDirectory() && e.name !== 'memory' && e.name !== 'subagents')
  for (const dir of dirs) {
    let inner
    try { inner = await readdir(join(canonical, dir.name)) } catch { continue }
    if (inner.some(n => isSessionFile(source, n))) return { kind: 'root', path: canonical }
  }
  if (dirs.length === 1 && entries.length === 1) return classifySelection(source, root, join(canonical, dirs[0].name))
  let canonicalRoot = resolve(expandHome(root))
  try { canonicalRoot = await realpath(canonicalRoot) } catch { /* keep */ }
  if (canonical === canonicalRoot) return { kind: 'root', path: canonical }
  throw new Error(`${collapseHome(path)} holds no ${SOURCES[source].label} session transcripts`)
}

async function listSessionFiles(source, dir) {
  const entries = await readdir(dir)
  return entries.filter(n => isSessionFile(source, n)).sort().map(n => join(dir, n))
}

/**
 * Build the workspace → session tree for a selection.
 * @param {'claude'|'pi'} source
 * @param {string} root - configured source root
 * @param {string} selected - user-selected path
 * @param {object|Function} [options] - `{ probe, measure }`, or the probe function alone
 * @param {(session: object) => Promise<{imported:boolean}>} [options.probe] - per-session existence check
 * @param {(session: object) => Promise<{turns:number, estimatedTokens:number}|undefined>} [options.measure] - full-read statistics
 */
export async function scanSelection(source, root, selected, options) {
  const { probe, measure } = typeof options === 'function' ? { probe: options } : (options ?? {})
  const selection = await classifySelection(source, root, selected)
  /** @type {Map<string, {key:string, slug:string, dir:string|undefined, sessions:object[]}>} */
  const groups = new Map()
  const inspect = source === 'claude' ? inspectClaudeSession : inspectPiSession

  const addFile = async (file) => {
    let meta
    try { meta = await inspect(file) } catch (error) { meta = { sourceId: basename(file, '.jsonl'), file, error: String(error?.message ?? error), bytes: 0, startedAt: 0, endedAt: 0 } }
    const slug = basename(resolve(file, '..'))
    const key = slug
    let group = groups.get(key)
    if (group === undefined) { group = { key, slug, dir: undefined, sessions: [] }; groups.set(key, group) }
    if (group.dir === undefined && typeof meta.cwd === 'string') group.dir = meta.cwd
    group.sessions.push(meta)
  }

  if (selection.kind === 'session') {
    await addFile(selection.path)
  } else if (selection.kind === 'workspace') {
    for (const file of await listSessionFiles(source, selection.path)) await addFile(file)
  } else {
    const entries = await readdir(selection.path, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue
      const dir = join(selection.path, entry.name)
      let files
      try { files = await listSessionFiles(source, dir) } catch { continue }
      for (const file of files) await addFile(file)
    }
  }

  const seenSourceIds = new Map()
  const workspaces = []
  for (const group of groups.values()) {
    if (group.sessions.length === 0) continue
    const dir = group.dir ?? decodeSlug(source, group.slug)
    let dirExists = false
    try { dirExists = (await stat(dir)).isDirectory() } catch { dirExists = false }
    const sessions = []
    for (const meta of group.sessions.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) {
      const id = dshSessionId(source, meta.sourceId)
      const duplicateOf = seenSourceIds.get(meta.sourceId)
      if (duplicateOf === undefined) seenSourceIds.set(meta.sourceId, meta.file)
      let imported = false
      if (probe !== undefined) {
        try { imported = (await probe({ id, ...meta })).imported === true } catch { imported = false }
      }
      let measured
      if (measure !== undefined && meta.error === undefined) {
        try { measured = await measure({ id, ...meta }) } catch (error) { meta.error = String(error?.message ?? error) }
      }
      sessions.push({
        id,
        sourceId: meta.sourceId,
        file: meta.file,
        title: meta.title ?? `${SOURCES[source].label} session ${meta.sourceId.slice(0, 8)}`,
        startedAt: Math.round(meta.startedAt ?? 0),
        endedAt: Math.round(meta.endedAt ?? 0),
        bytes: meta.bytes ?? 0,
        ...(meta.prompts !== undefined ? { prompts: meta.prompts } : {}),
        ...(measured !== undefined ? measured : {}),
        imported,
        ...(duplicateOf !== undefined ? { duplicateOf } : {}),
        ...(meta.subagents ? { subagents: meta.subagents } : {}),
        ...(meta.error !== undefined ? { error: meta.error } : {}),
      })
    }
    workspaces.push({ key: group.key, dir, dirExists, sessions })
  }
  workspaces.sort((a, b) => a.dir.localeCompare(b.dir))
  return { source, path: selection.path, kind: selection.kind, workspaces }
}

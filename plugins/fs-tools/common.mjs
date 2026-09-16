/**
 * common.mjs — helpers shared by the four fs-tools:
 *
 *   - session-aware path resolution through ctx.fs (the calling agent's cwd,
 *     `~` expansion), exactly as the in-tree read/edit tools do;
 *   - the per-call sandbox policy (`ctx.sandboxPolicy.resolve({ session })`)
 *     stamped onto mutations so a confining backend fences them like `edit`;
 *   - the model-facing error class and the `[sandbox: …]` denial mapping;
 *   - line-window rendering in the same `N: text` shape as `read`.
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Model-facing failure of one of these tools (a HarnessError so `code` survives into the result). */
export class FsToolsError extends HarnessError {
  /**
   * @param {string} message
   * @param {string} [code]
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, code = 'FS_TOOLS_FAILED', options) {
    super(message, code, options)
    this.name = 'FsToolsError'
  }
}

/**
 * The filesystem service, or a clear failure when the composition has none.
 * @param {any} ctx
 */
export function requireFs(ctx) {
  const fs = ctx.get('fs')
  if (fs === undefined) throw new FsToolsError('this tool needs a filesystem service (ctx.fs) in this composition; none is mounted.')
  return fs
}

/**
 * The standing sandbox policy for this call (undefined when the backend does not confine),
 * and the cwd relative paths resolve against: the policy's workspace root, else the session cwd.
 * @param {any} ctx
 * @param {any} exec - tool execution context (`exec.agent.session`)
 */
export function callContext(ctx, exec) {
  const session = exec?.agent?.session
  const policy = session ? ctx.get('sandboxPolicy')?.resolve({ session }) : undefined
  const cwd = policy?.workspaceRoot ?? session?.header?.cwd ?? process.cwd()
  return { policy, cwd, signal: exec?.signal }
}

/**
 * Expand a leading `~` and resolve through ctx.fs against the call's cwd.
 * @param {any} fs
 * @param {string} path
 * @param {{ cwd: string, signal?: AbortSignal }} call
 */
export async function resolvePath(fs, path, call) {
  const expanded = String(path).replace(/^~(?=\/|$)/, process.env.HOME ?? '~')
  return fs.resolve(expanded, { cwd: call.cwd, signal: call.signal })
}

/** `target.displayPath` with a fallback for minimal backends. */
export function displayPath(target, fallback) {
  return target?.displayPath ?? target?.path ?? fallback
}

/**
 * Map a thrown fs error to the model-facing shape: a sandbox denial becomes the
 * shared `[sandbox: …]` marker (no escalation hint — these tools carry no
 * `sandbox_permissions`; the built-in `edit`/`write` do), guard failures get
 * the same remedies the in-tree tools print, everything else keeps its message.
 * @param {unknown} error
 * @param {string} path
 * @param {any} policy
 */
export function mapFsError(error, path, policy) {
  const code = error && typeof error === 'object' ? /** @type {any} */ (error).code : undefined
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'FS_SANDBOX_DENIED') {
    const mode = policy?.mode ?? 'the current'
    return new FsToolsError(
      `[sandbox: file access denied under ${mode} mode] "${path}" is outside the writable roots. `
        + 'For a one-off escalation use the built-in edit/write tool with sandbox_permissions.',
      'FS_SANDBOX_DENIED',
      { cause: error },
    )
  }
  if (code === 'FS_NOT_OBSERVED') {
    return new FsToolsError(`cannot modify "${path}": file has not been read — read it (read or read_many), then retry`, code, { cause: error })
  }
  if (code === 'FS_STALE_VERSION') {
    return new FsToolsError(`cannot modify "${path}": file changed since it was read — re-read it (read or read_many), then retry`, code, { cause: error })
  }
  if (code === 'FS_NOT_FOUND') return new FsToolsError(`"${path}": not found`, code, { cause: error })
  return new FsToolsError(`"${path}": ${message}`, typeof code === 'string' ? code : 'FS_TOOLS_FAILED', { cause: error })
}

/**
 * Validate an optional positive integer argument.
 * @param {unknown} value
 * @param {string} name
 * @param {number} fallback
 * @param {number} [max]
 */
export function positiveInt(value, name, fallback, max) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new FsToolsError(`${name} must be a positive integer`)
  if (max !== undefined && value > max) throw new FsToolsError(`${name} must be at most ${max}`)
  return value
}

/**
 * Split text into lines the way `read` does (LF/CRLF; a trailing newline does not add an empty line).
 * @param {string} text
 */
export function splitLines(text) {
  if (text === '') return []
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * Render a 1-based line window `offset..offset+limit-1` as `N: text` rows.
 * @param {string[]} lines - the whole file's lines
 * @param {{ offset: number, limit: number, collapseBlank?: boolean, maxLineLength?: number }} window
 * @returns {{ rows: string[], first: number, last: number, total: number, shown: number }}
 */
export function renderWindow(lines, window) {
  const total = lines.length
  const first = Math.min(window.offset, total + 1)
  const end = Math.min(total, first + window.limit - 1)
  const width = String(end).length
  const rows = []
  let shown = 0
  for (let n = first; n <= end; n++) {
    let text = lines[n - 1]
    if (window.collapseBlank && text.trim() === '') continue
    if (window.maxLineLength && text.length > window.maxLineLength) text = `${text.slice(0, window.maxLineLength)}…`
    rows.push(`${String(n).padStart(width)}: ${text}`)
    shown++
  }
  return { rows, first, last: end, total, shown }
}

/** 1-based line number of a character offset inside `text`. */
export function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

/** `n thing`/`n things`. */
export function plural(n, word, pluralWord = `${word}s`) {
  return `${n} ${n === 1 ? word : pluralWord}`
}

/**
 * Deep copy without `undefined` members (the tool registry snapshots canonical values as lossless JSON).
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function dropUndefined(value) {
  if (Array.isArray(value)) return /** @type {any} */ (value.map(v => v === undefined ? null : dropUndefined(v)))
  if (value && typeof value === 'object') {
    const out = /** @type {any} */ ({})
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = dropUndefined(v)
    return out
  }
  return value
}

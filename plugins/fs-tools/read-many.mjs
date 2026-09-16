/**
 * read_many — several files / line ranges in ONE call, rendered like `read`
 * (`N: text` rows inside a <path>/<content> envelope per file). Every
 * successful read emits `fs/observed` with the file's version, so the
 * read-before-edit policy treats it exactly like `read`: an `edit`/`edit_many`
 * that follows is authorised. Absent files are observed absent and reported
 * inline (the other files still return) instead of failing the whole call.
 *
 * This is the tool-shaped replacement for `sed -n 'X,Yp' a; echo ---; sed -n … b`.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { FsToolsError, callContext, displayPath, dropUndefined, positiveInt, renderWindow, requireFs, resolvePath, splitLines } from './common.mjs'

export const DEFAULT_LIMIT = 2000
export const DEFAULT_TOTAL_LIMIT = 4000
export const MAX_FILES = 40
export const MAX_LINE_LENGTH = 2000

/**
 * @param {any} args
 * @param {{ limit: number, totalLimit: number, maxLineLength: number }} caps
 */
export function parseReadManyArgs(args, caps) {
  const raw = args.files
  if (!Array.isArray(raw) || raw.length === 0) throw new FsToolsError('files must be a non-empty array of { path, offset?, limit? }')
  if (raw.length > MAX_FILES) throw new FsToolsError(`files may name at most ${MAX_FILES} entries per call`)
  const files = raw.map((f, i) => {
    const item = typeof f === 'string' ? { path: f } : f
    if (!item || typeof item.path !== 'string' || item.path.trim().length === 0) throw new FsToolsError(`files[${i}].path must be a non-empty string`)
    return {
      path: item.path,
      offset: positiveInt(item.offset, `files[${i}].offset`, 1),
      limit: positiveInt(item.limit, `files[${i}].limit`, caps.limit, caps.limit),
    }
  })
  return {
    files,
    collapseBlank: args.collapse_blank === true,
    maxLines: positiveInt(args.max_lines, 'max_lines', caps.totalLimit, caps.totalLimit),
    maxLineLength: caps.maxLineLength,
  }
}

/**
 * @param {{ files: Array<{ path: string, error?: string, rows?: string[], first?: number, last?: number, total?: number, shown?: number, omitted?: number }>, truncatedAt?: number }} value
 */
export function renderReadMany(value) {
  const out = []
  for (const f of value.files) {
    if (f.error) { out.push(`<path>${f.path}</path>\n<error>${f.error}</error>`); continue }
    const rows = f.rows ?? []
    const range = f.total === 0 ? 'empty file' : `lines ${f.first}-${f.last} of ${f.total}`
    const tail = f.omitted ? ` (${f.omitted} more requested lines omitted by max_lines)` : ''
    out.push(`<path>${f.path}</path>\n<type>file</type>\n<content>  (${range}${tail})\n${rows.join('\n')}\n</content>`)
  }
  if (value.truncatedAt !== undefined) out.push(`(stopped after ${value.truncatedAt} lines — raise max_lines or narrow the ranges)`)
  return out.join('\n\n')
}

/**
 * @param {any} ctx
 * @param {{ limit: number, totalLimit: number, maxLineLength: number }} caps
 */
export function createReadManyTool(ctx, caps) {
  return defineTool({
    name: 'read_many',
    description: 'Read several UTF-8 text files, or several line ranges of one file, in ONE call. Each entry is { path, offset?, limit? } '
      + '(1-based offset; limit defaults to the whole file up to the cap). Output is line-numbered like `read`. Each file read counts as '
      + 'read for the edit tools\' read-before-edit guard. Missing files are reported inline without failing the call. '
      + 'Use this instead of chained `sed -n`/`cat`/`head` in bash.',
    parameters: {
      files: {
        type: 'array',
        required: true,
        items: {
          oneOf: [
            { type: 'string', description: 'A path (whole file).' },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true, description: 'Path (relative to the session workspace, absolute, or ~).' },
                offset: { type: 'integer', description: '1-based first line (default 1).' },
                limit: { type: 'integer', description: `Max lines for this entry (default and cap ${caps.limit}).` },
              },
            },
          ],
        },
        description: `Files / ranges to read, in output order (max ${MAX_FILES}). The same path may appear several times with different ranges.`,
      },
      collapse_blank: { type: 'boolean', description: 'Drop blank lines from the output (line numbers stay accurate).' },
      max_lines: { type: 'integer', description: `Total line budget across all entries (default ${caps.totalLimit}); later entries are cut when reached.` },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderReadMany(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = parseReadManyArgs(args, caps)
      const fs = requireFs(ctx)
      const call = callContext(ctx, exec)
      const files = []
      let budget = input.maxLines
      let truncatedAt
      /** @type {Map<string, { target: any, info: any, lines: string[] }>} */
      const cache = new Map()
      for (const f of input.files) {
        if (budget <= 0) { truncatedAt = input.maxLines; break }
        let target
        try {
          target = await resolvePath(fs, f.path, call)
          const key = target.targetKey ?? displayPath(target, f.path)
          let entry = cache.get(key)
          if (entry === undefined) {
            const info = await fs.stat(target, call.signal)
            if (info === undefined) {
              ctx.emit?.('fs/observed', target, { kind: 'absent' }, exec)
              files.push({ path: displayPath(target, f.path), error: 'not found' })
              continue
            }
            if (info.type !== 'file') {
              files.push({ path: displayPath(target, f.path), error: `not a regular file (${info.type})` })
              continue
            }
            const text = await fs.readText(target, call.signal)
            entry = { target, info, lines: splitLines(text) }
            cache.set(key, entry)
            // The read succeeded: record the observation so a following edit is authorised.
            ctx.emit?.('fs/observed', target, { kind: 'present', version: info.version }, exec)
          }
          const w = renderWindow(entry.lines, { offset: f.offset, limit: Math.min(f.limit, budget), collapseBlank: input.collapseBlank, maxLineLength: input.maxLineLength })
          const requestedEnd = Math.min(entry.lines.length, f.offset + f.limit - 1)
          const omitted = Math.max(0, requestedEnd - w.last)
          budget -= w.rows.length
          files.push({ path: displayPath(target, f.path), rows: w.rows, first: w.first, last: w.last, total: w.total, shown: w.shown, ...omitted ? { omitted } : {} })
        } catch (error) {
          files.push({ path: displayPath(target, f.path), error: error instanceof Error ? error.message : String(error) })
        }
      }
      return dropUndefined({ files, ...truncatedAt !== undefined ? { truncatedAt } : {} })
    },
    presentCall: (args) => {
      const names = Array.isArray(args.files) ? args.files.map(f => typeof f === 'string' ? f : f?.path).filter(Boolean) : []
      const uniq = [...new Set(names)]
      return { card: 'generic', title: `Read ${uniq.slice(0, 3).join(', ')}${uniq.length > 3 ? ` +${uniq.length - 3}` : ''}`, kind: 'read', locations: uniq.map(path => ({ path })) }
    },
  })
}

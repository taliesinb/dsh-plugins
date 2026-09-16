/**
 * list_dir — directory listing with directories INCLUDED (glob returns files
 * only), several roots per call, bounded depth, optional sizes. Pure ctx.fs
 * (`resolve` → `stat` → `listDir`), so remote/sandboxed backends work and no
 * shell is involved. Noise directories (`node_modules`, `.git`, …) are shown
 * as a single collapsed row below the first level unless `all` is set.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { FsToolsError, callContext, displayPath, dropUndefined, plural, positiveInt, requireFs, resolvePath } from './common.mjs'

export const DEFAULT_MAX_ENTRIES = 300
export const MAX_DEPTH = 6
/** Directories never descended into unless `all: true` (still listed as one row). */
export const COLLAPSED = new Set(['node_modules', '.git', '.pnpm', 'dist', 'lib', 'build', '.next', '.turbo', '__pycache__', '.venv', 'target', 'coverage'])

/**
 * @param {any} args
 * @param {{ maxEntries: number }} caps
 */
export function parseListDirArgs(args, caps) {
  const paths = args.paths === undefined || args.paths === null
    ? ['.']
    : Array.isArray(args.paths) ? args.paths.map(String) : [String(args.paths)]
  if (paths.length === 0) throw new FsToolsError('paths must name at least one directory')
  if (paths.some(p => p.trim().length === 0)) throw new FsToolsError('paths must not contain blank entries')
  return {
    paths,
    depth: positiveInt(args.depth, 'depth', 1, MAX_DEPTH),
    maxEntries: positiveInt(args.max_entries, 'max_entries', caps.maxEntries, 5000),
    sizes: args.sizes === true,
    all: args.all === true,
  }
}

/**
 * Walk one root breadth-first up to `depth`, collecting rows in tree order.
 * @param {any} fs
 * @param {any} target - resolved root
 * @param {ReturnType<typeof parseListDirArgs>} input
 * @param {{ signal?: AbortSignal }} call
 * @param {{ count: number }} budget - shared across roots
 */
async function walk(fs, target, input, call, budget) {
  const rows = []
  let truncated = false
  /** @param {any} dir @param {number} level @param {string} prefix */
  async function visit(dir, level, prefix) {
    let entries
    try {
      entries = await fs.listDir(dir, call.signal)
    } catch (error) {
      rows.push({ path: `${prefix}`, type: 'error', error: error instanceof Error ? error.message : String(error) })
      return
    }
    // directories first, then files, both by name (listDir is name-ordered already)
    const sorted = [...entries].sort((a, b) => (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1) || a.name.localeCompare(b.name))
    for (const entry of sorted) {
      if (budget.count >= input.maxEntries) { truncated = true; return }
      budget.count++
      const isDir = entry.type === 'directory'
      const rel = `${prefix}${entry.name}${isDir ? '/' : ''}`
      const row = { path: rel, type: entry.type, ...input.sizes && entry.size !== undefined ? { size: entry.size } : {} }
      const collapse = isDir && !input.all && (COLLAPSED.has(entry.name) || (entry.name.startsWith('.') && entry.name !== '.github'))
      if (collapse) row.collapsed = true
      rows.push(row)
      if (isDir && level + 1 < input.depth && !collapse) {
        await visit(entry.target, level + 1, rel)
        if (truncated) return
      }
    }
  }
  await visit(target, 0, '')
  return { rows, truncated }
}

/** Format bytes compactly (`1.2 KB`). */
export function formatSize(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Model-facing text: one block per root, rows indented by depth.
 * @param {{ roots: Array<{ root: string, error?: string, rows?: any[], truncated?: boolean }>, maxEntries: number }} value
 */
export function renderListDir(value) {
  const out = []
  for (const r of value.roots) {
    if (r.error) { out.push(`${r.root}: ${r.error}`); continue }
    const rows = r.rows ?? []
    const dirs = rows.filter(x => x.type === 'directory').length
    const files = rows.filter(x => x.type === 'file').length
    out.push(`${r.root}  (${plural(dirs, 'dir')}, ${plural(files, 'file')}${r.truncated ? ', truncated' : ''})`)
    for (const row of rows) {
      const depth = row.path.replace(/\/$/, '').split('/').length - 1
      const name = row.path.replace(/\/$/, '').split('/').at(-1) + (row.type === 'directory' ? '/' : '')
      const size = row.size !== undefined ? `  ${formatSize(row.size)}` : ''
      const note = row.collapsed ? '  (not descended; pass all:true)' : row.type === 'error' ? `  ! ${row.error}` : row.type === 'other' ? '  (special)' : ''
      out.push(`${'  '.repeat(depth + 1)}${name}${size}${note}`)
    }
    if (r.truncated) out.push(`  … stopped at ${value.maxEntries} entries (raise max_entries or narrow paths/depth)`)
  }
  return out.join('\n')
}

/**
 * @param {any} ctx
 * @param {{ maxEntries: number }} caps
 */
export function createListDirTool(ctx, caps) {
  return defineTool({
    name: 'list_dir',
    description: 'List directory contents — directories INCLUDED (glob returns files only) — for one or more roots, to a bounded depth, '
      + 'with optional sizes. Directories end in "/". Noise directories (node_modules, .git, dist, lib, hidden dirs) are shown but not descended '
      + 'unless all:true. Use this instead of `ls`/`tree`/`find -maxdepth` in bash.',
    parameters: {
      paths: { type: 'array', items: { type: 'string' }, description: 'Directories to list (relative to the session workspace, or absolute / ~). Default: ["."].' },
      depth: { type: 'integer', description: `Levels to descend (1 = direct children only, default). Max ${MAX_DEPTH}.` },
      max_entries: { type: 'integer', description: `Stop after this many rows across all roots (default ${caps.maxEntries}).` },
      sizes: { type: 'boolean', description: 'Append file sizes.' },
      all: { type: 'boolean', description: 'Also descend into node_modules/.git/dist/hidden directories.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderListDir(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = parseListDirArgs(args, caps)
      const fs = requireFs(ctx)
      const call = callContext(ctx, exec)
      const budget = { count: 0 }
      const roots = []
      for (const p of input.paths) {
        let target
        try {
          target = await resolvePath(fs, p, call)
          const info = await fs.stat(target, call.signal)
          if (info === undefined) { roots.push({ root: p, error: 'not found' }); continue }
          if (info.type !== 'directory') { roots.push({ root: displayPath(target, p), error: `not a directory (${info.type})` }); continue }
        } catch (error) {
          roots.push({ root: p, error: error instanceof Error ? error.message : String(error) })
          continue
        }
        const { rows, truncated } = await walk(fs, target, input, call, budget)
        roots.push({ root: displayPath(target, p), rows, ...truncated ? { truncated: true } : {} })
        if (truncated) break
      }
      return dropUndefined({ roots, maxEntries: input.maxEntries })
    },
    presentCall: (args) => ({ card: 'generic', title: `List ${(args.paths ?? ['.']).join(', ')}`, kind: 'read' }),
  })
}

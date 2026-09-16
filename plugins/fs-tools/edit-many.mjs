/**
 * edit_many — several literal replacements, across several files, in ONE call.
 *
 * Two phases, so a bad edit never leaves a half-applied batch:
 *
 *   validate  every target resolved; every file passes the read-before-edit
 *             guard (`fs/edit-intent` — FS_NOT_OBSERVED if unread, exactly as
 *             `edit`); every old_string found exactly once (or replace_all) in
 *             the file AS IT WILL BE after the earlier edits of the same call;
 *             all problems are collected and reported together, nothing written.
 *   apply     edits run in order through ctx.fs.editText with the version guard
 *             from the intent slot (compare-and-swap in the backend) and emit
 *             `fs/observed` after each, so later edits to the same file see the
 *             fresh version and a following `edit` needs no re-read.
 *
 * A failure during apply (a concurrent writer) reports exactly which edits
 * were applied and which were not. `dry_run` stops after validation.
 *
 * This is the tool-shaped replacement for the `python3 - <<'EOF' … s.replace(old,new) …` heredoc.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { FsToolsError, callContext, displayPath, dropUndefined, lineOf, mapFsError, plural, requireFs, resolvePath } from './common.mjs'

export const MAX_EDITS = 60

/** @param {any} args */
export function parseEditManyArgs(args) {
  const raw = args.edits
  if (!Array.isArray(raw) || raw.length === 0) throw new FsToolsError('edits must be a non-empty array of { file_path, old_string, new_string, replace_all? }')
  if (raw.length > MAX_EDITS) throw new FsToolsError(`edits may hold at most ${MAX_EDITS} entries per call`)
  const edits = raw.map((e, i) => {
    if (!e || typeof e !== 'object') throw new FsToolsError(`edits[${i}] must be an object`)
    if (typeof e.file_path !== 'string' || e.file_path.trim().length === 0) throw new FsToolsError(`edits[${i}].file_path must be a non-empty string`)
    if (typeof e.old_string !== 'string' || e.old_string.length === 0) throw new FsToolsError(`edits[${i}].old_string must be a non-empty string`)
    if (typeof e.new_string !== 'string') throw new FsToolsError(`edits[${i}].new_string must be a string`)
    if (e.old_string === e.new_string) throw new FsToolsError(`edits[${i}]: old_string and new_string must differ`)
    return { index: i, filePath: e.file_path, oldString: e.old_string, newString: e.new_string, replaceAll: e.replace_all === true }
  })
  return { edits, dryRun: args.dry_run === true }
}

/** Count non-overlapping occurrences of `needle` in `text` (after LF normalisation, as the backend matches). */
export function countOccurrences(text, needle) {
  let count = 0
  let from = 0
  for (;;) {
    const at = text.indexOf(needle, from)
    if (at === -1) return count
    count++
    from = at + needle.length
  }
}

function normalize(text) {
  return text.replace(/\r\n/g, '\n')
}

/** Short one-line preview of a literal for diagnostics. */
function preview(s, n = 60) {
  const one = s.replace(/\n/g, '\\n')
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

/**
 * Validate a batch against current file contents without writing.
 * @param {any} fs
 * @param {any} ctx
 * @param {any} exec
 * @param {ReturnType<typeof parseEditManyArgs>['edits']} edits
 * @param {{ cwd: string, policy: any, signal?: AbortSignal }} call
 * @returns {Promise<{ resolved: Array<{ edit: any, target: any, path: string, line?: number, count?: number }>, problems: string[] }>}
 */
export async function validateEdits(fs, ctx, exec, edits, call) {
  /** @type {Map<string, { target: any, path: string, text: string | null, guardError?: string }>} */
  const files = new Map()
  const resolved = []
  const problems = []
  for (const edit of edits) {
    let target
    try {
      target = await resolvePath(fs, edit.filePath, call)
    } catch (error) {
      problems.push(`#${edit.index + 1} ${edit.filePath}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const key = target.targetKey ?? displayPath(target, edit.filePath)
    const path = displayPath(target, edit.filePath)
    let file = files.get(key)
    if (file === undefined) {
      file = { target, path, text: null }
      files.set(key, file)
      // The read-guard decision: throws FS_NOT_OBSERVED for an unread file, FS_NOT_FOUND for one observed absent.
      try {
        await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
      } catch (error) {
        file.guardError = mapFsError(error, path, call.policy).message
      }
      if (file.guardError === undefined) {
        try {
          const info = await fs.stat(target, call.signal)
          if (info === undefined) file.guardError = `"${path}": not found`
          else if (info.type !== 'file') file.guardError = `"${path}": not a regular file (${info.type})`
          else file.text = normalize(await fs.readText(target, call.signal))
        } catch (error) {
          file.guardError = mapFsError(error, path, call.policy).message
        }
      }
    }
    if (file.guardError !== undefined) {
      problems.push(`#${edit.index + 1} ${file.guardError}`)
      continue
    }
    const text = /** @type {string} */ (file.text)
    const old = normalize(edit.oldString)
    const count = countOccurrences(text, old)
    if (count === 0) {
      problems.push(`#${edit.index + 1} ${path}: old_string not found (${preview(old)})`)
      continue
    }
    if (count > 1 && !edit.replaceAll) {
      problems.push(`#${edit.index + 1} ${path}: old_string appears ${count} times — make it more specific or set replace_all (${preview(old)})`)
      continue
    }
    const line = lineOf(text, text.indexOf(old))
    // Simulate, so later edits of this call see the file as it will be.
    file.text = edit.replaceAll ? text.split(old).join(normalize(edit.newString)) : text.replace(old, () => normalize(edit.newString))
    resolved.push({ edit, target, path, line, count })
  }
  return { resolved, problems }
}

/**
 * @param {{ dryRun: boolean, applied: Array<{ path: string, line: number, count: number, replaceAll: boolean }>, files: number }} value
 */
export function renderEditMany(value) {
  const byFile = new Map()
  for (const a of value.applied) {
    const list = byFile.get(a.path) ?? []
    list.push(a)
    byFile.set(a.path, list)
  }
  const verb = value.dryRun ? 'would apply' : 'applied'
  const lines = [`${value.dryRun ? 'Dry run: ' : ''}${verb} ${plural(value.applied.length, 'edit')} in ${plural(byFile.size, 'file')}.`]
  for (const [path, list] of byFile) {
    const detail = list.map(a => a.replaceAll ? `${a.count}× from line ${a.line}` : `line ${a.line}`).join(', ')
    lines.push(`  ${path}: ${plural(list.length, 'edit')} (${detail})`)
  }
  return lines.join('\n')
}

/**
 * @param {any} ctx
 */
export function createEditManyTool(ctx) {
  return defineTool({
    name: 'edit_many',
    description: 'Apply several literal text replacements — in one file or across many — in ONE call. Each entry is '
      + '{ file_path, old_string, new_string, replace_all? } with the same rules as `edit` (old_string must occur exactly once unless replace_all). '
      + 'ALL entries are validated first (file read this session, match found, unique) and reported together; nothing is written if any fails. '
      + 'Entries apply in order, so a later entry may match text produced by an earlier one. Files must have been read this session '
      + '(read or read_many). Use this instead of python/sed heredocs in bash.',
    parameters: {
      edits: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            file_path: { type: 'string', required: true, description: 'Path to edit (relative to the session workspace, absolute, or ~).' },
            old_string: { type: 'string', required: true, description: 'Literal text to replace. Must match exactly.' },
            new_string: { type: 'string', required: true, description: 'Literal replacement. Empty string deletes the match.' },
            replace_all: { type: 'boolean', description: 'Replace every occurrence (default false: exactly one required).' },
          },
        },
        description: `The edits, in application order (max ${MAX_EDITS}).`,
      },
      dry_run: { type: 'boolean', description: 'Validate only; report what would change without writing.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderEditMany(value) }],
      presentationMeta: (args, value) => ({
        diffs: value.dryRun ? [] : (Array.isArray(args.edits) ? args.edits : []).map(e => ({ path: String(e?.file_path ?? ''), oldText: String(e?.old_string ?? ''), newText: String(e?.new_string ?? '') })),
      }),
    },
    async execute(args, exec) {
      const input = parseEditManyArgs(args)
      const fs = requireFs(ctx)
      const call = callContext(ctx, exec)
      const { resolved, problems } = await validateEdits(fs, ctx, exec, input.edits, call)
      if (problems.length > 0) {
        throw new FsToolsError(`edit_many: ${plural(problems.length, 'problem')}, nothing written:\n${problems.map(p => `  ${p}`).join('\n')}`, 'EDIT_MANY_INVALID')
      }
      const applied = []
      if (input.dryRun) {
        for (const r of resolved) applied.push({ path: r.path, line: r.line, count: r.count, replaceAll: r.edit.replaceAll })
        return dropUndefined({ dryRun: true, applied, files: new Set(applied.map(a => a.path)).size })
      }
      for (const r of resolved) {
        try {
          const intent = await ctx.waterfall('fs/edit-intent', r.target, exec, () => undefined)
          const outcome = await fs.editText(
            r.target,
            { oldString: r.edit.oldString, newString: r.edit.newString, replaceAll: r.edit.replaceAll },
            intent,
            call.signal,
            call.policy,
          )
          ctx.emit('fs/observed', r.target, { kind: 'present', version: outcome.version }, exec)
          const before = normalize(outcome.before ?? '')
          const at = before.indexOf(normalize(r.edit.oldString))
          applied.push({ path: r.path, line: at >= 0 ? lineOf(before, at) : r.line, count: r.count, replaceAll: r.edit.replaceAll })
        } catch (error) {
          const mapped = mapFsError(error, r.path, call.policy)
          const done = applied.length > 0 ? `Applied before the failure: ${applied.map((a, i) => `#${resolved[i].edit.index + 1} ${a.path}:${a.line}`).join(', ')}. ` : 'Nothing was applied. '
          const left = resolved.slice(applied.length + 1).map(x => `#${x.edit.index + 1}`)
          throw new FsToolsError(
            `edit_many stopped at edit #${r.edit.index + 1}: ${mapped.message}\n${done}${left.length ? `Not applied: ${left.join(', ')}.` : ''}`,
            mapped.code,
            { cause: error },
          )
        }
      }
      return dropUndefined({ dryRun: false, applied, files: new Set(applied.map(a => a.path)).size })
    },
    presentCall: (args) => {
      const edits = Array.isArray(args.edits) ? args.edits : []
      const paths = [...new Set(edits.map(e => e?.file_path).filter(Boolean))]
      return {
        card: 'diff',
        title: `Edit ${paths.length === 1 ? paths[0] : plural(paths.length, 'file')} (${plural(edits.length, 'edit')})`,
        diffs: edits.map(e => ({ path: String(e?.file_path ?? ''), oldText: String(e?.old_string ?? '') || null, newText: String(e?.new_string ?? '') })),
        locations: paths.map(path => ({ path })),
      }
    },
    presentResult: (args, result) => {
      if (result.isError) return undefined
      const meta = result.meta
      const diffs = meta && Array.isArray(meta.diffs) ? meta.diffs : undefined
      if (!diffs || diffs.length === 0) return undefined
      const paths = [...new Set(diffs.map(d => d.path))]
      return { card: 'diff', title: `Edit ${paths.length === 1 ? paths[0] : plural(paths.length, 'file')} (${plural(diffs.length, 'edit')})`, diffs }
    },
  })
}

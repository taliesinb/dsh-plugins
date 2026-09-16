/**
 * tali-fs-tools — batch filesystem tools registered BESIDE the in-tree
 * read/edit/grep/glob, aimed at the four bash habits the transcript corpus
 * showed (rsi/tool-analysis-02-validation.md): python heredoc edits (555),
 * `sed -n` range reads (485), `ls`/`tree` (568) and bash `grep` (918).
 *
 *   list_dir    directories included, several roots, bounded depth, sizes
 *   read_many   several files / line ranges per call; emits fs/observed so the
 *               read-before-edit guard treats it like `read`
 *   edit_many   several literal replacements across files; everything is
 *               validated (guard, match, uniqueness) before anything is written
 *   search      ripgrep with context, files/count modes, several roots and
 *               patterns, include/exclude globs, exclude_pattern, -i, -F
 *
 * All four go through ctx.fs (sandbox + observation policy apply exactly as for
 * the built-ins); `search` spawns the packaged ripgrep through ctx.subprocess.
 * Tools are global (stateless), so subagents see them too.
 *
 * Config (all optional):
 *
 *   readLimit: 2000          # max lines per read_many entry (and its default)
 *   readTotalLimit: 4000     # default total line budget of one read_many call
 *   readMaxLineLength: 2000  # characters kept per line
 *   listMaxEntries: 300      # default row cap of list_dir
 *   searchMaxResults: 250    # default cap of search
 *   searchTimeoutMs: 30000   # cooperative budget of one search
 *   promptHint: true         # add a short system-prompt section steering the model to these tools
 */

import Schema from '@deepseek-ai/schemastery'
import { createListDirTool } from './list-dir.mjs'
import { createReadManyTool } from './read-many.mjs'
import { createEditManyTool } from './edit-many.mjs'
import { createSearchTool } from './search.mjs'

export const name = 'fs-tools'

// `subprocess` and `sandboxPolicy` are looked up per call with ctx.get (optional).
export const inject = ['tools', 'fs', 'systemPrompt']

export const Config = Schema.object({
  readLimit: Schema.number().min(50).default(2000),
  readTotalLimit: Schema.number().min(50).default(4000),
  readMaxLineLength: Schema.number().min(80).default(2000),
  listMaxEntries: Schema.number().min(10).default(300),
  searchMaxResults: Schema.number().min(10).default(250),
  searchTimeoutMs: Schema.number().min(1000).default(30_000),
  promptHint: Schema.boolean().default(true),
})

/** Build the tool definitions for a config (shared by apply and tests). */
export function build(ctx, config) {
  return [
    createListDirTool(ctx, { maxEntries: config.listMaxEntries }),
    createReadManyTool(ctx, { limit: config.readLimit, totalLimit: config.readTotalLimit, maxLineLength: config.readMaxLineLength }),
    createEditManyTool(ctx),
    createSearchTool(ctx, { maxResults: config.searchMaxResults, timeoutMs: config.searchTimeoutMs }),
  ]
}

export const PROMPT_HINT = 'Batch filesystem tools: use list_dir (not ls/tree) to explore directories; read_many (not sed -n/cat/head) to read '
  + 'several files or ranges in one call; edit_many (not python/sed heredocs) to apply several literal replacements across files in one '
  + 'validated call — read_many counts as reading for its read-before-edit guard; search (not grep/rg) for content search with context, '
  + 'files-only/count modes, include/exclude globs and several roots. Prefer bash `workdir` over `cd X &&` prefixes; the session cwd is '
  + 'the workspace root.'

export function apply(ctx, config) {
  const tools = build(ctx, config)
  for (const tool of tools) ctx.tools.register(tool)
  if (config.promptHint && ctx.systemPrompt) {
    ctx.systemPrompt.section({
      name: 'tool:fs-tools',
      order: ctx.systemPrompt.getSectionOrder('TOOL_GREP') + 1,
      text: ({ scope }) => ctx.tools.get('edit_many', scope) === undefined ? '' : PROMPT_HINT,
    })
  }
  ctx.logger.info(`fs-tools: registered ${tools.map(t => t.name).join(', ')}`)
}

/**
 * tali-session-introspect — read other agents' DSH session transcripts from
 * inside a session, through `ctx.sessionQuery` (never the zstd logs):
 *
 *   transcript_find         sessions by workspace/title/id/age (no log reads)
 *   transcript_outline      per-turn table of contents with seq ranges
 *   transcript_read         compact timeline of a turn / seq range (or raw events)
 *   transcript_tool_stats   per-tool errors, latency, top error messages, what-happened-next
 *   transcript_grep         regex over prompts, assistant text, tool args/results
 *   transcript_event        one full raw event by seq
 *
 * Every tool takes `fmt` (text | json | jsonl) and `out_file` (write the
 * complete rendering through ctx.fs under the session's sandbox mode).
 * Tools are registered globally (read-only, no per-session state), so every
 * agent, including subagents, sees them. Design and evidence:
 * <plugins>/recipes/session-introspect-design.md.
 *
 * Config (all optional):
 *
 *   scope: all                 # all | workspace — which sessions are visible (workspace = same cwd as the caller only)
 *   maxChars: 24000            # inline rendering budget before rows are omitted (out_file lifts it)
 *   maxResultChars: 400        # excerpt length per tool result / message in transcript_read
 *   findLimit: 20              # default rows of transcript_find
 *   grepLimit: 50              # default hits of transcript_grep
 *   traceFile: ''              # append JSON lifecycle lines here ('' = off)
 */

import { appendFileSync } from 'node:fs'
import Schema from '@deepseek-ai/schemastery'
import { createResolver } from './resolve.mjs'
import { createTools } from './tools.mjs'

export const name = 'session-introspect'

export const inject = ['tools', 'sessionQuery']

export const Config = Schema.object({
  scope: Schema.union(['all', 'workspace']).default('all'),
  maxChars: Schema.number().min(2000).default(24_000),
  maxResultChars: Schema.number().min(40).default(400),
  findLimit: Schema.number().min(1).max(500).default(20),
  grepLimit: Schema.number().min(1).max(1000).default(50),
  traceFile: Schema.string().default(''),
})

/** Build resolver + tool definitions for a config (shared by apply and tests). */
export function build(ctx, config) {
  const trace = config.traceFile
    ? (line) => { try { appendFileSync(config.traceFile, `${JSON.stringify({ t: new Date().toISOString(), ...line })}\n`) } catch { /* ignore */ } }
    : () => {}
  const resolver = createResolver(ctx, { scope: config.scope, trace })
  const tools = createTools({
    ctx,
    resolver,
    limits: { maxChars: config.maxChars, maxResultChars: config.maxResultChars, findLimit: config.findLimit, grepLimit: config.grepLimit },
    trace,
  })
  return { resolver, tools, trace }
}

export function apply(ctx, config) {
  const { tools, trace } = build(ctx, config)
  for (const tool of tools) ctx.tools.register(tool)
  trace({ event: 'registered', tools: tools.map(tool => tool.name), scope: config.scope })
  ctx.logger.info(`session-introspect: registered ${tools.map(tool => tool.name).join(', ')} (scope ${config.scope})`)
}

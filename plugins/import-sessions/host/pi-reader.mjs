/**
 * pi transcript → DSH events (through EventBuilder).
 *
 * pi (`~/.pi/agent/sessions/--<path>--/<ts>_<uuid>.jsonl`, format version 3)
 * writes a header line then a TREE of records linked by `parentId`: edits and
 * regenerations create sibling branches. We import the MAIN branch only — the
 * path from the root to the leaf with the latest timestamp — and count the
 * records left on abandoned branches.
 *
 * Record types:
 *   session                 header {id, timestamp, cwd}
 *   model_change            {provider, modelId}      → remembered for assistant messages that lack them
 *   thinking_level_change   dropped (counted)
 *   message                 role user | assistant | toolResult
 *     user.content          string | [{type:'text'} | {type:'image', data, mimeType}]
 *     assistant.content     [{type:'thinking'} | {type:'text'} | {type:'toolCall', id, name, arguments}]
 *       + provider, model, usage {input, output, cacheRead, cacheWrite}, stopReason, errorMessage
 *     toolResult            {toolCallId, toolName, content:[text|image], isError}
 *   compaction              {summary}  → DSH compaction bracket replacing everything before it on the surface
 *   session_info            {name}     → session title (last wins)
 *   custom / custom_message extension bookkeeping (checkpoints, web-search caches…) → dropped (counted)
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { EventBuilder } from './events.mjs'

function recordTime(rec) {
  const t = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : typeof rec.timestamp === 'number' ? rec.timestamp : Number.NaN
  if (Number.isFinite(t)) return t
  const mt = rec.message?.timestamp
  return typeof mt === 'number' ? mt : Number.NaN
}

function mapUsage(usage) {
  if (usage === null || typeof usage !== 'object') return null
  const out = { inputTokens: Number(usage.input ?? 0), outputTokens: Number(usage.output ?? 0) }
  if (Number.isFinite(usage.cacheRead)) out.cacheReadTokens = usage.cacheRead
  if (Number.isFinite(usage.cacheWrite)) out.cacheWriteTokens = usage.cacheWrite
  if (Number.isFinite(usage.reasoning)) out.reasoningTokens = usage.reasoning
  out.totalTokens = Number.isFinite(usage.totalTokens) ? usage.totalTokens : out.inputTokens + out.outputTokens + (out.cacheReadTokens ?? 0) + (out.cacheWriteTokens ?? 0)
  return out
}

async function mapBlocks(builder, content, sink) {
  if (typeof content === 'string') { if (content !== '') sink.push({ type: 'text', text: content }); return }
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string' && block.text !== '') sink.push({ type: 'text', text: block.text })
        break
      case 'thinking':
        if (typeof block.thinking === 'string' && block.thinking !== '') sink.push({ type: 'reasoning', text: block.thinking })
        break
      case 'toolCall':
        sink.push({ type: 'tool-call', id: String(block.id ?? ''), name: String(block.name ?? 'unknown'), arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}) })
        break
      case 'image':
        sink.push(await builder.imageBlock(block.data, block.mimeType ?? block.mediaType, block.name))
        break
      default:
        builder.drop(`block:${String(block.type)}`)
        sink.push({ type: 'text', text: `[unsupported block: ${String(block.type)}]` })
    }
  }
}

/**
 * Parse the file and select the main branch.
 * @returns {Promise<{header: object|undefined, branch: object[], total: number, offBranch: number}>}
 */
export async function readPiTree(file) {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  let header
  const records = []
  for await (const line of rl) {
    if (line.trim() === '') continue
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    if (rec.type === 'session') { header ??= rec; continue }
    records.push(rec)
  }
  if (records.length === 0) return { header, branch: [], total: 0, offBranch: 0 }
  const byId = new Map()
  const hasChild = new Set()
  for (const rec of records) {
    if (typeof rec.id === 'string') byId.set(rec.id, rec)
    if (typeof rec.parentId === 'string') hasChild.add(rec.parentId)
  }
  // Leaves: records nobody points to. Pick the latest by timestamp (file order breaks ties).
  let leaf = null
  let leafIndex = -1
  records.forEach((rec, index) => {
    if (typeof rec.id !== 'string' || hasChild.has(rec.id)) return
    const t = recordTime(rec)
    const lt = leaf === null ? -Infinity : recordTime(leaf)
    if (leaf === null || (Number.isFinite(t) && t > lt) || (t === lt && index > leafIndex)) { leaf = rec; leafIndex = index }
  })
  const branch = []
  const seen = new Set()
  let cursor = leaf
  while (cursor !== null && cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor)
    branch.push(cursor)
    cursor = typeof cursor.parentId === 'string' ? byId.get(cursor.parentId) ?? null : null
  }
  branch.reverse()
  // Records without ids (defensive: older formats) are kept in file order.
  const idless = records.filter(r => typeof r.id !== 'string')
  const ordered = idless.length === 0 ? branch : [...branch, ...idless].sort((a, b) => records.indexOf(a) - records.indexOf(b))
  return { header, branch: ordered, total: records.length, offBranch: records.length - ordered.length }
}

/**
 * Read one pi transcript into a builder.
 * @param {string} file
 * @param {object} options
 * @param {string} options.sessionId
 * @param {number} [options.resultCap]
 * @param {(bytes: Uint8Array, mediaType: string, name?: string) => Promise<object|null>} [options.saveImage]
 * @param {(message: object) => number} [options.estimate] - token estimator for pi's own compaction records
 * @returns {Promise<{builder: EventBuilder, header: object|undefined, cwd: string|undefined, title: string|undefined, offBranch: number}>}
 */
export async function readPiSession(file, { sessionId, resultCap = 0, saveImage, estimate } = {}) {
  const { header, branch, offBranch } = await readPiTree(file)
  const builder = new EventBuilder({ sessionId, resultCap, saveImage })
  if (offBranch > 0) builder.drop('off-branch', offBranch)
  let provider = 'unknown'
  let model = 'unknown'
  let title
  const headerTime = header?.timestamp !== undefined ? Date.parse(header.timestamp) : Number.NaN
  if (Number.isFinite(headerTime)) builder.at(headerTime)

  for (const rec of branch) {
    const parsed = recordTime(rec)
    const at = Number.isFinite(parsed) ? parsed : builder.lastTime
    switch (rec.type) {
      case 'model_change':
        if (typeof rec.provider === 'string') provider = rec.provider
        if (typeof rec.modelId === 'string') model = rec.modelId
        builder.drop('model_change')
        break
      case 'session_info':
        if (typeof rec.name === 'string' && rec.name !== '') title = rec.name
        builder.drop('session_info')
        break
      case 'compaction': {
        // pi replaced its own context with `summary` here: mirror that on the DSH surface.
        builder.endTurn(at)
        const summary = typeof rec.summary === 'string' ? rec.summary : ''
        if (summary !== '' && builder.surface().length > 0) {
          builder.replaceSurface(at, {
            cut: () => true,
            note: `Context compacted by pi at this point of the imported transcript. Summary pi carried forward:\n\n${summary}`,
            source: { kind: 'plugin', plugin: 'tali-import-sessions/pi-compaction' },
            estimate,
          })
          builder.stats.foldedTurns = builder.turn
        } else {
          builder.drop('compaction-empty')
        }
        break
      }
      case 'message': {
        const m = rec.message
        if (m === null || typeof m !== 'object') { builder.drop('message-malformed'); break }
        const mt = typeof m.timestamp === 'number' ? m.timestamp : at
        if (m.role === 'user') {
          const out = []
          await mapBlocks(builder, m.content, out)
          builder.userMessage(mt, out, rec.id ?? `${sessionId}:${builder.seq}`)
        } else if (m.role === 'assistant') {
          const out = []
          await mapBlocks(builder, m.content, out)
          if (m.stopReason === 'error' && typeof m.errorMessage === 'string' && m.errorMessage !== '') {
            out.push({ type: 'text', text: `[provider error: ${m.errorMessage}]` })
          }
          if (out.length === 0 && m.stopReason === 'aborted') { builder.drop('assistant-aborted-empty'); break }
          builder.assistantMessage(mt, {
            content: out,
            key: rec.id ?? `${sessionId}:${builder.seq}`,
            provider: typeof m.provider === 'string' ? m.provider : provider,
            model: typeof m.model === 'string' ? m.model : model,
            usage: mapUsage(m.usage),
          })
          if (m.stopReason === 'aborted') builder.interrupted(mt)
        } else if (m.role === 'toolResult') {
          const out = []
          await mapBlocks(builder, m.content, out)
          builder.toolResult(mt, { callId: String(m.toolCallId ?? ''), content: out, isError: m.isError === true, key: rec.id ?? `${sessionId}:${builder.seq}` })
        } else {
          builder.drop(`message-role:${String(m.role)}`)
        }
        break
      }
      default:
        builder.drop(rec.type ?? 'unknown')
    }
  }
  if (title !== undefined) builder.title(title)
  return { builder, header, cwd: header?.cwd, title, offBranch }
}

/**
 * Claude Code transcript → DSH events (through EventBuilder).
 *
 * Claude Code writes ONE RECORD PER CONTENT BLOCK, not one per message: a
 * model response is a run of consecutive `assistant` records sharing one
 * `message.id` (thinking, then text, then one record per tool_use). Those runs
 * are grouped back into one assistant message (one DSH step); otherwise every
 * tool_use lands in its own step and its tool_result becomes an orphan.
 * Records are deduplicated by `uuid` (unique per record) and NEVER by
 * `message.id` (shared across a response's records).
 *
 * Mapping:
 *   user record (real prompt text / images)  → turn/start + user/message
 *   `[Request interrupted by user…]`          → turn/end {kind:'interrupted'}
 *   assistant run (one message.id)           → step/start + assistant/message (+usage) + tool/call per tool_use
 *     thinking / redacted_thinking             → {type:'reasoning'}
 *     text                                     → {type:'text'}
 *     tool_use                                 → {type:'tool-call'}
 *   user record with tool_result blocks      → tool/result (paired by tool_use_id in the open step)
 *   image blocks                             → ImageBlock via the attachments hook (or placeholder)
 *   ai-title / summary                       → session title
 *
 * Dropped (counted): attachment, system, file-history-*, bridge-session, mode,
 * permission-mode, last-prompt, queue-operation, isMeta records, injected
 * context texts (<system-reminder>, hook outputs, task notifications…),
 * sidechain records in the ROOT transcript (older Claude versions inlined the
 * subagent transcript there; newer ones write <sessionId>/subagents/agent-*.jsonl,
 * which `listClaudeSubagents` finds and the importer turns into child sessions).
 */
import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { EventBuilder } from './events.mjs'
import { isInjectedText } from './sources.mjs'

const INTERRUPT_MARKER = /^\[Request interrupted by user/

/** Claude usage → DSH usage keys. */
function mapUsage(usage) {
  if (usage === null || typeof usage !== 'object') return null
  const out = {
    inputTokens: Number(usage.input_tokens ?? 0),
    outputTokens: Number(usage.output_tokens ?? 0),
  }
  if (Number.isFinite(usage.cache_read_input_tokens)) out.cacheReadTokens = usage.cache_read_input_tokens
  if (Number.isFinite(usage.cache_creation_input_tokens)) out.cacheWriteTokens = usage.cache_creation_input_tokens
  out.totalTokens = out.inputTokens + out.outputTokens + (out.cacheReadTokens ?? 0) + (out.cacheWriteTokens ?? 0)
  return out
}

/** Map one Claude content block to DSH blocks (async because of images). */
async function mapBlock(builder, block, sink) {
  if (typeof block === 'string') { if (block !== '') sink.push({ type: 'text', text: block }); return }
  if (block === null || typeof block !== 'object') return
  switch (block.type) {
    case 'text':
      if (typeof block.text === 'string' && block.text !== '') sink.push({ type: 'text', text: block.text })
      break
    case 'thinking':
    case 'redacted_thinking':
      if (typeof block.thinking === 'string' && block.thinking !== '') sink.push({ type: 'reasoning', text: block.thinking })
      else if (block.type === 'redacted_thinking') sink.push({ type: 'reasoning', text: '[redacted thinking block]' })
      break
    case 'image': {
      const src = block.source ?? {}
      if (src.type === 'base64' || typeof src.data === 'string') sink.push(await builder.imageBlock(src.data, src.media_type))
      else if (typeof src.url === 'string') sink.push({ type: 'text', text: `[image: ${src.url}]` })
      else sink.push({ type: 'text', text: '[image not imported]' })
      break
    }
    case 'tool_use':
      sink.push({ type: 'tool-call', id: String(block.id ?? ''), name: String(block.name ?? 'unknown'), arguments: JSON.stringify(block.input ?? {}) })
      break
    case 'tool_result': {
      // Handled by the caller (needs the callId); flatten its content here.
      const inner = []
      const raw = block.content
      if (typeof raw === 'string') inner.push({ type: 'text', text: raw })
      else if (Array.isArray(raw)) for (const b of raw) await mapBlock(builder, b, inner)
      sink.push({ type: '__tool_result', callId: String(block.tool_use_id ?? ''), content: inner, isError: block.is_error === true })
      break
    }
    default:
      builder.drop(`block:${String(block.type)}`)
      sink.push({ type: 'text', text: `[unsupported block: ${String(block.type)}]` })
  }
}

/** Subagent transcripts of a root Claude session file. */
export async function listClaudeSubagents(file) {
  const id = basename(file, '.jsonl')
  const dir = join(resolve(file, '..'), id, 'subagents')
  try {
    const entries = await readdir(dir)
    return entries.filter(n => /^agent-.*\.jsonl$/.test(n)).sort().map(n => join(dir, n))
  } catch {
    return []
  }
}

/**
 * Read one Claude Code transcript into a builder.
 * @param {string} file
 * @param {object} options
 * @param {string} options.sessionId - DSH id for the resulting session
 * @param {number} [options.resultCap]
 * @param {(bytes: Uint8Array, mediaType: string, name?: string) => Promise<object|null>} [options.saveImage]
 * @param {boolean} [options.child] - reading a subagent transcript (sidechain records are the content, not noise)
 * @param {(progress: {lines:number}) => void} [options.onProgress]
 * @returns {Promise<{builder: EventBuilder, cwd: string|undefined, title: string|undefined, agentId: string|undefined}>}
 */
export async function readClaudeSession(file, { sessionId, resultCap = 0, saveImage, child = false, onProgress } = {}) {
  const builder = new EventBuilder({ sessionId, resultCap, saveImage })
  const stats = builder.stats
  const seenUuid = new Set()
  let cwd
  let title
  let agentId
  let lines = 0
  /** @type {{ messageId: string, model: string, blocks: object[], usage: object|null } | null} */
  let pendingAssistant = null

  const flushAssistant = async (at) => {
    const msg = pendingAssistant
    pendingAssistant = null
    if (msg === null) return
    const content = []
    for (const block of msg.blocks) await mapBlock(builder, block, content)
    if (content.some(b => b.type === '__tool_result')) builder.drop('assistant-tool-result-block')
    builder.assistantMessage(at, {
      content: content.filter(b => b.type !== '__tool_result'),
      key: msg.messageId,
      provider: 'anthropic',
      model: msg.model,
      usage: msg.usage,
    })
  }

  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of rl) {
    lines++
    if (onProgress !== undefined && lines % 2000 === 0) onProgress({ lines })
    if (line.trim() === '') continue
    let rec
    try { rec = JSON.parse(line) } catch { builder.drop('unparsable'); continue }
    const type = rec.type ?? '?'
    const parsed = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : Number.NaN
    const at = Number.isFinite(parsed) ? parsed : builder.lastTime

    if (typeof rec.cwd === 'string' && cwd === undefined) cwd = rec.cwd
    if (typeof rec.agentId === 'string' && agentId === undefined) agentId = rec.agentId

    if (type === 'ai-title') {
      if (typeof rec.aiTitle === 'string' && rec.aiTitle !== '') title ??= rec.aiTitle
      builder.drop('ai-title')
      continue
    }
    if (type === 'summary') {
      if (typeof rec.summary === 'string' && rec.summary !== '') title ??= rec.summary
      builder.drop('summary')
      continue
    }
    if (type !== 'user' && type !== 'assistant') { builder.drop(type); continue }

    if (typeof rec.uuid === 'string') {
      if (seenUuid.has(rec.uuid)) { stats.duplicateRecords++; continue }
      seenUuid.add(rec.uuid)
    }
    if (!child && rec.isSidechain === true) { builder.drop('sidechain'); continue }

    const content = rec.message?.content
    const blocks = Array.isArray(content) ? content : (typeof content === 'string' ? [{ type: 'text', text: content }] : [])

    if (type === 'assistant') {
      if (rec.isMeta === true) { builder.drop('assistant-meta'); continue }
      const messageId = String(rec.message?.id ?? rec.uuid ?? `${sessionId}:${builder.seq}`)
      if (pendingAssistant !== null && pendingAssistant.messageId !== messageId) await flushAssistant(at)
      if (pendingAssistant === null) {
        pendingAssistant = { messageId, model: String(rec.message?.model ?? 'claude'), blocks: [], usage: mapUsage(rec.message?.usage) }
      }
      pendingAssistant.blocks.push(...blocks)
      continue
    }

    // type === 'user': the assistant run it answers is complete.
    await flushAssistant(at)

    const promptBlocks = []
    const toolResults = []
    for (const b of blocks) {
      if (b?.type === 'tool_result') toolResults.push(b)
      else if (b?.type === 'text') { if (typeof b.text === 'string' && b.text.trim() !== '' && !isInjectedText(b.text)) promptBlocks.push(b) } else if (b?.type === 'image') promptBlocks.push(b)
      else if (b !== null && b !== undefined) builder.drop(`user-block:${String(b?.type)}`)
    }

    // 1. tool results pair into the step opened by the assistant run they answer.
    for (const b of toolResults) {
      const sink = []
      await mapBlock(builder, b, sink)
      const tr = sink.find(x => x.type === '__tool_result')
      if (tr === undefined) continue
      builder.toolResult(at, { callId: tr.callId, content: tr.content, isError: tr.isError, key: rec.uuid ?? `${sessionId}:${builder.seq}` })
    }

    // 2. a genuine prompt opens a new turn; a cancel marker closes the open one.
    if (promptBlocks.length > 0) {
      if (rec.isMeta === true) { builder.drop('user-meta'); continue }
      const real = promptBlocks.filter(b => !(b.type === 'text' && INTERRUPT_MARKER.test(b.text.trim())))
      if (real.length === 0) { builder.interrupted(at); continue }
      const out = []
      for (const b of real) await mapBlock(builder, b, out)
      builder.userMessage(at, out, rec.uuid ?? `${sessionId}:${builder.seq}`)
    } else if (toolResults.length === 0) {
      builder.drop('user-empty')
    }
  }
  await flushAssistant(builder.lastTime)
  if (title !== undefined) builder.title(title)
  return { builder, cwd, title, agentId }
}

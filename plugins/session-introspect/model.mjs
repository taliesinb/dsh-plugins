/**
 * model.mjs — normalize one decoded session log (the `SessionLogSnapshot`
 * shape `ctx.sessionQuery.readSession()` returns: `{ session, events }`) into
 * the structures every tool renders from:
 *
 *   rows    one timeline row per model-relevant event, in seq order
 *   calls   tool calls paired with their results (latency, ok/error, text)
 *   turns   per-turn summary (seq range, prompt, tool counts, how it ended)
 *
 * Pure: no I/O, no Cordis. Event shapes are the current (v3) logical format;
 * the persistence backend translates historical generations before we see
 * them, so nothing here knows about format versions.
 */

import { basename } from 'node:path'

/** Event types that carry nothing a transcript reader needs; hidden unless asked for raw events. */
const HIDDEN_TYPES = new Set([
  'step/start', 'step/end', 'system/message', 'request/header', 'request/context',
  'session/title-llm-request', 'session/end-seed', 'permission/preset', 'sandbox/mode',
  'approval/policy', 'agent/inbox/spliced', 'todo/write', 'command/done', 'assistant/attempt',
])

/**
 * @param {string | undefined} cwd
 * @returns {string} the workspace label: the cwd's basename (`tensatory`), or `?` when the session has none.
 */
export function workspaceOf(cwd) {
  if (cwd === undefined || cwd === '') return '?'
  return basename(cwd) || cwd
}

/**
 * Text of a content-block array (text blocks joined by newlines; other blocks ignored).
 * @param {unknown} content
 */
export function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Image descriptors of a content-block array: `{ w, h, type, bytes, name }`.
 * Current logs store images as attachment references (no inline bytes); an
 * inline base64 `source`/`data` is summarized by its size and never copied.
 * @param {unknown} content
 */
export function imagesOf(content) {
  if (!Array.isArray(content)) return []
  const images = []
  for (const block of content) {
    if (!block || typeof block !== 'object' || block.type !== 'image') continue
    const att = block.attachment
    if (att && typeof att === 'object') {
      images.push({
        w: att.width ?? null,
        h: att.height ?? null,
        type: mediaSubtype(att.mediaType),
        bytes: att.bytes ?? null,
        ...att.name ? { name: att.name } : {},
      })
      continue
    }
    const data = typeof block.data === 'string' ? block.data : (block.source && typeof block.source.data === 'string' ? block.source.data : '')
    images.push({ w: null, h: null, type: mediaSubtype(block.mediaType ?? block.source?.media_type ?? block.source?.mediaType), bytes: data ? Math.floor(data.length * 3 / 4) : null })
  }
  return images
}

function mediaSubtype(mediaType) {
  if (typeof mediaType !== 'string') return 'image'
  return mediaType.replace(/^image\//, '') || 'image'
}

/**
 * The tool-result blocks of a `tool/result` message: `{ ok, text, images }`.
 * @param {any} data - the event's `data`
 */
function resultParts(data) {
  const blocks = Array.isArray(data.message?.content) ? data.message.content : []
  let ok = true
  const texts = []
  const images = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || block.type !== 'tool-result') continue
    if (block.isError === true) ok = false
    const inner = block.content
    if (typeof inner === 'string') texts.push(inner)
    else {
      const t = textOf(inner)
      if (t !== '') texts.push(t)
      images.push(...imagesOf(inner))
    }
  }
  if (data.error) ok = false
  return { ok, text: texts.join('\n'), images }
}

/**
 * Classify a `user/message` by its source: a human prompt, a compaction
 * checkpoint, AGENTS.md-style instructions, or a plugin injection.
 * @param {any} data
 */
function userKind(data) {
  const kind = data.source?.kind
  if (data.surfaceOp && typeof data.surfaceOp === 'object') return 'checkpoint'
  if (typeof kind === 'string' && kind.includes('compact')) return 'checkpoint'
  if (kind === 'user' || kind === undefined) return 'user'
  if (kind === 'agent-instructions') return 'instructions'
  return 'inject'
}

/**
 * Normalize one turn-end reason into `{ kind, code?, message? }`.
 * @param {any} reason
 */
function endedOf(reason) {
  if (!reason || typeof reason !== 'object') return { kind: 'unknown' }
  const out = { kind: typeof reason.kind === 'string' ? reason.kind : 'unknown' }
  const err = reason.error
  if (err && typeof err === 'object') {
    if (typeof err.code === 'string') out.code = err.code
    if (typeof err.message === 'string') out.message = err.message
  }
  if (reason.kind === 'aborted' && reason.reason && typeof reason.reason === 'object') out.message = `cancelled by ${reason.reason.kind}`
  return out
}

/**
 * Build the normalized model of one session.
 * @param {{ session: any, events: any[] }} snapshot - `readSession()` result (header + complete raw log)
 * @param {{ live?: boolean, title?: string }} [meta] - facts the caller knows from the listing
 */
export function buildModel(snapshot, meta = {}) {
  const header = snapshot.session ?? {}
  const events = Array.isArray(snapshot.events) ? snapshot.events : []
  const rows = []
  const calls = []
  const byCallId = new Map()
  const turns = []
  const turnsByNumber = new Map()
  let title = meta.title
  let model = null
  let current = null // current turn record

  const startTurn = (turn, seq, time) => {
    const rec = {
      turn, seqFrom: seq, seqTo: seq, startTime: time, endTime: time, ms: 0, steps: 0,
      prompt: '', promptSeq: null, ended: null, calls: [], errors: 0, retries: 0, toolCounts: new Map(), lastAssistant: '',
      tokens: { output: 0, input: 0, cacheRead: 0, contextEnd: null },
    }
    turns.push(rec)
    turnsByNumber.set(turn, rec)
    current = rec
    return rec
  }
  const turnFor = (event) => {
    const n = event.data?.turn
    if (typeof n === 'number') {
      const known = turnsByNumber.get(n)
      if (known) return known
      return startTurn(n, event.seq, event.time)
    }
    return current
  }
  const push = (row) => { rows.push(row); return row }

  for (const event of events) {
    const { type, seq, time } = event
    const data = event.data ?? {}
    const base = { seq, time }
    switch (type) {
      case 'turn/start': {
        const rec = turnsByNumber.get(data.turn) ?? startTurn(data.turn, seq, time)
        rec.seqFrom = Math.min(rec.seqFrom, seq)
        current = rec
        push({ ...base, kind: 'turn-start', turn: data.turn })
        break
      }
      case 'turn/end': {
        const rec = turnFor(event)
        if (rec) {
          rec.ended = endedOf(data.reason)
          rec.endTime = time
          rec.seqTo = seq
          rec.ms = Math.max(0, time - rec.startTime)
        }
        push({ ...base, kind: 'turn-end', turn: data.turn, ended: rec?.ended ?? endedOf(data.reason), ms: rec?.ms ?? 0 })
        break
      }
      case 'step/start': {
        const rec = turnFor(event)
        if (rec) rec.steps += 1
        break
      }
      case 'user/message': {
        const rec = current
        const kind = userKind(data)
        const text = textOf(data.content)
        const images = imagesOf(data.content)
        const row = push({ ...base, kind, turn: rec?.turn ?? null, text, images })
        if (kind === 'inject' || kind === 'instructions') row.plugin = data.source?.plugin ?? data.source?.kind ?? ''
        if (kind === 'user' && rec && rec.prompt === '') { rec.prompt = text; rec.promptSeq = seq }
        break
      }
      case 'assistant/message': {
        const rec = turnFor(event)
        const content = Array.isArray(data.message?.content) ? data.message.content : []
        const usage = data.usage
        if (rec && usage && typeof usage === 'object') {
          rec.tokens.output += usage.outputTokens ?? 0
          rec.tokens.input += usage.inputTokens ?? 0
          rec.tokens.cacheRead += usage.cacheReadTokens ?? 0
          if (typeof usage.totalTokens === 'number') rec.tokens.contextEnd = usage.totalTokens
        }
        const reasoning = content.filter(b => b?.type === 'reasoning' && typeof b.text === 'string' && b.text !== '').map(b => b.text).join('\n')
        const text = textOf(content)
        if (reasoning !== '') push({ ...base, kind: 'reasoning', turn: rec?.turn ?? null, step: data.step ?? null, text: reasoning })
        if (text !== '') {
          push({ ...base, kind: 'assistant', turn: rec?.turn ?? null, step: data.step ?? null, text })
          if (rec) rec.lastAssistant = text
        }
        break
      }
      case 'tool/call': {
        const rec = turnFor(event)
        let argsObj = null
        if (typeof data.arguments === 'string') { try { argsObj = JSON.parse(data.arguments) } catch { argsObj = null } }
        else if (data.arguments && typeof data.arguments === 'object') argsObj = data.arguments
        const call = {
          seq, time, turn: rec?.turn ?? null, step: data.step ?? null, tool: data.name ?? '?', callId: data.callId ?? null,
          args: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {}), argsObj,
          resultSeq: null, resultTime: null, ms: null, ok: null, code: null, reason: null, text: '', images: [],
        }
        calls.push(call)
        if (call.callId) byCallId.set(call.callId, call)
        if (rec) {
          rec.calls.push(call)
          const tc = rec.toolCounts.get(call.tool) ?? { count: 0, errors: 0 }
          tc.count += 1
          rec.toolCounts.set(call.tool, tc)
        }
        push({ ...base, kind: 'call', turn: call.turn, step: call.step, tool: call.tool, callId: call.callId, args: call.args, call })
        break
      }
      case 'tool/result': {
        const rec = turnFor(event)
        const callId = data.message?.source?.callId ?? data.callId ?? null
        const call = callId ? byCallId.get(callId) : undefined
        const parts = resultParts(data)
        const row = push({
          ...base, kind: 'result', turn: rec?.turn ?? null, step: data.step ?? null, tool: call?.tool ?? '?', callId,
          ok: parts.ok, code: data.error?.code ?? null, reason: data.error?.reason ?? null, text: parts.text, images: parts.images,
          ms: call ? Math.max(0, time - call.time) : null, call: call ?? null,
        })
        if (call) {
          call.resultSeq = seq
          call.resultTime = time
          call.ms = row.ms
          call.ok = parts.ok
          call.code = row.code
          call.reason = row.reason
          call.text = parts.text
          call.images = parts.images
          if (!parts.ok && rec) {
            rec.errors += 1
            const tc = rec.toolCounts.get(call.tool)
            if (tc) tc.errors += 1
          }
        }
        break
      }
      case 'session/title': {
        if (typeof data.title === 'string') title = data.title
        push({ ...base, kind: 'title', text: data.title ?? '' })
        break
      }
      case 'request/header': {
        const config = data.header?.config
        if (config && typeof config === 'object') model = { provider: config.provider ?? null, model: config.model ?? null }
        break
      }
      case 'request/context': {
        if (model === null && (data.provider || data.model)) model = { provider: data.provider ?? null, model: data.model ?? null }
        break
      }
      case 'approval/asked':
      case 'approval/decided': {
        push({ ...base, kind: 'approval', turn: current?.turn ?? null, text: `${type.slice('approval/'.length)} ${compactJson(data)}` })
        break
      }
      case 'llm/retry':
      case 'llm/retry-started': {
        if (current) current.retries += type === 'llm/retry' ? 1 : 0
        push({ ...base, kind: 'retry', turn: current?.turn ?? null, text: `${type} ${compactJson(data)}` })
        break
      }
      case 'command/run': {
        push({ ...base, kind: 'command', turn: current?.turn ?? null, text: `/${data.name ?? '?'}${typeof data.args === 'string' ? data.args : ''}` })
        break
      }
      default: {
        if (!HIDDEN_TYPES.has(type)) push({ ...base, kind: 'other', turn: current?.turn ?? null, type, text: compactJson(data) })
      }
    }
    if (current && seq > current.seqTo && current.ended === null) current.seqTo = seq
  }

  // A turn still open at the end of the log (live session, or crash before the closer).
  for (const rec of turns) {
    if (rec.ended === null) {
      const last = events.at(-1)
      rec.endTime = last?.time ?? rec.startTime
      rec.ms = Math.max(0, rec.endTime - rec.startTime)
      rec.ended = { kind: 'open' }
    }
  }

  const errors = calls.filter(c => c.ok === false).length
  return {
    id: header.id ?? '?',
    header,
    cwd: header.cwd,
    workspace: workspaceOf(header.cwd),
    title: title ?? null,
    createdAt: header.createdAt ?? null,
    live: meta.live === true,
    model,
    events,
    rows,
    calls,
    turns,
    stats: { events: events.length, turns: turns.length, calls: calls.length, errors },
  }
}

/**
 * Compact one-line JSON for incidental event payloads.
 * @param {unknown} value
 * @param {number} [max]
 */
export function compactJson(value, max = 300) {
  let s
  try { s = JSON.stringify(value) } catch { s = String(value) }
  if (s === undefined) s = ''
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/**
 * `{ session }` summary block shared by every canonical value.
 * @param {ReturnType<typeof buildModel>} m
 */
export function sessionSummary(m) {
  return {
    id: m.id,
    workspace: m.workspace,
    title: m.title,
    cwd: m.cwd ?? null,
    createdAt: m.createdAt,
    live: m.live,
    model: m.model?.model ?? null,
    provider: m.model?.provider ?? null,
    events: m.stats.events,
    turns: m.stats.turns,
    calls: m.stats.calls,
    errors: m.stats.errors,
  }
}

/**
 * Turn records as plain canonical objects.
 * @param {ReturnType<typeof buildModel>} m
 * @param {{ maxPromptChars?: number }} [opts]
 */
export function turnRows(m, opts = {}) {
  const maxPrompt = opts.maxPromptChars ?? 160
  return m.turns.map(t => ({
    turn: t.turn,
    seqFrom: t.seqFrom,
    seqTo: t.seqTo,
    startedAt: t.startTime,
    ms: t.ms,
    steps: t.steps,
    calls: [...t.toolCounts.entries()].sort((a, b) => b[1].count - a[1].count).map(([tool, c]) => ({ tool, count: c.count, errors: c.errors })),
    totalCalls: t.calls.length,
    errors: t.errors,
    retries: t.retries,
    ended: t.ended,
    tokens: t.tokens,
    prompt: clip(t.prompt, maxPrompt),
    lastAssistant: clip(t.lastAssistant, maxPrompt),
  }))
}

/**
 * Clip text to `max` characters on one line.
 * @param {string} text
 * @param {number} max
 */
export function clip(text, max) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, Math.max(0, max - 1))}…` : one
}

/**
 * Match a tool name against glob patterns (`chrome_*`, `*_screenshot`, exact names).
 * @param {string} name
 * @param {readonly string[] | undefined} globs - empty/undefined matches everything
 */
export function matchesTool(name, globs) {
  if (!globs || globs.length === 0) return true
  return globs.some(g => globToRegExp(g).test(name))
}

const globCache = new Map()
function globToRegExp(glob) {
  let re = globCache.get(glob)
  if (!re) {
    re = new RegExp(`^${glob.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i')
    globCache.set(glob, re)
  }
  return re
}

/**
 * EventBuilder — assembles a DSH session event log in memory from a foreign
 * transcript, honouring the session invariant
 * (<checkout>/packages/core/session/src/invariant.ts):
 *
 *   - turns number from 1 and never nest; `step` numbers restart per turn;
 *   - `assistant/message`, `tool/call`, `tool/result` require an OPEN step
 *     naming their turn/step;
 *   - a `tool/result` needs a prior `tool/call` with the same callId in the
 *     same step (orphans are counted and dropped, never emitted);
 *   - `step/end` clears pending calls; `seq` is contiguous from 0.
 *
 * Both readers (Claude Code, pi) drive this one builder so the emitted shapes
 * match what DSH itself writes: `surfaceOp: 'append'` on every model-visible
 * message, `message.id` UUIDs, DSH usage keys, `session/title` at the end.
 *
 * Images are delegated to an async `saveImage(bytes, mediaType, name)` hook
 * (the host wires it to the attachments service and gets a real ImageBlock
 * back); without the hook, or when it returns null, an image becomes a text
 * placeholder and is counted as lost.
 *
 * Working-session mode: `fold({ keepTurns, note, estimate })` appends the same
 * standalone compaction bracket DSH's compactor writes — `compaction/start`,
 * `compaction/prune` (claim), the replacement `user/message` with
 * `surfaceOp: {op:'replace', start, end}`, `compaction/end` — so the older
 * turns stay in the log (session-log view, "Load earlier", rewind) but leave
 * the model-visible surface. Format v3 spells the op `{op:'replace', startSeq,
 * endSeq}`; `sourceEventSeqs` must cite every shadowed surface node. The
 * replacement's source is this plugin's own marker, NOT compaction's
 * `{plugin:'compact'}`, so the compaction invariant's checkpoint rules (which
 * expect a `compaction/summary`) do not apply — only the prune claim does. The token meter requires the claim to be the
 * event IMMEDIATELY before the replacement and the two ranges to agree, and
 * `shadowedSeqs` to list every current surface node in the span in order.
 */
import { createHash, randomUUID } from 'node:crypto'

/** Deterministic UUID (v5-shaped) so a re-import reproduces identical ids. */
export function detUuid(namespace, key) {
  const h = createHash('sha1').update(`${namespace}:${key}`).digest()
  const b = Buffer.from(h.subarray(0, 16))
  b[6] = (b[6] & 0x0f) | 0x50
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = b.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])

/** Media types DSH's attachment service accepts for images. */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export function emptyStats() {
  return {
    turns: 0,
    steps: 0,
    prompts: 0,
    interrupts: 0,
    toolCalls: 0,
    toolResults: 0,
    orphanResults: 0,
    unpairedCalls: 0,
    images: 0,
    imagesImported: 0,
    imageBytes: 0,
    truncatedResults: 0,
    truncatedChars: 0,
    droppedRecords: {},
    duplicateRecords: 0,
    emitted: {},
    models: {},
    firstTime: null,
    lastTime: null,
    foldedTurns: 0,
    surfaceTokens: null,
  }
}

export const bump = (bag, key, by = 1) => { bag[key] = (bag[key] ?? 0) + by }

/** Plugin marker on the working-mode checkpoint, so a second fold is refused. */
export const FOLD_PLUGIN = 'tali-import-sessions/fold'

export class EventBuilder {
  /**
   * @param {object} options
   * @param {string} options.sessionId - DSH id (namespace for deterministic message ids)
   * @param {number} [options.resultCap] - max chars per tool-result text block (0 = unlimited)
   * @param {(bytes: Uint8Array, mediaType: string, name?: string) => Promise<object | null>} [options.saveImage]
   */
  constructor({ sessionId, resultCap = 0, saveImage } = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('EventBuilder needs a sessionId')
    this.sessionId = sessionId
    this.resultCap = Number.isFinite(resultCap) && resultCap > 0 ? Math.floor(resultCap) : 0
    this.saveImage = saveImage
    this.events = []
    this.stats = emptyStats()
    this.turn = 0
    this.step = 0
    this.turnOpen = false
    this.stepOpen = false
    this.pending = new Map()
    this.lastTime = 0
    this.titleText = undefined
  }

  get seq() { return this.events.length }

  /** Clamp times so the log is never earlier than the previous event (DSH readers tolerate this, but it reads better). */
  at(time) {
    const t = Number.isFinite(time) ? time : this.lastTime
    const clamped = Math.max(t, this.lastTime)
    this.lastTime = clamped
    if (this.stats.firstTime === null) this.stats.firstTime = clamped
    this.stats.lastTime = clamped
    return clamped
  }

  emit(type, time, data, extra) {
    const event = { type, seq: this.events.length, time: this.at(time), data }
    if (extra !== undefined) Object.assign(event, extra)
    this.events.push(event)
    bump(this.stats.emitted, type)
    return event
  }

  drop(kind, by = 1) { bump(this.stats.droppedRecords, kind, by) }

  // ---- text helpers ---------------------------------------------------------------

  cap(text, what = 'tool result') {
    if (typeof text !== 'string') return ''
    if (this.resultCap === 0 || text.length <= this.resultCap) return text
    this.stats.truncatedResults++
    this.stats.truncatedChars += text.length - this.resultCap
    return `${text.slice(0, this.resultCap)}\n\n[…${what} truncated at import: ${(text.length - this.resultCap).toLocaleString()} chars elided; the original transcript keeps them]`
  }

  /**
   * Turn base64 image data into a DSH ImageBlock through the hook, or a
   * placeholder text block. Always counted.
   */
  async imageBlock(base64, mediaType, name) {
    this.stats.images++
    const approx = typeof base64 === 'string' ? Math.floor(base64.length * 0.75) : 0
    this.stats.imageBytes += approx
    const type = typeof mediaType === 'string' ? mediaType.toLowerCase() : 'image/png'
    if (this.saveImage !== undefined && typeof base64 === 'string' && base64.length > 0 && IMAGE_MEDIA_TYPES.has(type)) {
      try {
        const block = await this.saveImage(Buffer.from(base64, 'base64'), type, name)
        if (block !== null && block !== undefined) { this.stats.imagesImported++; return block }
      } catch (error) {
        this.drop(`image-save-failed`)
        return { type: 'text', text: `[image not imported (${type}, ~${Math.round(approx / 1024)} KB): ${String(error?.message ?? error)}]` }
      }
    }
    return { type: 'text', text: `[image not imported: ${type}, ~${Math.round(approx / 1024)} KB]` }
  }

  // ---- turn / step brackets -----------------------------------------------------------

  startTurn(time) {
    if (this.turnOpen) this.endTurn(time)
    this.turn += 1
    this.step = 0
    this.stats.turns++
    this.emit('turn/start', time, { turn: this.turn })
    this.turnOpen = true
  }

  openStep(time) {
    if (!this.turnOpen) this.startTurn(time)
    if (this.stepOpen) this.closeStep(time)
    this.step += 1
    this.stats.steps++
    this.emit('step/start', time, { turn: this.turn, step: this.step })
    this.stepOpen = true
    this.pending = new Map()
  }

  closeStep(time) {
    if (!this.stepOpen) return
    this.emit('step/end', time, { turn: this.turn, step: this.step })
    this.stepOpen = false
    this.stats.unpairedCalls += this.pending.size
    this.pending = new Map()
  }

  endTurn(time, reason = { kind: 'completed' }) {
    if (!this.turnOpen) return
    this.closeStep(time)
    this.emit('turn/end', time, { turn: this.turn, reason })
    this.turnOpen = false
  }

  /** A user-side cancel: closes the open turn as interrupted (no new turn). */
  interrupted(time) {
    this.stats.interrupts++
    if (this.turnOpen) this.endTurn(time, { kind: 'interrupted' })
  }

  // ---- messages -----------------------------------------------------------------------

  /**
   * A genuine human prompt: closes the previous turn and opens a new one.
   * @param {number} time
   * @param {object[]} content - DSH content blocks (text / image)
   * @param {string} key - stable key for the deterministic message id
   * @param {object} [source] - message source (default `{kind:'user'}`)
   */
  userMessage(time, content, key, source = { kind: 'user' }) {
    if (!Array.isArray(content) || content.length === 0) { this.drop('user-empty'); return null }
    this.endTurn(time)
    this.startTurn(time)
    this.stats.prompts++
    return this.emit('user/message', time, {
      role: 'user',
      source,
      content,
      id: detUuid(`${this.sessionId}:message`, key),
    }, { surfaceOp: 'append' })
  }

  /**
   * One assistant response, in its own step: the message first, then one
   * tool/call event per `tool-call` block so results can pair.
   * @param {number} time
   * @param {object} message
   * @param {object[]} message.content - DSH blocks incl. `{type:'tool-call', id, name, arguments}`
   * @param {string} message.key
   * @param {string} [message.provider]
   * @param {string} [message.model]
   * @param {object|null} [message.usage] - DSH usage keys
   */
  assistantMessage(time, { content, key, provider = 'unknown', model = 'unknown', usage = null }) {
    const blocks = Array.isArray(content) ? content.filter(b => b !== null && b !== undefined) : []
    if (blocks.length === 0) { this.drop('assistant-empty'); return null }
    bump(this.stats.models, `${provider}/${model}`)
    this.openStep(time)
    const data = {
      turn: this.turn,
      step: this.step,
      message: {
        role: 'assistant',
        source: { kind: 'model', provider, model },
        content: blocks,
        id: detUuid(`${this.sessionId}:message`, key),
      },
      // Format v3 embeds the provider's timed chunk stream here; an import has
      // no stream (the transcript kept only the settled message), so it is empty.
      stream: [],
    }
    if (usage !== null && usage !== undefined) data.usage = usage
    const event = this.emit('assistant/message', time, data, { surfaceOp: 'append' })
    for (const block of blocks) {
      if (block.type !== 'tool-call') continue
      this.pending.set(block.id, block.name)
      this.stats.toolCalls++
      this.emit('tool/call', time, { turn: this.turn, step: this.step, callId: block.id, name: block.name, arguments: block.arguments })
    }
    return event
  }

  /**
   * A tool result for a call of the OPEN step; orphans are counted and dropped.
   * @param {number} time
   * @param {object} result
   * @param {string} result.callId
   * @param {object[]} result.content - inner DSH blocks (text / image); text is capped here
   * @param {boolean} [result.isError]
   * @param {string} result.key
   */
  toolResult(time, { callId, content, isError = false, key }) {
    if (!this.stepOpen || !this.pending.has(callId)) { this.stats.orphanResults++; return null }
    this.pending.delete(callId)
    const inner = (Array.isArray(content) ? content : [])
      .map(b => (b?.type === 'text' ? { type: 'text', text: this.cap(b.text) } : b))
      .filter(b => b !== null && b !== undefined)
    if (inner.length === 0) inner.push({ type: 'text', text: '[empty tool result]' })
    this.stats.toolResults++
    return this.emit('tool/result', time, {
      turn: this.turn,
      step: this.step,
      message: {
        role: 'user',
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: inner, ...(isError ? { isError: true } : {}) }],
        id: detUuid(`${this.sessionId}:tool-result`, key),
      },
    }, { surfaceOp: 'append' })
  }

  /** Remember the title; emitted by `finish()` as the last event. */
  title(text) {
    if (typeof text === 'string' && text.trim() !== '') this.titleText = text.trim().slice(0, 200)
  }

  // ---- surface reconstruction + folding -------------------------------------------

  /**
   * The current model-visible surface: appended nodes with every earlier
   * replace applied, each tagged with the turn it belongs to.
   */
  surface() {
    const nodes = []
    let openTurn = null
    let lastTurn = 0
    for (const event of this.events) {
      if (event.type === 'turn/start') { openTurn = event.data.turn; lastTurn = Math.max(lastTurn, openTurn) } else if (event.type === 'turn/end') openTurn = null
      if (!SURFACE_TYPES.has(event.type) || event.surfaceOp === undefined) continue
      const turn = event.data.turn ?? openTurn ?? lastTurn
      if (event.surfaceOp === 'append') { nodes.push({ seq: event.seq, turn, event }); continue }
      const startIdx = nodes.findIndex(n => n.seq === event.surfaceOp.startSeq)
      const endIdx = nodes.findIndex(n => n.seq === event.surfaceOp.endSeq)
      if (startIdx < 0 || endIdx < startIdx) throw new Error(`replace at seq ${event.seq} names a range outside the surface`)
      nodes.splice(startIdx, endIdx - startIdx + 1, { seq: event.seq, turn, event })
    }
    return nodes
  }

  /** Message carried by a surface event (the session package's `deriveEventMessage`). */
  static messageOf(event) {
    if (event.type === 'user/message') return event.data
    if (event.type === 'assistant/message') return event.data.message
    if (event.type === 'tool/result') return event.data.message
    return null
  }

  /**
   * Replace every surface node before `cut` (a predicate on nodes, or a turn
   * number: nodes with turn < cut) with one note. Emits the compaction
   * bracket at the current position. Requires no open turn.
   * @returns {{ shadowedNodes: number, shadowedTokens: number } | null} null when nothing to fold
   */
  replaceSurface(time, { cut, note, source, estimate }) {
    if (this.turnOpen) throw new Error('fold needs every turn closed (call finish-style endTurn first)')
    const nodes = this.surface()
    const predicate = typeof cut === 'number' ? (n => n.turn < cut) : cut
    let firstKept = nodes.findIndex(n => !predicate(n))
    if (firstKept < 0) firstKept = nodes.length
    if (firstKept <= 0) return null
    const shadowed = nodes.slice(0, firstKept)
    const price = estimate ?? (m => Math.ceil(JSON.stringify(m ?? '').length / 4))
    const shadowedTokens = shadowed.reduce((sum, n) => sum + (price(EventBuilder.messageOf(n.event)) || 0), 0)
    const compactionId = randomUUID()
    const span = { start: shadowed[0].seq, end: shadowed.at(-1).seq }
    const shadowedSeqs = shadowed.map(n => n.seq)
    this.emit('compaction/start', time, { compactionId, turn: null })
    this.emit('compaction/prune', time, { shadowedRange: span, shadowedSeqs, shadowedTokenCount: shadowedTokens })
    this.emit('user/message', time, {
      role: 'user',
      source: source ?? { kind: 'plugin', plugin: FOLD_PLUGIN, compactionId },
      content: [{ type: 'text', text: note }],
      id: randomUUID(),
    }, { surfaceOp: { op: 'replace', startSeq: span.start, endSeq: span.end }, sourceEventSeqs: shadowedSeqs })
    this.emit('compaction/end', time, { compactionId, turn: null })
    return { shadowedNodes: shadowed.length, shadowedTokens }
  }

  /**
   * Working-session fold: keep the last `keepTurns` turns on the surface.
   * @param {object} options
   * @param {number} options.keepTurns
   * @param {(message: object) => number} [options.estimate] - DSH's `tokenMeter.estimateMessage`
   * @param {string} [options.sourceLabel] - e.g. 'Claude Code session "Foo" (2026-08-06 → 2026-08-25)'
   */
  fold({ keepTurns, estimate, sourceLabel }) {
    const keep = Math.max(0, Math.floor(Number(keepTurns) || 0))
    const cutTurn = this.turn - keep + 1 // first kept turn
    if (cutTurn <= 1) return null
    const nodes = this.surface()
    const shadowedTurns = new Set(nodes.filter(n => n.turn < cutTurn).map(n => n.turn)).size
    if (shadowedTurns === 0) return null
    const price = estimate ?? (m => Math.ceil(JSON.stringify(m ?? '').length / 4))
    const shadowedTokens = nodes.filter(n => n.turn < cutTurn).reduce((sum, n) => sum + (price(EventBuilder.messageOf(n.event)) || 0), 0)
    const note = [
      `Imported-history checkpoint. Turns 1–${cutTurn - 1} of this transcript${sourceLabel ? ` (${sourceLabel})` : ''} `
      + `are not sent to the model: at ~${Math.round(shadowedTokens / 1000)}K tokens they would exceed the model window. `
      + `They remain in this session's log — visible in the session-log / trajectory view, via "Load earlier", and via rewind. `
      + `The last ${keep} turn${keep === 1 ? '' : 's'} (${cutTurn}–${this.turn}) follow in full.`,
      '',
      'If earlier context matters, ask the user to summarize it or use the session-log tools to read the folded turns.',
    ].join('\n')
    const result = this.replaceSurface(this.lastTime, { cut: cutTurn, note, estimate })
    if (result !== null) this.stats.foldedTurns = shadowedTurns
    return result
  }

  /** Price the current surface with the given estimator (or chars/4). */
  surfaceTokens(estimate) {
    const price = estimate ?? (m => Math.ceil(JSON.stringify(m ?? '').length / 4))
    return this.surface().reduce((sum, n) => sum + (price(EventBuilder.messageOf(n.event)) || 0), 0)
  }

  /**
   * Close every open bracket and append the title. Call once, last (before an
   * optional `fold`, which needs closed turns — so: finish → fold → done).
   * @param {string} [fallbackTitle]
   */
  finish(fallbackTitle) {
    const time = this.lastTime || Date.now()
    this.endTurn(time)
    const title = this.titleText ?? fallbackTitle
    if (title !== undefined) {
      this.emit('session/title', time, { title, messageSeqs: [], source: { kind: 'user' } })
    }
    return this.events
  }
}

/**
 * Independent re-check of the invariant rules over a finished event list —
 * used by tests and by the importer before writing (a violation would make DSH
 * refuse to reconstruct the session).
 * @returns {string[]} problems (empty = ok)
 */
export function checkInvariant(events) {
  const problems = []
  let turn = 0
  let turnOpen = false
  let step = 0
  let stepOpen = false
  let pending = new Set()
  const surfaceSeqs = new Set()
  events.forEach((e, index) => {
    if (e.seq !== index) problems.push(`seq gap at ${index}: ${e.seq}`)
    switch (e.type) {
      case 'turn/start':
        if (turnOpen) problems.push(`turn/start ${e.data.turn} while turn ${turn} open (seq ${e.seq})`)
        if (e.data.turn !== turn + 1) problems.push(`turn/start ${e.data.turn} expected ${turn + 1} (seq ${e.seq})`)
        turn = e.data.turn; turnOpen = true; step = 0
        break
      case 'turn/end':
        if (!turnOpen || e.data.turn !== turn) problems.push(`turn/end ${e.data.turn} with open=${turnOpen ? turn : 'none'} (seq ${e.seq})`)
        if (stepOpen) problems.push(`turn/end ${e.data.turn} with step ${step} still open (seq ${e.seq})`)
        turnOpen = false
        break
      case 'step/start':
        if (!turnOpen || e.data.turn !== turn) problems.push(`step/start outside turn ${turn} (seq ${e.seq})`)
        if (stepOpen) problems.push(`step/start ${e.data.step} while step ${step} open (seq ${e.seq})`)
        if (e.data.step !== step + 1) problems.push(`step/start ${e.data.step} expected ${step + 1} (seq ${e.seq})`)
        step = e.data.step; stepOpen = true; pending = new Set()
        break
      case 'step/end':
        if (!stepOpen || e.data.turn !== turn || e.data.step !== step) problems.push(`step/end ${e.data.turn}/${e.data.step} vs open ${turn}/${stepOpen ? step : 'none'} (seq ${e.seq})`)
        stepOpen = false; pending = new Set()
        break
      case 'assistant/message':
      case 'tool/call':
      case 'tool/result':
        if (!stepOpen || e.data.turn !== turn || e.data.step !== step) problems.push(`${e.type} names ${e.data.turn}/${e.data.step} but open is ${turnOpen ? turn : 'none'}/${stepOpen ? step : 'none'} (seq ${e.seq})`)
        if (e.type === 'tool/call') pending.add(e.data.callId)
        if (e.type === 'tool/result') {
          const callId = e.data.message?.source?.callId
          if (!pending.has(callId)) problems.push(`tool/result for ${callId} with no prior tool/call in this step (seq ${e.seq})`)
        }
        break
      case 'user/message':
        if (e.surfaceOp === 'append' && !turnOpen && e.data.source?.kind === 'user') problems.push(`user/message outside a turn (seq ${e.seq})`)
        break
      default:
        break
    }
    if (SURFACE_TYPES.has(e.type)) {
      if (e.surfaceOp === undefined) problems.push(`${e.type} without surfaceOp (seq ${e.seq})`)
      else if (e.surfaceOp === 'append') surfaceSeqs.add(e.seq)
      else if (typeof e.surfaceOp === 'object') {
        const { startSeq, endSeq } = e.surfaceOp
        if (e.surfaceOp.op !== 'replace' || !surfaceSeqs.has(startSeq) || !surfaceSeqs.has(endSeq)) problems.push(`replace range ${startSeq}-${endSeq} not on the surface (seq ${e.seq})`)
        const prev = events[index - 1]
        if (prev?.type !== 'compaction/prune') problems.push(`replacement at seq ${e.seq} not immediately preceded by compaction/prune`)
        else if (prev.data.shadowedRange.start !== startSeq || prev.data.shadowedRange.end !== endSeq) problems.push(`claim range differs from replacement range (seq ${e.seq})`)
        const shadowed = [...surfaceSeqs].filter(s => s >= startSeq && s <= endSeq)
        const cited = new Set(Array.isArray(e.sourceEventSeqs) ? e.sourceEventSeqs : [])
        if (shadowed.some(s => !cited.has(s))) problems.push(`replacement at seq ${e.seq} does not cite every shadowed node in sourceEventSeqs`)
        for (const s of shadowed) surfaceSeqs.delete(s)
        surfaceSeqs.add(e.seq)
      }
    }
  })
  if (turnOpen) problems.push(`turn ${turn} left open`)
  return problems
}

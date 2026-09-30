/**
 * Host-side log arithmetic for message branches (pure; tested in tests/).
 *
 * Events are DSH session events `{ type, seq, time, data }` in log order,
 * contiguous from seq 0 (what `ctx.sessionQuery.observeSession` returns).
 */

/**
 * The prefix length (event count) a branch child inherits when its first own
 * turn replaces `turn` of the source log — the same cut DSH's own fork makes
 * for turn ≥ 2 (one past the previous turn's `turn/end`), and for turn 1 the
 * events before the first inbox splice / turn start (the sandbox, approval
 * and permission preambles), so the child's inbox fold starts empty.
 * @param {ReadonlyArray<{type: string, seq: number, data: any}>} events
 * @param {number} turn
 * @returns {{ cut: number, turnStartSeq: number } | { error: string }}
 */
export function cutForTurn(events, turn) {
  if (!Number.isSafeInteger(turn) || turn < 1) return { error: `turn must be a positive integer, got ${String(turn)}` }
  const start = events.find(e => e.type === 'turn/start' && e.data?.turn === turn)
  if (start === undefined) return { error: `turn ${turn} has not started in this session` }
  if (turn === 1) {
    const first = events.find(e => e.type === 'agent/inbox/spliced' || e.type === 'turn/start')
    return { cut: first === undefined ? start.seq : Math.min(first.seq, start.seq), turnStartSeq: start.seq }
  }
  const previousEnd = events.find(e => e.type === 'turn/end' && e.data?.turn === turn - 1)
  if (previousEnd === undefined || previousEnd.seq > start.seq) {
    return { error: `turn ${turn - 1} has no turn/end before turn ${turn}` }
  }
  return { cut: previousEnd.seq + 1, turnStartSeq: start.seq }
}

/**
 * Turn number of the first turn a child with `cut` inherited events produces
 * itself: one past the turns in the prefix.
 * @param {ReadonlyArray<{type: string, seq: number, data: any}>} events - the child's (or its parent's) log
 * @param {number} cut
 */
export function firstOwnTurnOf(events, cut) {
  let last = 0
  for (const event of events) {
    if (event.seq >= cut) break
    if (event.type === 'turn/start' && typeof event.data?.turn === 'number') last = Math.max(last, event.data.turn)
  }
  return last + 1
}

/**
 * The human prompt that opened `turn`: the first `user/message` with
 * `source.kind === 'user'` after that turn's `turn/start` and before the next
 * `turn/start`.
 * @param {ReadonlyArray<{type: string, seq: number, data: any}>} events
 * @param {number} turn
 */
export function userMessageOfTurn(events, turn) {
  let inside = false
  for (const event of events) {
    if (event.type === 'turn/start') {
      if (inside) return undefined
      inside = event.data?.turn === turn
      continue
    }
    if (inside && event.type === 'user/message' && event.data?.source?.kind === 'user') return event
  }
  return undefined
}

/**
 * First-line text preview of a user message's content.
 * @param {ReadonlyArray<any> | undefined} content
 * @param {number} [max]
 */
export function previewOf(content, max = 160) {
  if (!Array.isArray(content)) return ''
  const text = content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join(' ').trim()
  const attachments = content.filter(b => b?.type === 'image' || b?.type === 'file').length
  const line = text.split('\n').find(l => l.trim() !== '')?.trim() ?? ''
  const clipped = line.length > max ? `${line.slice(0, max - 1)}…` : line
  if (clipped === '') return attachments > 0 ? `[${attachments} attachment${attachments === 1 ? '' : 's'}]` : ''
  return clipped
}

/**
 * Previews for each requested turn that this log owns (turn ≥ firstOwnTurn).
 * @param {ReadonlyArray<{type: string, seq: number, data: any}>} events
 * @param {Iterable<number>} turns
 * @param {number} firstOwnTurn
 * @param {number} [max] - preview length cap
 * @returns {Record<string, string>}
 */
export function previewsFor(events, turns, firstOwnTurn, max = 160) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const turn of turns) {
    if (turn < firstOwnTurn) continue
    const message = userMessageOfTurn(events, turn)
    if (message !== undefined) out[String(turn)] = previewOf(message.data?.content, max)
  }
  return out
}

/**
 * Split a stored user message's content into the attachment blocks the edit
 * keeps (by attachment id, original order) and its text.
 * @param {ReadonlyArray<any> | undefined} content
 * @param {ReadonlySet<string>} keep - attachment ids to keep
 */
export function keptAttachmentBlocks(content, keep) {
  if (!Array.isArray(content)) return []
  return content.filter(b => (b?.type === 'image' || b?.type === 'file')
    && typeof b.attachment?.attachmentId === 'string' && keep.has(b.attachment.attachmentId))
}

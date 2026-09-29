import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cutForTurn, firstOwnTurnOf, keptAttachmentBlocks, previewOf, previewsFor, userMessageOfTurn } from '../tree.mjs'

/** A three-turn log shaped like a real one: preambles, inbox splices, turns. */
function log() {
  const events = []
  const push = (type, data) => { events.push({ type, seq: events.length, time: events.length, data }) }
  push('permission/preset', { preset: 'workspace-write' })
  push('sandbox/mode', { mode: 'workspace-write' })
  push('approval/policy', { policy: 'ask' })
  const user = (text, attachments = []) => ({
    id: `m${events.length}`, role: 'user', source: { kind: 'user' },
    content: [...attachments, { type: 'text', text }],
  })
  for (let turn = 1; turn <= 3; turn += 1) {
    const message = user(`prompt ${turn}\nsecond line`, turn === 2
      ? [{ type: 'image', attachment: { attachmentId: `img${turn}`, mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
        { type: 'file', attachment: { attachmentId: `file${turn}`, name: 'a.txt', bytes: 3 } }]
      : [])
    push('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
    push('turn/start', { turn })
    push('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
    push('step/start', { turn, step: 1 })
    push('user/message', message)
    push('assistant/message', { turn, step: 1, message: { role: 'assistant', content: [] }, stream: [] })
    push('step/end', { turn, step: 1 })
    push('turn/end', { turn, reason: 'completed' })
  }
  return events
}

test('cutForTurn: turn 1 cuts before the first inbox splice, later turns one past the previous turn/end', () => {
  const events = log()
  assert.deepEqual(cutForTurn(events, 1), { cut: 3, turnStartSeq: 4 })
  const end1 = events.find(e => e.type === 'turn/end' && e.data.turn === 1)
  const start2 = events.find(e => e.type === 'turn/start' && e.data.turn === 2)
  assert.deepEqual(cutForTurn(events, 2), { cut: end1.seq + 1, turnStartSeq: start2.seq })
  assert.match(cutForTurn(events, 4).error, /has not started/)
  assert.match(cutForTurn(events, 0).error, /positive integer/)
})

test('cutForTurn: the seed below the cut folds to an empty inbox', () => {
  const events = log()
  for (const turn of [1, 2, 3]) {
    const { cut } = cutForTurn(events, turn)
    let pending = 0
    for (const e of events.slice(0, cut)) {
      if (e.type !== 'agent/inbox/spliced') continue
      pending += e.data.inserted.length - (e.data.removedCount ?? 0)
    }
    assert.equal(pending, 0, `turn ${turn}`)
  }
})

test('firstOwnTurnOf continues the prefix numbering', () => {
  const events = log()
  assert.equal(firstOwnTurnOf(events, cutForTurn(events, 1).cut), 1)
  assert.equal(firstOwnTurnOf(events, cutForTurn(events, 2).cut), 2)
  assert.equal(firstOwnTurnOf(events, cutForTurn(events, 3).cut), 3)
})

test('userMessageOfTurn, previews and kept attachments', () => {
  const events = log()
  assert.equal(userMessageOfTurn(events, 2).data.content.at(-1).text, 'prompt 2\nsecond line')
  assert.equal(userMessageOfTurn(events, 9), undefined)
  assert.equal(previewOf(userMessageOfTurn(events, 3).data.content), 'prompt 3')
  assert.equal(previewOf([{ type: 'image', attachment: {} }]), '[1 attachment]')
  assert.equal(previewOf([{ type: 'text', text: 'x'.repeat(200) }], 20).length, 20)
  assert.deepEqual(previewsFor(events, [1, 2, 3], 2), { 2: 'prompt 2', 3: 'prompt 3' })
  const kept = keptAttachmentBlocks(userMessageOfTurn(events, 2).data.content, new Set(['file2']))
  assert.equal(kept.length, 1)
  assert.equal(kept[0].attachment.name, 'a.txt')
})

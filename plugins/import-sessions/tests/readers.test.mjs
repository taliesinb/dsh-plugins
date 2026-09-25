import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readClaudeSession, listClaudeSubagents } from '../host/claude-reader.mjs'
import { readPiSession, readPiTree } from '../host/pi-reader.mjs'
import { EventBuilder, checkInvariant, detUuid } from '../host/events.mjs'
import { claudeStore, piStore } from './fixtures.mjs'

const byType = events => events.reduce((bag, e) => { bag[e.type] = (bag[e.type] ?? 0) + 1; return bag }, {})
const fakeSaveImage = async (bytes, mediaType) => ({ type: 'image', attachment: { attachmentId: `att-${bytes.length}`, mediaType, bytes: bytes.length, width: 1, height: 1 } })

test('claude: per-block assistant runs group into one step; results pair; interrupts close turns; noise dropped', async () => {
  const store = claudeStore()
  const { builder, title, cwd } = await readClaudeSession(store.file, { sessionId: `claude-${store.sessionId}`, saveImage: fakeSaveImage })
  builder.finish('fallback')
  const events = builder.events
  assert.deepEqual(checkInvariant(events), [])
  assert.equal(title, 'Build the thing')
  assert.equal(cwd, store.cwd)
  const counts = byType(events)
  assert.equal(counts['turn/start'], 3, 'three real prompts')
  assert.equal(counts['user/message'], 3)
  assert.equal(counts['assistant/message'], 4)
  assert.equal(counts['tool/call'], 2)
  assert.equal(counts['tool/result'], 1)
  assert.equal(counts['session/title'], 1)
  // the msg_1 run (thinking + text + tool_use) is ONE assistant message with three blocks
  const first = events.find(e => e.type === 'assistant/message')
  assert.deepEqual(first.data.message.content.map(b => b.type), ['reasoning', 'text', 'tool-call'])
  assert.equal(first.data.usage.inputTokens, 10)
  assert.equal(first.data.usage.cacheReadTokens, 100)
  assert.equal(first.surfaceOp, 'append')
  // duplicate uuid dropped, not the shared message.id
  assert.equal(builder.stats.duplicateRecords, 1)
  // the interrupt ended turn 2 as interrupted and left toolu_2 unpaired
  const ends = events.filter(e => e.type === 'turn/end').map(e => e.data.reason.kind)
  assert.deepEqual(ends, ['completed', 'interrupted', 'completed'])
  assert.equal(builder.stats.unpairedCalls, 1)
  // sidechain + injected text dropped
  assert.equal(builder.stats.droppedRecords.sidechain, 1)
  assert.ok(!JSON.stringify(events).includes('ignore me'))
  // image went through the hook
  assert.equal(builder.stats.images, 1)
  assert.equal(builder.stats.imagesImported, 1)
  const prompt3 = events.filter(e => e.type === 'user/message')[1]
  assert.equal(prompt3.data.content[1].type, 'image')
  // deterministic ids
  assert.equal(prompt3.data.id, detUuid(`claude-${store.sessionId}:message`, 'u3'))
  assert.equal(events.at(-1).data.title, 'Build the thing')
})

test('claude: subagent transcripts are found and read as children', async () => {
  const store = claudeStore()
  const subs = await listClaudeSubagents(store.file)
  assert.equal(subs.length, 1)
  const child = await readClaudeSession(subs[0], { sessionId: 'claude-x-agent-abc', child: true })
  child.builder.finish('Subagent abc')
  assert.deepEqual(checkInvariant(child.builder.events), [])
  assert.equal(child.builder.stats.toolCalls, 1)
  assert.equal(child.builder.stats.toolResults, 1)
  assert.equal(child.builder.stats.droppedRecords.sidechain, undefined, 'sidechain records are the content of a child')
})

test('pi: main branch only, tool pairing, compaction → replace, session_info title', async () => {
  const store = piStore()
  const tree = await readPiTree(store.file)
  assert.equal(tree.offBranch, 2)
  assert.ok(!tree.branch.some(r => r.id === 'u2x'))
  const { builder, title, cwd } = await readPiSession(store.file, { sessionId: `pi-${store.id}`, saveImage: fakeSaveImage })
  builder.finish('fallback')
  const events = builder.events
  assert.deepEqual(checkInvariant(events), [])
  assert.equal(title, 'Renamed pi session')
  assert.equal(cwd, store.cwd)
  assert.equal(builder.stats.turns, 3)
  assert.equal(builder.stats.toolCalls, 1)
  assert.equal(builder.stats.toolResults, 1)
  assert.equal(builder.stats.imagesImported, 1)
  assert.equal(builder.stats.droppedRecords['off-branch'], 2)
  assert.ok(!JSON.stringify(events).includes('ABANDONED'))
  const usage = events.find(e => e.type === 'assistant/message').data.usage
  assert.deepEqual(usage, { inputTokens: 5, outputTokens: 9, cacheReadTokens: 1, cacheWriteTokens: 2, totalTokens: 17 })
  // compaction: bracket + replacement covering everything before it
  const counts = byType(events)
  assert.equal(counts['compaction/start'], 1)
  assert.equal(counts['compaction/prune'], 1)
  assert.equal(counts['compaction/end'], 1)
  const replacement = events.find(e => typeof e.surfaceOp === 'object')
  assert.ok(replacement.data.content[0].text.includes('Summary of the first two turns.'))
  const surface = builder.surface()
  assert.equal(surface[0].seq, replacement.seq, 'the note is now the first surface node')
  assert.equal(surface.length, 3, 'note + third prompt + third answer')
})

test('fold keeps the last N turns and prices the shadow with the estimator', async () => {
  const store = claudeStore()
  const { builder } = await readClaudeSession(store.file, { sessionId: 'claude-fold' })
  builder.finish('t')
  const before = builder.surface().length
  const result = builder.fold({ keepTurns: 1, estimate: () => 100, sourceLabel: 'test' })
  assert.ok(result !== null)
  assert.deepEqual(checkInvariant(builder.events), [])
  const prune = builder.events.find(e => e.type === 'compaction/prune')
  assert.equal(prune.data.shadowedTokenCount, result.shadowedNodes * 100)
  const after = builder.surface()
  assert.equal(after.length, before - result.shadowedNodes + 1)
  assert.ok(after.every((n, i) => i === 0 || n.turn === 3))
  assert.equal(builder.stats.foldedTurns, 2)
  // idempotent-ish: folding again with the same keep does nothing
  assert.equal(builder.fold({ keepTurns: 1 }), null)
})

test('result cap truncates and counts', () => {
  const b = new EventBuilder({ sessionId: 's', resultCap: 10 })
  b.userMessage(1, [{ type: 'text', text: 'q' }], 'k1')
  b.assistantMessage(2, { content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }], key: 'k2' })
  b.toolResult(3, { callId: 'c1', content: [{ type: 'text', text: 'x'.repeat(50) }], key: 'k3' })
  b.toolResult(3, { callId: 'nope', content: [{ type: 'text', text: 'orphan' }], key: 'k4' })
  b.finish('t')
  assert.deepEqual(checkInvariant(b.events), [])
  assert.equal(b.stats.truncatedResults, 1)
  assert.equal(b.stats.truncatedChars, 40)
  assert.equal(b.stats.orphanResults, 1)
  const tr = b.events.find(e => e.type === 'tool/result')
  assert.ok(tr.data.message.content[0].content[0].text.startsWith('xxxxxxxxxx\n\n[…'))
})

test('checkInvariant catches the classic mistakes', () => {
  const bad = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'assistant/message', seq: 1, time: 1, data: { turn: 1, step: 1, message: { role: 'assistant', content: [], id: 'x' } }, surfaceOp: 'append' },
    { type: 'turn/end', seq: 2, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const problems = checkInvariant(bad)
  assert.ok(problems.some(p => p.includes('assistant/message names 1/1 but open is 1/none')))
})

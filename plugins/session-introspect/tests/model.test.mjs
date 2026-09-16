import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildModel, clip, imagesOf, matchesTool, sessionSummary, turnRows, workspaceOf } from '../model.mjs'
import { renderOutline, renderRead, renderRow, renderStats, shortId, table } from '../render.mjs'
import { normalizeError, toolStats } from '../stats.mjs'

const fixture = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), 'utf8'))
const wae = fixture('web-automation-errors')
const self = fixture('headless-selftest')

test('buildModel: header, title, model, counts', () => {
  const m = buildModel(wae, { live: false })
  assert.equal(m.id, 'session-cec83493-62ce-48be-937d-0e4c7b51d5b8')
  assert.equal(m.workspace, 'deepseek-harness')
  assert.equal(m.title, 'web-automation-errors') // last session/title wins
  assert.equal(m.model?.model, 'claude-fable-5-1')
  assert.equal(m.stats.turns, 5)
  assert.equal(m.stats.calls, 120)
  assert.equal(m.stats.errors, 3)
  assert.equal(m.stats.events, wae.events.length)
})

test('buildModel: turns carry seq ranges, prompts, tool counts, endings, tokens', () => {
  const m = buildModel(wae)
  const t1 = m.turns[0]
  assert.equal(t1.turn, 1)
  assert.ok(t1.seqFrom < t1.seqTo)
  assert.match(t1.prompt, /^screenshot failures: look at tensatory/)
  assert.equal(t1.ended.kind, 'completed')
  assert.equal(t1.toolCounts.get('edit').errors, 2)
  assert.ok(t1.tokens.output > 0 && t1.tokens.contextEnd > 100_000)
  assert.ok(t1.ms > 60_000)
  // every call in the fixture has a paired result with latency
  assert.ok(m.calls.every(c => c.resultSeq !== null && c.ms !== null && c.ms >= 0))
})

test('buildModel: rows classify user / inject / instructions / call / result', () => {
  const m = buildModel(wae)
  const kinds = new Set(m.rows.map(r => r.kind))
  for (const k of ['turn-start', 'turn-end', 'user', 'inject', 'instructions', 'assistant', 'call', 'result', 'title', 'command']) assert.ok(kinds.has(k), k)
  assert.ok(!kinds.has('reasoning'), 'redacted (empty) reasoning blocks produce no rows')
  assert.ok(buildModel(self).rows.some(r => r.kind === 'reasoning'), 'non-empty reasoning blocks do')
  const inject = m.rows.find(r => r.kind === 'inject')
  assert.equal(inject.plugin, 'user-approval')
  const failed = m.rows.filter(r => r.kind === 'result' && r.ok === false)
  assert.equal(failed.length, 3)
  assert.ok(failed.every(r => r.tool === 'edit' && r.code))
  assert.ok(!m.rows.some(r => r.kind === 'other'), 'no unclassified rows in a standard log')
})

test('buildModel: open turn on a truncated log', () => {
  const cut = { session: wae.session, events: wae.events.slice(0, 40) }
  const m = buildModel(cut)
  assert.equal(m.turns.length, 1)
  assert.equal(m.turns[0].ended.kind, 'open')
})

test('imagesOf: attachment references become size descriptors, inline base64 is never copied', () => {
  const att = imagesOf([{ type: 'image', attachment: { attachmentId: 'sha256:x', mediaType: 'image/webp', width: 588, height: 62, bytes: 2354, name: 'shot.png' } }])
  assert.deepEqual(att, [{ w: 588, h: 62, type: 'webp', bytes: 2354, name: 'shot.png' }])
  const inline = imagesOf([{ type: 'image', mediaType: 'image/png', data: 'A'.repeat(4000) }])
  assert.equal(inline[0].type, 'png')
  assert.equal(inline[0].bytes, 3000)
  assert.ok(!JSON.stringify(inline).includes('AAAA'))
})

test('helpers: workspaceOf, clip, matchesTool, shortId, table', () => {
  assert.equal(workspaceOf('/Users/tali/github/tensatory'), 'tensatory')
  assert.equal(workspaceOf(undefined), '?')
  assert.equal(clip('a\n\nb   c', 10), 'a b c')
  assert.equal(clip('x'.repeat(20), 5), 'xxxx…')
  assert.ok(matchesTool('chrome_get_screenshot', ['chrome_*']))
  assert.ok(matchesTool('safari_click', ['chrome_*', '*_click']))
  assert.ok(!matchesTool('bash', ['chrome_*']))
  assert.ok(matchesTool('bash', []))
  assert.equal(shortId('session-2b810855-33bd-40ae-bbe5-dd0d9d3efea2'), 'session-2b810855')
  assert.equal(table(['a', 'b'], [['1', 'xx'], ['333', 'y']]), 'a    b\n1    xx\n333  y')
})

test('renderOutline / renderRead / renderRow are pure functions of the canonical value', () => {
  const m = buildModel(wae)
  const outline = renderOutline({ session: sessionSummary(m), turns: turnRows(m) })
  assert.match(outline, /^session-cec83493 · deepseek-harness\/web-automation-errors/)
  assert.match(outline, /T1 {3}seq 10–358/)
  assert.match(outline, /edit 21 \(✗2\)/)
  assert.match(outline, /ended: completed/)
  assert.match(outline, /out \d+k · ctx \d+k/)
  const rows = m.rows.slice(0, 30).map(r => ({ ...r, call: undefined }))
  const read = renderRead({ session: sessionSummary(m), range: { seqFrom: 0, seqTo: 100 }, events: rows, maxResultChars: 80 })
  assert.match(read, /\[16\] +USER T1 "screenshot failures/)
  assert.match(read, /\[26\] +CALL +read T1 S1 \{"file_path"/)
  assert.match(read, /\[27\] +RESULT ✓ \d+ms read "/)
  const failed = m.rows.find(r => r.kind === 'result' && r.ok === false)
  assert.match(renderRow(failed), /RESULT ✗ \d+ms edit code=\S+/)
  const img = renderRow({ seq: 1, kind: 'result', ok: true, ms: 1900, tool: 'x', text: '', images: [{ w: 1440, h: 2810, type: 'png', bytes: 1_258_291 }] })
  assert.match(img, /<image 1440×2810 png 1\.2 MB>/)
})

test('toolStats: counts, rates, latency, grouped errors, after-error bigrams', () => {
  const m = buildModel(wae)
  const s = toolStats([m])
  const edit = s.tools.find(t => t.tool === 'edit')
  assert.equal(edit.calls, 33)
  assert.equal(edit.errors, 3)
  assert.ok(edit.p50Ms >= 0 && edit.p90Ms >= edit.p50Ms)
  assert.equal(edit.topErrors.length, 2, 'two distinct normalized messages')
  assert.ok(edit.topErrors[0].example.seq > 0)
  assert.deepEqual(s.afterError.map(a => [a.tool, a.next, a.relation, a.count]), [['edit', 'read', 'switch', 3]])
  const only = toolStats([m], { tools: ['ba*'] })
  assert.deepEqual(only.tools.map(t => t.tool), ['bash'])
  const text = renderStats({ ...s, sessions: [{ id: m.id, workspace: m.workspace, title: m.title }] })
  assert.match(text, /^session-cec83493 deepseek-harness\/web-automation-errors · 120 calls · 3 errors/)
  assert.match(text, /edit ✗ → read \(switch\) ×3/)
})

test('normalizeError collapses paths, numbers, ids and quoted values', () => {
  assert.equal(normalizeError('Error: cannot edit "/Users/x/a.md": file changed since it was read (v12)'), 'Error: cannot edit "…": file changed since it was read (v#)')
  assert.equal(normalizeError('Element with uid 1_23 not found\nsecond line'), 'Element with uid #_# not found')
  assert.equal(normalizeError('[exit code: 2] boom 0x1f2e3d4c5b6a'), '[exit code: N] boom <hex>')
})

test('self-test fixture: a session whose calls are the transcript_* tools', () => {
  const m = buildModel(self)
  assert.deepEqual([...new Set(m.calls.map(c => c.tool))].sort(), ['transcript_find', 'transcript_outline', 'transcript_read', 'transcript_tool_stats'])
  const failed = m.calls.filter(c => c.ok === false)
  assert.equal(failed.length, 1)
  assert.equal(failed[0].code, 'INVALID_TOOL_OUTPUT')
})

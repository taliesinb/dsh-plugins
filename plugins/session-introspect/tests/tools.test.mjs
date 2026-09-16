import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Config, build } from '../index.js'
import { NOTICE } from '../output.mjs'
import { fakeCtx, fakeExec, textOf } from './fake-ctx.mjs'

const fixture = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), 'utf8'))
const wae = fixture('web-automation-errors') // deepseek-harness/web-automation-errors, cwd /Users/tali/projects/deepseek-harness
const self = fixture('headless-selftest') // deepseek-harness/Testing transcript tools on slider session
const WAE = wae.session.id
const SELF = self.session.id
// A third session: a copy of wae relabelled into another workspace with a title from the projection fallback.
const other = { session: { ...wae.session, id: 'session-aaaaaaaa-0000-0000-0000-000000000000', cwd: '/Users/tali/github/tensatory', createdAt: wae.session.createdAt + 1 }, events: wae.events.filter(e => e.type !== 'session/title') }
const OTHER = other.session.id

const root = mkdtempSync(join(tmpdir(), 'si-test-'))
const ctx = fakeCtx({ snapshots: [wae, self, other], live: new Set([SELF]), titles: { [OTHER]: 'interval-slider-proto' }, workspaceRoot: root })
const { tools } = build(ctx, Config({}))
const tool = (name) => tools.find(t => t.name === name)
const exec = fakeExec(SELF, '/Users/tali/projects/deepseek-harness')
const run = (name, args) => tool(name).execute(args, exec)

test.after(() => rmSync(root, { recursive: true, force: true }))

test('six tools registered with the shared parameters', () => {
  assert.deepEqual(tools.map(t => t.name), ['transcript_find', 'transcript_outline', 'transcript_read', 'transcript_tool_stats', 'transcript_grep', 'transcript_event'])
  for (const t of tools) {
    const props = t.parameters.properties ?? t.parameters
    assert.ok(props.fmt, `${t.name} fmt`)
    assert.ok(props.out_file, `${t.name} out_file`)
    assert.equal(typeof t.isConcurrencySafe, 'function', `${t.name} declares concurrency safety`)
  }
})

test('transcript_find: lists every workspace, newest first, marks self; filters by query/workspace', async () => {
  const all = await run('transcript_find', {})
  assert.equal(all.total, 3)
  for (let i = 1; i < all.sessions.length; i++) assert.ok(all.sessions[i - 1].createdAt >= all.sessions[i].createdAt, 'newest first')
  assert.ok(all.sessions.find(s => s.id === SELF).self)
  const text = textOf(tool('transcript_find'), {}, all)
  assert.ok(text.startsWith(NOTICE))
  assert.match(text, /tensatory\/interval-slider-proto/)
  assert.match(text, /deepseek-harness\/web-automation-errors/)
  const q = await run('transcript_find', { query: 'slider' })
  assert.deepEqual(new Set(q.sessions.map(s => s.id)), new Set([OTHER, SELF]))
  const ws = await run('transcript_find', { workspace: 'nope' })
  assert.equal(ws.total, 0)
  assert.match(ws.hint, /Known workspaces: deepseek-harness, tensatory/)
  assert.ok(!JSON.stringify(all).includes('undefined'))
})

test('resolver: workspace/title, bare title, id prefix, latest:, self, mention; ambiguity lists candidates', async () => {
  const byWsTitle = await run('transcript_outline', { session: 'tensatory/interval-slider-proto' })
  assert.equal(byWsTitle.session.id, OTHER)
  const bare = await run('transcript_outline', { session: 'web-automation' })
  assert.equal(bare.session.id, WAE)
  const prefix = await run('transcript_outline', { session: 'session-cec8' })
  assert.equal(prefix.session.id, WAE)
  const bareHex = await run('transcript_outline', { session: 'aaaaaaaa' })
  assert.equal(bareHex.session.id, OTHER)
  const latest = await run('transcript_outline', { session: 'latest:tensatory' })
  assert.equal(latest.session.id, OTHER)
  const me = await run('transcript_outline', {})
  assert.equal(me.session.id, SELF)
  assert.equal(me.session.live, true)
  const mention = await run('transcript_outline', { session: `@[x](dsh-session:${Buffer.from(WAE).toString('base64url')})` })
  assert.equal(mention.session.id, WAE)
  await assert.rejects(run('transcript_outline', { session: 'nonexistent-title' }), /No session matched "nonexistent-title".*transcript_find/s)
  await assert.rejects(run('transcript_outline', { session: 'nowhere/x' }), /No workspace named "nowhere"/)
  await assert.rejects(run('transcript_outline', { session: 'e' }), /"e" matches 3 sessions[\s\S]*\(\/Users\/tali\/github\/tensatory\)/)
})

test('resolver: titles come from cheap projections when available, else one fold per unknown session', async () => {
  const folds = ctx.calls.filter(c => c.startsWith('readTitleSnapshots:'))
  assert.ok(folds.length >= 1)
  assert.ok(folds.every(c => c === 'readTitleSnapshots:3'), 'folds were batched over the unknown sessions once')
})

test('transcript_outline: turns, ranges, tokens, ended; turns filter; json/jsonl renderings', async () => {
  const v = await run('transcript_outline', { session: WAE })
  assert.equal(v.turns.length, 5)
  assert.equal(v.turns[0].calls[0].tool, 'bash')
  assert.equal(v.turns[0].ended.kind, 'completed')
  const two = await run('transcript_outline', { session: WAE, turns: '2-3' })
  assert.deepEqual(two.turns.map(t => t.turn), [2, 3])
  const json = textOf(tool('transcript_outline'), { fmt: 'json' }, v)
  assert.equal(JSON.parse(json.slice(NOTICE.length + 1)).turns.length, 5)
  const jsonl = textOf(tool('transcript_outline'), { fmt: 'jsonl' }, two).split('\n').slice(1)
  assert.equal(jsonl.length, 3)
  assert.equal(JSON.parse(jsonl[0]).kind, 'header')
  assert.equal(JSON.parse(jsonl[1]).turn, 2)
  await assert.rejects(run('transcript_outline', { session: WAE, fmt: 'xml' }), /fmt.*must be one of/)
})

test('transcript_read: turn range, tools filter, errors_only, include, bounding with continuation', async () => {
  const t1 = await run('transcript_read', { session: WAE, turn: 1 })
  assert.equal(t1.range.turn, 1)
  assert.ok(t1.events.every(e => e.seq >= t1.range.seqFrom && e.seq <= t1.range.seqTo))
  assert.ok(!t1.events.some(e => e.kind === 'inject'), 'injections hidden by default')
  assert.ok(t1.omitted, 'a 65-step turn exceeds the default inline budget')
  const text = textOf(tool('transcript_read'), {}, t1)
  assert.match(text, /not shown; continue with seq_from: \d+/)
  assert.ok(text.length <= 24_000 + NOTICE.length + 600)

  const edits = await run('transcript_read', { session: WAE, tools: ['ed*'] })
  assert.ok(edits.events.filter(e => e.kind === 'call').every(e => e.tool === 'edit'))
  assert.ok(edits.events.some(e => e.kind === 'assistant'), 'assistant text stays when filtering by tool')

  const errs = await run('transcript_read', { session: WAE, errors_only: true })
  const results = errs.events.filter(e => e.kind === 'result')
  assert.equal(results.length, 3)
  assert.ok(results.every(r => r.ok === false))
  assert.equal(errs.events.filter(e => e.kind === 'call').length, 3)
  const turnsShown = new Set(errs.events.filter(e => e.kind === 'turn-start').map(e => e.turn))
  assert.deepEqual([...turnsShown].sort(), [1, 3], 'only turns containing a failure keep their markers')

  const withInj = await run('transcript_read', { session: WAE, turn: 1, include: ['injections', 'args'] })
  assert.ok(withInj.events.some(e => e.kind === 'inject' && e.plugin === 'user-approval'))
  assert.ok(!withInj.events.some(e => e.kind === 'result'))

  await assert.rejects(run('transcript_read', { session: WAE, turn: 99 }), /Turn 99 does not exist/)
  await assert.rejects(run('transcript_read', { session: WAE, raw: true }), /raw: true needs fmt/)
})

test('transcript_read raw + out_file: writes the decoded log as jsonl through ctx.fs and returns a handle', async () => {
  const handle = await run('transcript_read', { session: WAE, raw: true, fmt: 'jsonl', out_file: 'export/wae.jsonl' })
  assert.equal(handle.kind, 'file')
  assert.equal(handle.path, join(root, 'export/wae.jsonl'))
  assert.equal(handle.lines, wae.events.length + 1)
  assert.equal(handle.fmt, 'jsonl')
  assert.equal(handle.preview.length, 5)
  const lines = readFileSync(handle.path, 'utf8').trim().split('\n')
  assert.equal(JSON.parse(lines[0]).kind, 'header')
  assert.equal(JSON.parse(lines[1]).type, wae.events[0].type)
  const text = textOf(tool('transcript_read'), { fmt: 'jsonl', out_file: 'export/wae.jsonl' }, handle)
  assert.match(text, /^wrote \d[\d,]* lines, \d+ KB \(fmt=jsonl\) to /)
  assert.ok(!text.startsWith(NOTICE), 'file handle replies carry no transcript content')
})

test('out_file: sandbox denial surfaces as the standard marker; ~ expands', async () => {
  await assert.rejects(run('transcript_outline', { session: WAE, out_file: '/etc/nope.txt' }), /\[sandbox: file access denied under workspace-write mode\]/)
  const h = await run('transcript_outline', { session: WAE, fmt: 'text', out_file: join(root, 'o.txt') })
  assert.ok(existsSync(h.path))
  assert.match(readFileSync(h.path, 'utf8'), /^session-cec83493/)
})

test('transcript_tool_stats: single session, corpus "*", workspace glob, tools globs', async () => {
  const one = await run('transcript_tool_stats', { session: WAE, tools: ['edit'] })
  assert.deepEqual(one.tools.map(t => t.tool), ['edit'])
  assert.equal(one.tools[0].errors, 3)
  assert.equal(one.sessions.length, 1)
  const all = await run('transcript_tool_stats', { sessions: ['*'] })
  assert.equal(all.scope.sessions, 3)
  assert.ok(all.tools.find(t => t.tool === 'transcript_find'))
  const ws = await run('transcript_tool_stats', { sessions: ['tensatory/*'] })
  assert.deepEqual(ws.sessions.map(s => s.id), [OTHER])
  await assert.rejects(run('transcript_tool_stats', { sessions: ['nowhere/*'] }), /No workspace named "nowhere"/)
  const text = textOf(tool('transcript_tool_stats'), {}, all)
  assert.match(text, /3 sessions read, created .* · \d+ calls · \d+ errors/)
})

test('transcript_grep: regex over rows with excerpt and seq; kinds/tools filters; limit; literal fallback', async () => {
  const hits = await run('transcript_grep', { pattern: 'interval-slider-proto', session: WAE, kinds: ['user'] })
  assert.ok(hits.hits.length >= 1)
  assert.equal(hits.hits[0].kind, 'user')
  assert.equal(hits.hits[0].seq, 16)
  assert.match(hits.hits[0].excerpt, /interval-slider-proto/)
  const calls = await run('transcript_grep', { pattern: 'zstd -dc', session: WAE, kinds: ['call'], tools: ['bash'], limit: 2 })
  assert.equal(calls.hits.length, 2)
  assert.equal(calls.truncated, true)
  const literal = await run('transcript_grep', { pattern: 'grep -o(', session: WAE })
  assert.ok(Array.isArray(literal.hits), 'invalid regex is searched literally instead of throwing')
  const multi = await run('transcript_grep', { pattern: 'edit requires reading', sessions: ['*'], kinds: ['result'] })
  assert.ok(new Set(multi.hits.map(h => h.session)).size >= 2)
  const text = textOf(tool('transcript_grep'), {}, multi)
  assert.match(text, /hits for \/edit requires reading\/i in 3 sessions/)
  await assert.rejects(run('transcript_grep', { pattern: '  ', session: WAE }), /pattern must not be empty/)
})

test('transcript_event: full event by seq with neighbors; json fmt; unknown seq', async () => {
  const v = await run('transcript_event', { session: WAE, seq: 27, before: 1, after: 1 })
  assert.equal(v.event.seq, 27)
  assert.equal(v.event.type, 'tool/result')
  assert.equal(v.before.length, 1)
  assert.equal(v.before[0].seq, 26)
  assert.equal(v.after[0].seq, 28)
  const text = textOf(tool('transcript_event'), {}, v)
  assert.match(text, /event seq 27 type tool\/result/)
  const json = textOf(tool('transcript_event'), { fmt: 'json' }, v)
  assert.equal(JSON.parse(json.slice(NOTICE.length + 1)).event.seq, 27)
  await assert.rejects(run('transcript_event', { session: WAE, seq: 999999 }), /No event with seq 999999/)
  await assert.rejects(run('transcript_event', { session: WAE, seq: 27, fmt: 'jsonl' }), /fmt.*must be one of/)
})

test('scope: workspace restricts visibility to the caller cwd', async () => {
  const { tools: scoped } = build(ctx, Config({ scope: 'workspace' }))
  const find = scoped.find(t => t.name === 'transcript_find')
  const v = await find.execute({}, exec)
  // the self-test fixture ran from ~/github/deepseek-harness — same basename, different cwd — and is excluded
  assert.deepEqual(v.sessions.map(s => s.id), [WAE])
  const outline = scoped.find(t => t.name === 'transcript_outline')
  await assert.rejects(outline.execute({ session: 'tensatory/interval-slider-proto' }, exec), /No workspace named "tensatory"/)
})

test('canonical values are lossless JSON (no undefined anywhere)', async () => {
  for (const [name, args] of [
    ['transcript_find', {}], ['transcript_outline', { session: WAE }], ['transcript_read', { session: WAE, turn: 2 }],
    ['transcript_tool_stats', { session: WAE }], ['transcript_grep', { pattern: 'bash', session: WAE, limit: 3 }], ['transcript_event', { session: WAE, seq: 26 }],
  ]) {
    const v = await run(name, args)
    assert.deepEqual(JSON.parse(JSON.stringify(v)), v, name)
  }
})

test('corpus-wide tools skip and report an unreadable session; single-session tools surface the error', async () => {
  const broken = fakeCtx({ snapshots: [wae, self, other], titles: { [OTHER]: 'interval-slider-proto' }, workspaceRoot: root, unreadable: new Set([OTHER]) })
  const { tools: t } = build(broken, Config({}))
  const stats = t.find(x => x.name === 'transcript_tool_stats')
  const v = await stats.execute({ sessions: ['*'] }, exec)
  assert.equal(v.scope.sessions, 2)
  assert.equal(v.skipped.length, 1)
  assert.equal(v.skipped[0].id, OTHER)
  assert.match(textOf(stats, {}, v), /2 sessions read \(1 more skipped, see below\)/)
  assert.match(textOf(stats, {}, v), /1 session could not be read by DSH's session reader and was skipped[^\n]*\n {2}session-aaaaaaaa tensatory\/interval-slider-proto: assistant\/message 1023 chunk references/)
  const grep = t.find(x => x.name === 'transcript_grep')
  const g = await grep.execute({ pattern: 'edit requires', sessions: ['*'], kinds: ['result'] }, exec)
  assert.equal(g.skipped.length, 1)
  assert.match(textOf(grep, {}, g), /^.*\n\d+ hits[\s\S]*session-cec83493 \[\d+\] result edit/)
  await assert.rejects(stats.execute({ session: OTHER }, exec), /failed to read stored session/)
})

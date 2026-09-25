import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { classifySelection, decodeSlug, dshSessionId, scanSelection } from '../host/sources.mjs'
import { claudeStore, piStore } from './fixtures.mjs'

test('slug decoding is a hint only', () => {
  assert.equal(decodeSlug('pi', '--Users-x-github-rho--'), '/Users/x/github/rho')
  assert.equal(decodeSlug('claude', '-Users-x-github-rho'), '/Users/x/github/rho')
  assert.equal(dshSessionId('claude', 'abc'), 'claude-abc')
  assert.equal(dshSessionId('pi', 'abc'), 'pi-abc')
})

test('claude: root / workspace / session selections build the same tree shape', async () => {
  const store = claudeStore()
  const root = await scanSelection('claude', store.root, store.root, async ({ id }) => ({ imported: id.endsWith('nope') }))
  assert.equal(root.kind, 'root')
  assert.equal(root.workspaces.length, 1, 'memory-only dirs and .backup files are ignored')
  const ws = root.workspaces[0]
  assert.equal(ws.dir, store.cwd, 'dir comes from the record cwd, not the lossy slug')
  assert.equal(ws.dirExists, true)
  assert.equal(ws.sessions.length, 1)
  const session = ws.sessions[0]
  assert.equal(session.id, `claude-${store.sessionId}`)
  assert.equal(session.title, 'Build the thing')
  assert.equal(session.subagents, 1)
  assert.equal(session.prompts, 3)
  assert.equal(session.imported, false)
  assert.ok(session.bytes > 0)
  assert.ok(session.startedAt < session.endedAt)

  const wsScan = await scanSelection('claude', store.root, store.dir)
  assert.equal(wsScan.kind, 'workspace')
  assert.equal(realpathSync(wsScan.workspaces[0].sessions[0].file), realpathSync(store.file))

  const single = await scanSelection('claude', store.root, store.file)
  assert.equal(single.kind, 'session')
  assert.equal(single.workspaces[0].sessions.length, 1)

  await assert.rejects(classifySelection('claude', store.root, join(store.dir, 'memory', 'notes.md')), /not a Claude Code session transcript/)
})

test('pi: missing directories and duplicate source ids are flagged', async () => {
  const store = piStore()
  const tree = await scanSelection('pi', store.root, store.root, async () => ({ imported: false }))
  assert.equal(tree.workspaces.length, 2)
  const gone = tree.workspaces.find(w => w.dir === store.goneCwd)
  assert.equal(gone.dirExists, false)
  const live = tree.workspaces.find(w => w.dir === store.cwd)
  assert.equal(live.sessions[0].title, 'Renamed pi session', 'session_info wins over the first prompt')
  assert.equal(live.sessions[0].prompts, 4, 'bounded scan counts every user record it saw (branches included)')
  assert.equal(live.sessions[0].id, `pi-${store.id}`)
})

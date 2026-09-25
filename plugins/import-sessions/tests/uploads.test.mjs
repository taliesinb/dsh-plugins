import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { UploadStore, sanitizeRelativePath } from '../host/uploads.mjs'
import { classifySelection, scanSelection } from '../host/sources.mjs'
import { claudeStore, piStore } from './fixtures.mjs'

test('relative upload paths: only transcripts, never escaping', () => {
  assert.equal(sanitizeRelativePath('claude', 'projects/-Users-x-repo/11111111-2222-4333-8444-555555555555.jsonl'), 'projects/-Users-x-repo/11111111-2222-4333-8444-555555555555.jsonl')
  assert.equal(sanitizeRelativePath('claude', '-Users-x-repo/11111111-2222-4333-8444-555555555555/subagents/agent-abc.jsonl'), '-Users-x-repo/11111111-2222-4333-8444-555555555555/subagents/agent-abc.jsonl')
  assert.equal(sanitizeRelativePath('pi', 'sessions/--Users-x--/2026-08-27T15-00-00-000Z_01a0aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee.jsonl'), 'sessions/--Users-x--/2026-08-27T15-00-00-000Z_01a0aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee.jsonl')
  assert.throws(() => sanitizeRelativePath('claude', '../etc/passwd'), /escapes/)
  assert.throws(() => sanitizeRelativePath('claude', '/abs/11111111-2222-4333-8444-555555555555.jsonl'), /escapes/)
  assert.throws(() => sanitizeRelativePath('claude', 'a/../../11111111-2222-4333-8444-555555555555.jsonl'), /escapes/)
  assert.throws(() => sanitizeRelativePath('claude', 'memory/notes.md'), /not a transcript/)
  assert.throws(() => sanitizeRelativePath('claude', 'x/11111111-2222-4333-8444-555555555555.jsonl.backup'), /not a transcript/)
  assert.throws(() => sanitizeRelativePath('pi', 'x/11111111-2222-4333-8444-555555555555.jsonl'), /not a transcript/, 'a Claude name is not a pi name')
})

test('upload store: gzip chunks materialize, finish returns a scannable dir, discard removes it', async () => {
  const source = claudeStore()
  const store = new UploadStore(mkdtempSync(join(tmpdir(), 'uploads-')))
  const upload = await store.begin('claude')
  const bytes = readFileSync(source.file)
  const gz = gzipSync(bytes)
  const rel = `projects/${source.slug}/${source.sessionId}.jsonl`
  const half = Math.floor(gz.length / 2)
  await store.chunk(upload.id, rel, gz.subarray(0, half), { encoding: 'gzip', offset: 0 })
  await assert.rejects(store.chunk(upload.id, rel, gz.subarray(half), { encoding: 'gzip', offset: 3 }), /does not continue/)
  await store.chunk(upload.id, rel, gz.subarray(half), { encoding: 'gzip', offset: half })
  await store.chunk(upload.id, `projects/${source.slug}/${source.sessionId}/subagents/agent-abc.jsonl`, readFileSync(join(source.dir, source.sessionId, 'subagents', 'agent-abc.jsonl')), { encoding: 'identity' })
  const finished = await store.finish(upload.id)
  assert.equal(finished.files, 2)
  assert.equal(readFileSync(join(finished.dir, rel)).equals(bytes), true)
  // The uploaded tree classifies by content (root wrapper → workspace dir).
  const selection = await classifySelection('claude', '/nonexistent/root', finished.dir)
  assert.equal(selection.kind, 'root')
  const tree = await scanSelection('claude', '/nonexistent/root', finished.dir)
  assert.equal(tree.workspaces.length, 1)
  assert.equal(tree.workspaces[0].sessions[0].subagents, 1)
  assert.equal(store.owns(finished.dir), true)
  assert.equal(await store.discard(upload.id), true)
  await assert.rejects(classifySelection('claude', '/x', finished.dir))
})

test('content-based classification and measured scan', async () => {
  const store = piStore()
  const workspace = await classifySelection('pi', '/elsewhere', store.dir)
  assert.equal(workspace.kind, 'workspace')
  const root = await classifySelection('pi', '/elsewhere', store.root)
  assert.equal(root.kind, 'root')
  await assert.rejects(classifySelection('pi', '/elsewhere', tmpdir()), /holds no pi session transcripts/)
  const tree = await scanSelection('pi', store.root, store.root, {
    measure: async () => ({ turns: 3, estimatedTokens: 250_000, large: true }),
  })
  const session = tree.workspaces.find(w => w.dir === store.cwd).sessions[0]
  assert.equal(session.turns, 3)
  assert.equal(session.large, true)
})

import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { loadState, normalizeState, routeIdFor, saveState } from '../state.mjs'

describe('state', () => {
  it('normalizes servers and workspaces, dropping orphans and junk', () => {
    const state = normalizeState({
      servers: [{ id: 'rv', url: 'https://x/dsh/', label: 'Robo', token: 't1' }, { id: 'BAD ID', url: 'x' }, { id: 'rv', url: 'dup' }],
      workspaces: [
        { id: 'w1', serverId: 'rv', remoteWorkspaceId: 'ws-1', title: 'Robo-thing', remotePath: '/p', remoteTitle: 'thing', order: 2,
          cache: { sessions: [{ id: 's1', title: 'A', updatedAt: '2026-01-01T00:00:00.000Z', running: true }, { nope: 1 }], polledAt: '2026-01-02T00:00:00.000Z', gone: true } },
        { id: 'w2', serverId: 'missing', remoteWorkspaceId: 'ws-2' },
      ],
    })
    assert.equal(state.servers.length, 1)
    assert.deepEqual(state.servers[0], { id: 'rv', url: 'https://x/dsh/', label: 'Robo', token: 't1', lastUsedAt: undefined })
    assert.equal(state.workspaces.length, 1)
    assert.deepEqual(state.workspaces[0].cache, { sessions: [{ id: 's1', title: 'A', updatedAt: '2026-01-01T00:00:00.000Z', running: true }], polledAt: '2026-01-02T00:00:00.000Z', gone: true })
    assert.equal(state.workspaces[0].remoteTitle, 'thing')
  })

  it('derives unique url-safe route ids', () => {
    assert.equal(routeIdFor('Robotics VM'), 'robotics-vm')
    assert.equal(routeIdFor('robotics-vm', new Set(['robotics-vm'])), 'robotics-vm-2')
    assert.equal(routeIdFor('***'), 'remote')
    assert.equal(routeIdFor('127.0.0.1'), '127-0-0-1')
  })

  it('round-trips through a 0600 file and treats a missing file as empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rws-'))
    const file = join(dir, 'remote-workspaces.json')
    assert.deepEqual(await loadState(file), { version: 1, servers: [], workspaces: [] })
    await saveState(file, { servers: [{ id: 'a', url: 'http://h/' }], workspaces: [] })
    assert.equal(((await stat(file)).mode & 0o777), 0o600)
    const loaded = await loadState(file)
    assert.equal(loaded.servers[0].url, 'http://h/')
    assert.ok((await readFile(file, 'utf8')).endsWith('\n'))
  })
})

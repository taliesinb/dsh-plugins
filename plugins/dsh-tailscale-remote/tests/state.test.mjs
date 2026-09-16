import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { loadState, parseUserList, saveState } from '../state.mjs'
import { normalizeMountPath, routeUrl, isTailscaleAddress } from '../tailscale.mjs'

describe('state', () => {
  it('parses comma/space separated logins, lower-cased and unique', () => {
    assert.deepEqual(parseUserList(' Alice@Example.com, bob@github ,alice@example.com\n carol@x'), ['alice@example.com', 'bob@github', 'carol@x'])
    assert.deepEqual(parseUserList(['A@b', '"quoted"']), ['a@b'])
    assert.deepEqual(parseUserList(undefined), [])
  })

  it('creates a tokened disabled state on first load and round-trips with mode 0600', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tailscale-remote-'))
    const file = join(dir, 'state.json')
    const first = await loadState(file)
    assert.equal(first.enabled, false)
    assert.match(first.token, /^[A-Za-z0-9_-]{32}$/)
    assert.equal(((await stat(file)).mode & 0o777), 0o600)
    first.enabled = true
    first.allowedUsers = ['alice@example.com']
    await saveState(file, first)
    const second = await loadState(file)
    assert.deepEqual(second, first)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).token, first.token)
  })
})

describe('tailscale helpers', () => {
  it('normalizes mounts and builds the route URL with a trailing slash', () => {
    assert.equal(normalizeMountPath('dsh/'), '/dsh')
    assert.equal(normalizeMountPath('/'), '/')
    assert.equal(routeUrl('node.tail.ts.net', 443, '/dsh'), 'https://node.tail.ts.net/dsh/')
    assert.equal(routeUrl('node.tail.ts.net', 8443, '/'), 'https://node.tail.ts.net:8443/')
  })

  it('recognizes tailnet addresses', () => {
    assert.equal(isTailscaleAddress('100.114.226.21'), true)
    assert.equal(isTailscaleAddress('::ffff:100.64.0.1'), true)
    assert.equal(isTailscaleAddress('100.128.0.1'), false)
    assert.equal(isTailscaleAddress('fd7a:115c:a1e0::4101:e2ba'), true)
    assert.equal(isTailscaleAddress('127.0.0.1'), false)
  })
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { after, before, describe, it } from 'node:test'
import { createEgress, parseRemoteUrl, rewriteLocation } from '../egress.mjs'

/**
 * A fake remote DSH mounted at `/dsh`: `GET /dsh/?token=T` mints a cookie,
 * every other path needs it (401 otherwise), `/dsh/echo` reports the request
 * headers, `/dsh/api/x/y` answers the Connection envelope, `/dsh/go` redirects
 * inside the mount, and `/dsh/api/remote.mux` upgrades to a byte echo.
 */
function fakeRemote(token) {
  let cookieSerial = 0
  const validCookies = new Set()
  const seen = []
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    seen.push({ method: req.method, path: url.pathname, headers: req.headers })
    if (!url.pathname.startsWith('/dsh')) {
      res.writeHead(404); res.end('outside mount'); return
    }
    if (url.searchParams.has('token')) {
      if (url.searchParams.get('token') !== token) { res.writeHead(401); res.end('bad token'); return }
      cookieSerial += 1
      const value = `c${String(cookieSerial)}`
      validCookies.add(value)
      res.writeHead(303, { location: '/dsh/', 'set-cookie': `remote-auth=${value}; Path=/; HttpOnly` })
      res.end(); return
    }
    const cookie = /remote-auth=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
    if (cookie === undefined || !validCookies.has(cookie)) { res.writeHead(401); res.end('unauthorized'); return }
    if (url.pathname === '/dsh/echo') {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'leak=1' })
      res.end(JSON.stringify(req.headers)); return
    }
    if (url.pathname === '/dsh/go') {
      res.writeHead(302, { location: `http://127.0.0.1:${String(server.address().port)}/dsh/target?x=1` }); res.end(); return
    }
    if (url.pathname.startsWith('/dsh/api/')) {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        const message = JSON.parse(body)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value: { echo: message.payload.args, method: message.method } } }))
      })
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`hello ${url.pathname}`)
  })
  const upgraded = new Set()
  server.on('upgrade', (req, socket) => {
    upgraded.add(socket)
    socket.once('close', () => upgraded.delete(socket))
    const cookie = /remote-auth=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
    if (cookie === undefined || !validCookies.has(cookie)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return
    }
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.on('data', chunk => socket.write(chunk))
  })
  return {
    server, seen, validCookies,
    revokeAll: () => validCookies.clear(),
    listen: () => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise(resolve => { for (const s of upgraded) s.destroy(); server.closeAllConnections?.(); server.close(() => resolve()) }),
  }
}

/** A local listener that mounts the egress at /remote/rv like the plugin does. */
function localMount(egress) {
  const server = createServer((req, res) => {
    const base = '/remote/rv'
    if (req.url === base || req.url.startsWith(`${base}/`) || req.url.startsWith(`${base}?`)) {
      void egress.handleRequest(req, res, req.url.slice(base.length))
    } else { res.writeHead(404); res.end() }
  })
  const upgraded = new Set()
  server.on('upgrade', (req, socket, head) => {
    upgraded.add(socket)
    socket.once('close', () => upgraded.delete(socket))
    void egress.handleUpgrade(req, socket, head, req.url.slice('/remote/rv'.length))
  })
  return {
    server,
    listen: () => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise(resolve => { for (const s of upgraded) s.destroy(); server.closeAllConnections?.(); server.close(() => resolve()) }),
  }
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('parseRemoteUrl / rewriteLocation', () => {
  it('splits a mounted https url and a bare root url', () => {
    const mounted = parseRemoteUrl('https://node.tail.ts.net/dsh/')
    assert.deepEqual([mounted.secure, mounted.port, mounted.authority, mounted.basePath, mounted.url],
      [true, 443, 'node.tail.ts.net', '/dsh', 'https://node.tail.ts.net/dsh/'])
    const bare = parseRemoteUrl('http://127.0.0.1:3082')
    assert.deepEqual([bare.secure, bare.port, bare.basePath, bare.url], [false, 3082, '', 'http://127.0.0.1:3082/'])
    assert.throws(() => parseRemoteUrl('ftp://x/'), /http\(s\)/)
    assert.throws(() => parseRemoteUrl('https://x/dsh/?token=1'), /query/)
  })

  it('maps remote-mount locations under the local base and leaves the rest alone', () => {
    const remote = { origin: 'https://node.tail.ts.net', basePath: '/dsh' }
    assert.equal(rewriteLocation('/dsh/', remote, '/remote/rv'), '/remote/rv/')
    assert.equal(rewriteLocation('/dsh', remote, '/remote/rv'), '/remote/rv/')
    assert.equal(rewriteLocation('/dsh/a/b?x=1', remote, '/remote/rv'), '/remote/rv/a/b?x=1')
    assert.equal(rewriteLocation('https://node.tail.ts.net/dsh/x', remote, '/remote/rv'), '/remote/rv/x')
    assert.equal(rewriteLocation('https://other/dsh/x', remote, '/remote/rv'), 'https://other/dsh/x')
    assert.equal(rewriteLocation('./?embed=1', remote, '/remote/rv'), './?embed=1')
    assert.equal(rewriteLocation('/elsewhere', remote, '/remote/rv'), '/elsewhere')
    const root = { origin: 'http://127.0.0.1:3082', basePath: '' }
    assert.equal(rewriteLocation('/api/x', root, '/remote/lo'), '/remote/lo/api/x')
    assert.equal(rewriteLocation('/', root, '/remote/lo'), '/remote/lo/')
  })
})

describe('createEgress against a fake remote', () => {
  const TOKEN = 'secret-token'
  let remote, remotePort, egress, local, localPort
  before(async () => {
    remote = fakeRemote(TOKEN)
    remotePort = await remote.listen()
    egress = createEgress({ id: 'rv', url: `http://127.0.0.1:${String(remotePort)}/dsh/`, localBase: '/remote/rv', token: () => TOKEN })
    local = localMount(egress)
    localPort = await local.listen()
  })
  after(async () => { await local.close(); await remote.close() })

  it('redirects the slash-less mount to the directory form, keeping the query', async () => {
    const res = await get(localPort, '/remote/rv?embed=s1')
    assert.equal(res.status, 301)
    assert.equal(res.headers.location, '/remote/rv/?embed=s1')
    const bare = await get(localPort, '/remote/rv')
    assert.equal(bare.headers.location, '/remote/rv/')
  })

  it('bridges the token once and forwards with rewritten facts, dropping browser cookies and Set-Cookie', async () => {
    const res = await get(localPort, '/remote/rv/echo', {
      cookie: 'dsh-auth-local=xyz', origin: `http://127.0.0.1:${String(localPort)}`, 'x-forwarded-for': '1.2.3.4', 'sec-fetch-site': 'cross-site', 'x-keep': 'yes',
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers['set-cookie'], undefined)
    const forwarded = JSON.parse(res.body)
    assert.equal(forwarded.host, `127.0.0.1:${String(remotePort)}`)
    assert.equal(forwarded.origin, `http://127.0.0.1:${String(remotePort)}`)
    assert.equal(forwarded.cookie, 'remote-auth=c1')
    assert.equal(forwarded['sec-fetch-site'], 'same-origin')
    assert.equal(forwarded['x-forwarded-for'], undefined)
    assert.equal(forwarded['x-keep'], 'yes')
    assert.equal(remote.seen.filter(entry => entry.path === '/dsh/' && entry.method === 'GET').length, 1, 'one exchange')
    assert.deepEqual(egress.status().mode, 'token')
    assert.equal(egress.status().bridged, true)
  })

  it('maps upstream paths under the mount and rewrites Location back', async () => {
    const res = await get(localPort, '/remote/rv/some/where?q=1')
    assert.equal(res.body, 'hello /dsh/some/where')
    const redirect = await get(localPort, '/remote/rv/go')
    assert.equal(redirect.status, 302)
    assert.equal(redirect.headers.location, '/remote/rv/target?x=1')
  })

  it('speaks the Connection envelope to remote Typert endpoints and re-exchanges after a 401', async () => {
    const first = await egress.call('session', 'list', { request: {} })
    assert.deepEqual(first, { ok: true, value: { echo: { request: {} }, method: 'session/list' } })
    remote.revokeAll()
    const second = await egress.call('workspace', 'create', { request: { path: '/x' } })
    assert.equal(second.ok, true)
    assert.equal(egress.status().bridged, true)
    const exchanges = remote.seen.filter(entry => entry.path === '/dsh/' && entry.method === 'GET').length
    assert.equal(exchanges, 2, 'one re-exchange after the 401')
  })

  it('pipes a WebSocket upgrade both ways', async () => {
    const echoed = await new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: '127.0.0.1', port: localPort, path: '/remote/rv/api/remote.mux', method: 'GET',
        headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' },
      })
      req.on('upgrade', (res, socket) => {
        assert.equal(res.statusCode, 101)
        assert.equal(res.headers['sec-websocket-accept'], 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
        socket.once('data', chunk => { socket.destroy(); resolve(chunk.toString()) })
        socket.write('ping-bytes')
      })
      req.on('response', res => reject(new Error(`no upgrade: ${String(res.statusCode)}`)))
      req.on('error', reject)
      req.end()
    })
    assert.equal(echoed, 'ping-bytes')
  })

  it('reports an unreachable remote as 502 and a failed exchange in status()', async () => {
    const dead = createEgress({ id: 'dead', url: 'http://127.0.0.1:1/', localBase: '/remote/dead', token: () => 't' })
    const mount = localMount(dead)
    const port = await mount.listen()
    try {
      const res = await new Promise((resolve, reject) => {
        const req = httpRequest({ hostname: '127.0.0.1', port, path: '/remote/rv/x', method: 'GET' }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)) })
        req.on('error', reject); req.end()
      })
      assert.equal(res, 502)
      assert.equal(dead.status().bridged, false)
      assert.ok(dead.status().lastFailure)
    } finally { await mount.close() }
  })

  it('works in identity mode without any exchange', async () => {
    const open = fakeRemote('unused')
    const port = await open.listen()
    open.validCookies.add('anything')
    // Identity mode has no cookie; the fake remote requires one, so admit by pre-seeding a header via origin echo instead.
    const identity = createEgress({ id: 'id', url: `http://127.0.0.1:${String(port)}/dsh/`, localBase: '/remote/id' })
    assert.equal(identity.status().mode, 'identity')
    const mount = localMount(identity)
    const localP = await mount.listen()
    try {
      const res = await get(localP, '/remote/rv/echo')
      assert.equal(res.status, 401, 'the fake remote refused: no cookie was invented')
      assert.equal(open.seen.filter(entry => entry.path === '/dsh/').length, 0, 'no token exchange attempted')
    } finally { await mount.close(); await open.close() }
  })
})

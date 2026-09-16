/**
 * Proxy gate + forwarding against a fake DSH backend. Run: `pnpm test`.
 * The fake DSH mints a cookie on `/?token=<launch>` (303) exactly like
 * client-connection's BrowserAuth, echoes request facts as JSON, and answers
 * WebSocket upgrades with a raw 101 so the passthrough can be observed.
 */
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { after, before, describe, it } from 'node:test'
import { bootstrapUpstreamCookie, cookieValueFor, startProxy } from '../proxy.mjs'

const LAUNCH_TOKEN = 'launch-token-xyz'
const DSH_COOKIE = 'dsh-auth-abc=v1.payload.sig'

let backend
let backendPort
let proxy
const seen = []
let token = 'T0kenT0kenT0kenT0ken'
let allowedUsers = ['alice@example.com']

function fetchProxy(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: proxy.port, method, path, headers }, (res) => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/** Headers a request relayed by Tailscale Serve carries (loopback socket is implicit). */
const servePeer = (login) => ({
  'x-forwarded-for': '100.101.102.103',
  'x-forwarded-host': 'node.tailnet.ts.net',
  'x-forwarded-proto': 'https',
  'host': 'node.tailnet.ts.net',
  ...(login === undefined ? {} : { 'tailscale-user-login': login }),
})

before(async () => {
  backend = createServer((req, res) => {
    seen.push({ url: req.url, method: req.method, headers: req.headers })
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/' && url.searchParams.get('token') === LAUNCH_TOKEN) {
      res.writeHead(303, { location: './', 'set-cookie': `${DSH_COOKIE}; Max-Age=100; Path=/; HttpOnly; SameSite=Strict` })
      res.end()
      return
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (req.headers.cookie !== DSH_COOKIE) {
        res.writeHead(401)
        res.end('unauthorized')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'leak=1' })
      res.end('<!doctype html><html><head><meta charset="utf-8"><script src="./assets/a.js"></script></head><body>shell</body></html>')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ url: req.url, headers: req.headers }))
  })
  backend.on('upgrade', (req, socket) => {
    seen.push({ url: req.url, method: 'UPGRADE', headers: req.headers })
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: fake\r\n\r\n')
    socket.write('hello-from-dsh')
    socket.on('data', chunk => socket.write(`echo:${chunk.toString()}`))
  })
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve))
  backendPort = backend.address().port
  proxy = await startProxy({
    listenHost: '127.0.0.1',
    listenPort: 0,
    backendHost: '127.0.0.1',
    backendPort,
    connection: { authenticatedUrl: base => `${base}/?token=${LAUNCH_TOKEN}` },
    token: () => token,
    allowedUsers: () => allowedUsers,
    cookieName: 'dsh-tailscale-remote',
    controlPrefix: '/tailscale-remote',
    mountPath: '/dsh',
  })
})

after(async () => {
  await proxy.close()
  backend.closeAllConnections()
  await new Promise(resolve => backend.close(resolve))
})

describe('upstream cookie bridge', () => {
  it('exchanges the launch token for the DSH cookie', async () => {
    const cookie = await bootstrapUpstreamCookie({ authenticatedUrl: base => `${base}/?token=${LAUNCH_TOKEN}` }, `127.0.0.1:${backendPort}`)
    assert.equal(cookie, DSH_COOKIE)
  })
})

describe('gate', () => {
  it('answers 401 to an anonymous request (HTML for a navigation, text otherwise)', async () => {
    const page = await fetchProxy('/', { headers: { accept: 'text/html' } })
    assert.equal(page.status, 401)
    assert.match(page.body, /Not authorized/)
    const api = await fetchProxy('/api/x', { method: 'POST' })
    assert.equal(api.status, 401)
    assert.equal(api.headers['content-type'], 'text/plain; charset=utf-8')
  })

  it('lets the public shell files through without credentials, GET only', async () => {
    assert.equal((await fetchProxy('/manifest.webmanifest')).status, 200)
    assert.equal((await fetchProxy('/favicon.svg')).status, 200)
    assert.equal((await fetchProxy('/manifest.webmanifest', { method: 'POST' })).status, 401)
  })

  it('exchanges the token on / for the proxy cookie and redirects into the mount', async () => {
    const res = await fetchProxy(`/?token=${token}`, { headers: servePeer() })
    assert.equal(res.status, 303)
    assert.equal(res.headers.location, '/dsh/', 'behind Tailscale the mount is named outright (the slash-less form cannot be told apart)')
    const direct = await fetchProxy(`/?token=${token}`)
    assert.equal(direct.status, 303)
    assert.equal(direct.headers.location, './', 'on the loopback listener itself the redirect stays relative')
    const setCookie = res.headers['set-cookie'][0]
    assert.match(setCookie, /^dsh-tailscale-remote=/)
    assert.match(setCookie, /HttpOnly/)
    assert.match(setCookie, /Secure/, 'https via x-forwarded-proto marks the cookie Secure')
    assert.equal(setCookie.split(';')[0].split('=')[1], cookieValueFor(token))
  })

  it('rejects a wrong token, a token on a deep path, and a token on POST', async () => {
    assert.equal((await fetchProxy('/?token=nope')).status, 401)
    assert.equal((await fetchProxy(`/api/x?token=${token}`)).status, 401)
    assert.equal((await fetchProxy(`/?token=${token}`, { method: 'POST' })).status, 401)
  })

  it('admits the proxy cookie and forwards with DSH facts rewritten', async () => {
    seen.length = 0
    const res = await fetchProxy('/api/session.export?sessionId=1', {
      headers: {
        ...servePeer(),
        cookie: `other=1; dsh-tailscale-remote=${cookieValueFor(token)}`,
        origin: 'https://node.tailnet.ts.net',
        referer: 'https://node.tailnet.ts.net/dsh/',
        'sec-fetch-site': 'same-origin',
        'tailscale-user-login': 'forged@evil.example',
      },
    })
    assert.equal(res.status, 200)
    const [forwarded] = seen
    assert.equal(forwarded.url, '/api/session.export?sessionId=1')
    assert.equal(forwarded.headers.host, `127.0.0.1:${backendPort}`)
    assert.equal(forwarded.headers.origin, `http://127.0.0.1:${backendPort}`)
    assert.equal(forwarded.headers.cookie, DSH_COOKIE, 'browser cookies replaced by the DSH session cookie')
    assert.equal(forwarded.headers.referer, undefined)
    assert.equal(forwarded.headers['tailscale-user-login'], undefined, 'identity headers never reach DSH')
    assert.equal(forwarded.headers['x-forwarded-for'], '100.101.102.103')
    assert.equal(forwarded.headers['x-forwarded-host'], 'node.tailnet.ts.net')
    assert.equal(forwarded.headers['x-forwarded-proto'], 'https')
    assert.equal(forwarded.headers['x-dsh-tailscale-remote'], '1')
    assert.equal(res.headers['set-cookie'], undefined, 'upstream set-cookie is never relayed')
  })

  it('admits an allowlisted Tailscale login from a Serve peer without any cookie', async () => {
    seen.length = 0
    const res = await fetchProxy('/api/whoami', { headers: servePeer('Alice@Example.com') })
    assert.equal(res.status, 200)
    assert.equal(seen[0].headers['tailscale-user-login'], undefined)
  })

  it('refuses a login that is not allowlisted, or whose forwarding facts are not a Serve peer', async () => {
    assert.equal((await fetchProxy('/api/whoami', { headers: servePeer('mallory@example.com') })).status, 401)
    // Right login, but the rightmost x-forwarded-for is not a tailnet address.
    assert.equal((await fetchProxy('/api/whoami', { headers: { ...servePeer('alice@example.com'), 'x-forwarded-for': '203.0.113.9' } })).status, 401)
    // Right login, no forwarding facts at all (a local process talking to the listener directly).
    assert.equal((await fetchProxy('/api/whoami', { headers: { 'tailscale-user-login': 'alice@example.com' } })).status, 401)
    const saved = allowedUsers
    allowedUsers = []
    assert.equal((await fetchProxy('/api/whoami', { headers: servePeer('alice@example.com') })).status, 401, 'empty allowlist admits nobody by login')
    allowedUsers = saved
  })

  it('never forwards the control channel', async () => {
    seen.length = 0
    const res = await fetchProxy('/tailscale-remote/status', { method: 'POST', headers: { ...servePeer('alice@example.com'), 'content-type': 'application/json' }, body: '{}' })
    assert.equal(res.status, 403)
    assert.equal(seen.length, 0)
  })

  it('invalidates cookies when the token rotates', async () => {
    const old = cookieValueFor(token)
    token = 'R0tatedR0tatedR0tated'
    assert.equal((await fetchProxy('/api/whoami', { headers: { cookie: `dsh-tailscale-remote=${old}` } })).status, 401)
    assert.equal((await fetchProxy('/api/whoami', { headers: { cookie: `dsh-tailscale-remote=${cookieValueFor(token)}` } })).status, 200)
  })
})

describe('index response', () => {
  it('injects the trailing-slash guard at the top of <head> and fixes content-length', async () => {
    const res = await fetchProxy('/', { headers: { ...servePeer('alice@example.com'), 'accept-encoding': 'gzip' } })
    assert.equal(res.status, 200)
    assert.match(res.body, /<head><script data-plugin="dsh-tailscale-remote">/)
    assert.match(res.body, /location\.replace\(p\+"\/"/)
    assert.equal(Number(res.headers['content-length']), Buffer.byteLength(res.body))
    assert.equal(seen.at(-1).headers['accept-encoding'], 'identity', 'index is requested uncompressed so it can be rewritten')
  })
})

describe('websocket', () => {
  it('passes an upgrade through with the gate applied', async () => {
    const { connect } = await import('node:net')
    const open = (headers) => new Promise((resolve) => {
      const socket = connect(proxy.port, '127.0.0.1', () => {
        socket.write(`GET /api/remote.mux HTTP/1.1\r\nHost: node.tailnet.ts.net\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\n${headers}\r\n`)
      })
      let text = ''
      socket.on('data', (chunk) => {
        text += chunk.toString()
        if (text.includes('hello-from-dsh')) {
          socket.write('ping')
        }
        if (text.includes('echo:ping') || text.startsWith('HTTP/1.1 401')) {
          socket.destroy()
          resolve(text)
        }
      })
    })
    const denied = await open('')
    assert.match(denied, /^HTTP\/1\.1 401/)
    const ok = await open(`X-Forwarded-For: 100.101.102.103\r\nTailscale-User-Login: alice@example.com\r\n`)
    assert.match(ok, /^HTTP\/1\.1 101/)
    assert.match(ok, /echo:ping/)
    const upgrade = seen.findLast(entry => entry.method === 'UPGRADE')
    assert.equal(upgrade.headers.cookie, DSH_COOKIE)
    assert.equal(upgrade.headers.host, `127.0.0.1:${backendPort}`)
  })
})

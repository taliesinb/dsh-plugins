/** Server pane data: client tracking on a real http.Server, sniffing, UA labels. */
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { attachClientTracker, clientFacts, describeUserAgent, parseEtime, sniffSession } from '../server.mjs'

describe('server pane helpers', () => {
  it('parses macOS ps etime', () => {
    assert.equal(parseEtime('00:14'), 14)
    assert.equal(parseEtime('01:02:03'), 3723)
    assert.equal(parseEtime('2-01:00:00'), 176400)
    assert.equal(parseEtime('garbage'), undefined)
  })
  it('labels user agents', () => {
    assert.equal(describeUserAgent('Mozilla/5.0 (Macintosh) AppleWebKit/605 (KHTML, like Gecko) DSHDock/1.0'), 'Dock app')
    assert.equal(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605 Version/17.0 Mobile/15E148 Safari/604.1'), 'iOS Safari')
    assert.equal(describeUserAgent('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'), 'Chrome')
    assert.equal(describeUserAgent('curl/8.7.1'), 'curl')
    assert.equal(describeUserAgent(undefined), 'unknown')
  })
  it('reads identity facts from the proxy headers or the socket', () => {
    const proxied = clientFacts({ headers: { 'x-dsh-tailscale-remote': '1', 'x-dsh-tailscale-remote-admitted': 'user', 'x-dsh-tailscale-remote-login': 'tali@example.com', 'x-forwarded-for': '100.1.2.3', 'x-dsh-tailscale-remote-self': '1', 'user-agent': 'DSHDock/1.0' }, socket: { remoteAddress: '127.0.0.1' } })
    assert.deepEqual(proxied, { proxied: true, login: 'tali@example.com', admitted: 'user', address: '100.1.2.3', self: true, userAgent: 'DSHDock/1.0' })
    const direct = clientFacts({ headers: { 'user-agent': 'curl/8' }, socket: { remoteAddress: '::ffff:127.0.0.1' } })
    assert.deepEqual(direct, { proxied: false, login: 'local', admitted: 'local', address: '127.0.0.1', self: true, userAgent: 'curl/8' })
    const phone = clientFacts({ headers: { 'x-dsh-tailscale-remote': '1', 'x-dsh-tailscale-remote-admitted': 'cookie', 'x-forwarded-for': '100.9.9.9' }, socket: { remoteAddress: '127.0.0.1' } })
    assert.equal(phone.login, undefined)
    assert.equal(phone.self, false)
  })
  it('sniffs session ids and cwds only from session/* bodies', () => {
    assert.deepEqual(sniffSession('session/attach', JSON.stringify({ payload: { args: { sessionId: 'session-abc' } } })), { method: 'session/attach', sessionId: 'session-abc', cwd: undefined })
    assert.deepEqual(sniffSession('session/create', JSON.stringify({ payload: { args: [{ cwd: '/w' }] } })), { method: 'session/create', sessionId: undefined, cwd: '/w' })
    assert.equal(sniffSession('settings/read', JSON.stringify({ payload: { args: { sessionId: 'session-x' } } })), undefined)
    assert.equal(sniffSession('session/list', '{nope'), undefined)
  })
})

describe('client tracker on a live http.Server', () => {
  let server
  let port
  let tracker
  let clock = 1_000_000
  before(async () => {
    server = createServer((req, res) => { req.resume(); req.on('end', () => { res.end('ok') }) })
    server.on('upgrade', (req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
      // http upgrade sockets are allowHalfOpen: the real ws server reads them
      // and closes on the peer's FIN; do the same here.
      socket.resume()
      socket.on('end', () => socket.destroy())
      socket.on('error', () => {})
    })
    tracker = attachClientTracker(server, { now: () => clock })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    port = server.address().port
  })
  after(async () => {
    tracker.dispose()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })

  const post = (path, body, headers = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, method: 'POST', path, headers: { 'user-agent': 'DSHDock/1.0', ...headers } }, (res) => { res.resume(); res.on('end', resolve) })
    req.on('error', reject)
    req.end(body)
  })

  it('records requests, sniffs the session body without consuming it, and counts live sockets', async () => {
    const proxied = { 'x-dsh-tailscale-remote': '1', 'x-dsh-tailscale-remote-admitted': 'user', 'x-dsh-tailscale-remote-login': 'tali@example.com', 'x-forwarded-for': '100.1.2.3' }
    await post('/api/session/attach', JSON.stringify({ type: 'client-request', payload: { args: { sessionId: 'session-abc' } } }), proxied)
    await post('/api/settings/read', '{}', proxied)
    await new Promise(resolve => setTimeout(resolve, 20))
    let [row] = tracker.snapshot()
    assert.equal(row.login, 'tali@example.com')
    assert.equal(row.agent, 'Dock app')
    assert.equal(row.requests, 2)
    assert.equal(row.lastSession.sessionId, 'session-abc')
    assert.equal(row.lastPath, '/api/settings/read')

    const socket = connect(port, '127.0.0.1')
    await new Promise(resolve => socket.once('connect', resolve))
    socket.write(`GET /api/remote.mux HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nUser-Agent: DSHDock/1.0\r\n${Object.entries(proxied).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`)
    await new Promise(resolve => socket.once('data', resolve))
    ;[row] = tracker.snapshot()
    assert.equal(row.sockets, 1)
    socket.destroy()
    for (let i = 0; i < 50 && tracker.snapshot()[0].sockets !== 0; i += 1) await new Promise(resolve => setTimeout(resolve, 10))
    ;[row] = tracker.snapshot()
    assert.equal(row.sockets, 0)
  })

  it('keeps direct loopback clients apart and expires idle rows', async () => {
    await post('/api/session/list', '{}', { 'user-agent': 'curl/8' })
    let rows = tracker.snapshot()
    assert.equal(rows.length, 2)
    const direct = rows.find(r => r.agent === 'curl')
    assert.equal(direct.login, 'local')
    assert.equal(direct.proxied, false)
    clock += 3 * 60 * 1000
    rows = tracker.snapshot()
    assert.equal(rows.length, 0, 'idle rows without sockets expire')
  })
})

/**
 * The always-on relay in front of the proxy: splice when the proxy port is up,
 * spawn + splash when it is down, never spawn while DSH itself is listening.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import { after, before, describe, it } from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LABEL, launchAgentPlist, relayArguments, relayCommand, shellQuote } from '../relay/launch-agent.mjs'
import { createRelay, parseArgs, parseRequestHead, splashHtml } from '../relay/relay.mjs'

/** A stand-in for the spawned `dsh web` process. */
class FakeChild extends EventEmitter {
  constructor() {
    super()
    this.pid = 4242
    this.exitCode = null
    this.killed = false
  }
  kill(signal) {
    this.killed = signal ?? 'SIGTERM'
    this.exitCode = 0
    this.emit('exit', 0, null)
    return true
  }
}

function fetchRaw(port, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function listenOn(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

async function freePort() {
  const server = createServer()
  const port = await listenOn(server)
  await new Promise(resolve => server.close(resolve))
  return port
}

describe('relay: helpers', () => {
  it('parses a request head and tolerates an incomplete one', () => {
    const head = parseRequestHead(Buffer.from('GET /x?y=1 HTTP/1.1\r\nHost: a\r\nAccept: text/html,*/*\r\n\r\nbody'))
    assert.deepEqual(head, { method: 'GET', target: '/x?y=1', version: 'HTTP/1.1', headers: { host: 'a', accept: 'text/html,*/*' } })
    assert.equal(parseRequestHead(Buffer.from('GET / HTTP/1.1\r\nHost: a')), undefined)
  })
  it('renders every splash kind with the self-reloading poller', () => {
    for (const kind of ['starting', 'remote-disabled', 'failed']) {
      const html = splashHtml(kind)
      assert.match(html, /x-dsh-relay/)
      assert.match(html, /location\.reload\(\)/)
    }
    assert.match(splashHtml('remote-disabled'), /Tailscale remote is off/)
  })
  it('parses CLI arguments with defaults', () => {
    const args = parseArgs(['--listen', '127.0.0.1:1', '--start', 'echo hi'])
    assert.equal(args.listen, '127.0.0.1:1')
    assert.equal(args.start, 'echo hi')
    assert.equal(args.backend, '127.0.0.1:3084')
    assert.throws(() => parseArgs(['--nope']), /unknown argument/)
  })
})

describe('relay: LaunchAgent plist', () => {
  const spec = { listen: '127.0.0.1:3083', backend: '127.0.0.1:3084', dsh: '127.0.0.1:3080', cwd: "/Users/o'brien/dsh", start: 'pnpm dsh web --no-open', logDir: '/tmp/x/logs', path: '/opt/homebrew/bin:/usr/bin', executable: '/x/dsh-web-relay' }
  it('builds ProgramArguments from the named executable and quotes the shell form', () => {
    assert.equal(shellQuote("a'b"), `'a'\\''b'`)
    const args = relayArguments(spec)
    assert.equal(args[0], '/x/dsh-web-relay')
    assert.match(args[1], /relay\.mjs$/)
    assert.deepEqual(args.slice(2), ['--listen', '127.0.0.1:3083', '--backend', '127.0.0.1:3084', '--dsh', '127.0.0.1:3080', '--cwd', "/Users/o'brien/dsh", '--start', 'pnpm dsh web --no-open', '--log', '/tmp/x/logs/dsh-web.log'])
    const command = relayCommand(spec)
    assert.match(command, /'--cwd' '\/Users\/o'\\''brien\/dsh'/)
  })
  it('is a valid plist with KeepAlive, the label, the log paths and the PATH', { skip: process.platform !== 'darwin' }, async () => {
    const text = launchAgentPlist(spec)
    assert.match(text, new RegExp(`<string>${LABEL}</string>`))
    assert.match(text, /<key>KeepAlive<\/key>\s*<true\/>/)
    assert.match(text, /<string>\/x\/dsh-web-relay<\/string>\s*<string>[^<]*relay\.mjs<\/string>/)
    assert.doesNotMatch(text, /zsh/)
    assert.match(text, /\/tmp\/x\/logs\/relay\.log/)
    assert.match(text, /<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/)
    const dir = await mkdtemp(join(tmpdir(), 'relay-plist-'))
    const file = join(dir, 'agent.plist')
    await writeFile(file, text)
    await new Promise((resolve, reject) => execFile('/usr/bin/plutil', ['-lint', file], (error, stdout) => (error ? reject(new Error(String(error.message))) : resolve(stdout))))
  })
})

describe('relay: proxy port up', () => {
  let backend
  let backendPort
  let relay
  let relayPort
  const seen = []
  before(async () => {
    backend = createServer((req, res) => {
      seen.push({ url: req.url, headers: req.headers })
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('from-backend')
    })
    backendPort = await listenOn(backend)
    relay = createRelay({ listenHost: '127.0.0.1', listenPort: 0, backend: { host: '127.0.0.1', port: backendPort }, log: () => {} })
    relayPort = await relay.listen()
  })
  after(async () => {
    await relay.close()
    backend.closeAllConnections()
    await new Promise(resolve => backend.close(resolve))
  })

  it('splices bytes through untouched, headers included', async () => {
    const res = await fetchRaw(relayPort, '/dsh/api/x', { headers: { 'x-forwarded-for': '100.1.2.3', 'tailscale-user-login': 'tali@example.com' } })
    assert.equal(res.status, 200)
    assert.equal(res.body, 'from-backend')
    assert.equal(seen.at(-1).url, '/dsh/api/x')
    assert.equal(seen.at(-1).headers['x-forwarded-for'], '100.1.2.3')
    assert.equal(seen.at(-1).headers['tailscale-user-login'], 'tali@example.com')
    assert.equal(res.headers['x-dsh-relay'], undefined)
  })
})

describe('relay: proxy port down', () => {
  let relay
  let relayPort
  let backendPort
  let dshPort
  let dshServer
  const spawned = []
  const logs = []
  before(async () => {
    backendPort = await freePort()
    dshServer = createServer((req, res) => { res.end('dsh') })
    dshPort = await freePort()
    relay = createRelay({
      listenHost: '127.0.0.1',
      listenPort: 0,
      backend: { host: '127.0.0.1', port: backendPort },
      dsh: { host: '127.0.0.1', port: dshPort },
      start: () => { const child = new FakeChild(); spawned.push(child); return child },
      stop: (child, signal) => child.kill(signal),
      log: line => logs.push(line),
      minSpawnIntervalMs: 0,
      maxFailures: 2,
    })
    relayPort = await relay.listen()
  })
  after(async () => {
    await relay.close({ stopChild: true })
    await new Promise(resolve => dshServer.close(resolve))
  })

  it('spawns DSH once and answers an HTML navigation with the starting splash', async () => {
    const first = await fetchRaw(relayPort, '/', { headers: { accept: 'text/html,application/xhtml+xml' } })
    assert.equal(first.status, 503)
    assert.equal(first.headers['x-dsh-relay'], 'starting')
    assert.match(first.headers['content-type'], /text\/html/)
    assert.match(first.body, /Starting DSH/)
    assert.equal(first.headers['retry-after'], '2')
    const second = await fetchRaw(relayPort, '/api/session.list', { method: 'POST' })
    assert.equal(second.status, 503)
    assert.match(second.headers['content-type'], /text\/plain/)
    assert.equal(spawned.length, 1, 'a live child means no second spawn')
    assert.equal(relay.state.child, spawned[0])
  })

  it('answers HEAD (the splash poller) with the relay marker and no body', async () => {
    const res = await fetchRaw(relayPort, '/', { method: 'HEAD', headers: { accept: 'text/html' } })
    assert.equal(res.status, 503)
    assert.equal(res.headers['x-dsh-relay'], 'starting')
    assert.equal(res.body, '')
  })

  it('reports remote-disabled instead of spawning when DSH itself is listening', async () => {
    spawned[0].kill()
    assert.equal(relay.state.child, undefined)
    await new Promise(resolve => dshServer.listen(dshPort, '127.0.0.1', resolve))
    const res = await fetchRaw(relayPort, '/', { headers: { accept: 'text/html' } })
    assert.equal(res.headers['x-dsh-relay'], 'remote-disabled')
    assert.match(res.body, /Tailscale remote is off/)
    assert.equal(spawned.length, 1)
    dshServer.closeAllConnections()
    await new Promise(resolve => dshServer.close(resolve))
  })

  it('gives up after repeated fast exits and says so', async () => {
    // The first child exited quickly above (failure #1); the next spawn + fast exit is #2.
    const res = await fetchRaw(relayPort, '/', { headers: { accept: 'text/html' } })
    assert.equal(res.headers['x-dsh-relay'], 'starting')
    assert.equal(spawned.length, 2)
    spawned[1].kill()
    const failed = await fetchRaw(relayPort, '/', { headers: { accept: 'text/html' } })
    assert.equal(failed.headers['x-dsh-relay'], 'failed')
    assert.match(failed.body, /could not be started/)
    assert.equal(spawned.length, 2)
  })

  it('splices again as soon as the proxy port comes back, and resets the failure count', async () => {
    const backend = createServer((req, res) => { res.end('back') })
    await new Promise(resolve => backend.listen(backendPort, '127.0.0.1', resolve))
    try {
      const res = await fetchRaw(relayPort, '/api/x')
      assert.equal(res.status, 200)
      assert.equal(res.body, 'back')
      assert.equal(relay.state.consecutiveFailures, 0)
      assert.ok(logs.some(line => /splicing/.test(line)))
    } finally {
      backend.closeAllConnections()
      await new Promise(resolve => backend.close(resolve))
    }
  })
})

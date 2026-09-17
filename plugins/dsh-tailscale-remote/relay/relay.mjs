#!/usr/bin/env node
/**
 * dsh-web-relay — the always-on loopback listener that `tailscale serve`
 * points at, in front of the dsh-tailscale-remote proxy that lives INSIDE the
 * DSH process. It is what makes "open the Dock app while DSH is not running"
 * work: the TCP connection is always accepted, and
 *
 *   - when the proxy port answers, bytes are spliced through untouched (pure
 *     TCP, so WebSocket upgrades and Tailscale's identity headers pass as-is);
 *   - when it does not, `dsh web --no-open` is spawned (once) and THIS request
 *     is answered by the relay itself: an HTML navigation gets a 503 "DSH is
 *     starting…" splash that polls and reloads itself once the real app
 *     answers, anything else gets a plain 503 with Retry-After.
 *
 * The browser never sees a refused connection or a timeout, so the Dock app
 * needs no retry logic of its own. DSH started by hand (a terminal) is simply
 * observed as "up" and relayed — the relay only spawns when neither the proxy
 * port nor DSH's own port is listening. If DSH is up but the proxy is not
 * (Tailscale remote disabled in Settings), the splash says exactly that
 * instead of starting a second DSH.
 *
 * Runs as a LaunchAgent (see install-launch-agent.mjs); `node relay.mjs --help`.
 */
import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HEAD_LIMIT = 64 * 1024
const HEAD_TIMEOUT_MS = 5000
const CONNECT_TIMEOUT_MS = 1500
/** A DSH run that exits sooner than this after spawning, without its proxy port ever answering, counts as a failed start. */
const FAST_EXIT_MS = 30_000

/** @typedef {{ host: string, port: number }} Endpoint */

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

/** Try to open a TCP connection; resolves the socket or undefined (never throws). */
export function tryConnect(endpoint, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = connect({ host: endpoint.host, port: endpoint.port })
    const done = (value) => {
      socket.off('connect', onConnect)
      socket.off('error', onError)
      clearTimeout(timer)
      resolve(value)
    }
    const onConnect = () => done(socket)
    const onError = () => { socket.destroy(); done(undefined) }
    const timer = setTimeout(() => { socket.destroy(); done(undefined) }, timeoutMs)
    socket.once('connect', onConnect)
    socket.once('error', onError)
  })
}

export async function isListening(endpoint, timeoutMs) {
  const socket = await tryConnect(endpoint, timeoutMs)
  if (socket === undefined) return false
  socket.destroy()
  return true
}

const MESSAGES = {
  'starting': { title: 'Starting DSH…', detail: 'The DeepSeek Harness server was not running and has just been launched. This page reloads itself as soon as it answers.' },
  'remote-disabled': { title: 'Tailscale remote is off', detail: 'DSH is running, but its Tailscale remote is disabled, so this address has nothing to forward to. On the Mac, open <b>Settings → Tailscale remote → Enable</b>. This page keeps checking.' },
  'failed': { title: 'DSH could not be started', detail: 'The server exited right after launching several times in a row. Check the log (<code>~/.dsh/logs/dsh-web.log</code>), then start <code>dsh web</code> by hand; this page keeps checking.' },
}

/** Self-contained splash: polls with HEAD and reloads once the relay stops answering itself. */
export function splashHtml(kind, extra = {}) {
  const message = MESSAGES[kind] ?? MESSAGES.starting
  const hint = extra.hint === undefined ? '' : `<p class="hint">${extra.hint}</p>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${message.title}</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 -apple-system,system-ui,sans-serif;background:#fafafa;color:#222}
@media (prefers-color-scheme:dark){body{background:#1c1c1e;color:#e5e5e7}}
main{max-width:34em;padding:2em;text-align:center}
h1{font-size:1.25em;font-weight:600;margin:1em 0 .5em}
p{margin:.5em 0;color:#666}@media (prefers-color-scheme:dark){p{color:#a1a1a6}}
code{font:.92em ui-monospace,Menlo,monospace}
.spinner{width:28px;height:28px;margin:auto;border:3px solid rgba(127,127,127,.25);border-top-color:#3b82f6;border-radius:50%;animation:spin .9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.hint{font-size:.9em}
#t{font-variant-numeric:tabular-nums}
</style></head><body><main>
<div class="spinner" role="progressbar" aria-label="waiting"></div>
<h1>${message.title}</h1>
<p>${message.detail}</p>
${hint}
<p class="hint">Waiting <span id="t">0</span> s</p>
</main>
<script>
(function(){var t0=Date.now(),el=document.getElementById('t');
function tick(){el.textContent=String(Math.round((Date.now()-t0)/1000))}
setInterval(tick,1000);
function poll(){fetch(location.href,{method:'HEAD',cache:'no-store',credentials:'same-origin'}).then(function(r){
  if(!r.headers.get('x-dsh-relay')){location.reload();return}
  setTimeout(poll,1000)}).catch(function(){setTimeout(poll,1500)})}
setTimeout(poll,1000)})();
</script></body></html>
`
}

/** Parse the first HTTP/1.x request head; returns undefined when incomplete. */
export function parseRequestHead(buffer) {
  const end = buffer.indexOf('\r\n\r\n')
  if (end === -1) return undefined
  const lines = buffer.subarray(0, end).toString('latin1').split('\r\n')
  const [method = '', target = '', version = ''] = lines[0].split(' ')
  const headers = {}
  for (const line of lines.slice(1)) {
    const at = line.indexOf(':')
    if (at === -1) continue
    headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim()
  }
  return { method, target, version, headers }
}

/**
 * @param {{
 *   listenHost: string, listenPort: number,
 *   backend: Endpoint, dsh?: Endpoint,
 *   start?: () => import('node:child_process').ChildProcess | undefined,
 *   stop?: (child: import('node:child_process').ChildProcess, signal: NodeJS.Signals) => void,
 *   log?: (line: string) => void,
 *   minSpawnIntervalMs?: number, maxFailures?: number,
 * }} options
 *   `stop` defaults to signalling the child's whole process group (the login
 *   shell, pnpm and node), which requires `start` to spawn it `detached`.
 */
export function createRelay(options) {
  const log = options.log ?? ((line) => process.stderr.write(`${timestamp()} relay: ${line}\n`))
  const stop = options.stop ?? killProcessGroup
  const minSpawnInterval = options.minSpawnIntervalMs ?? 5000
  const maxFailures = options.maxFailures ?? 5
  const state = {
    child: /** @type {import('node:child_process').ChildProcess | undefined} */ (undefined),
    spawnedAt: 0,
    spawns: 0,
    consecutiveFailures: 0,
    /** Whether the current child's proxy port has answered at least once (a deliberate restart is then not a failure). */
    backendSeen: false,
    lastKind: /** @type {keyof typeof MESSAGES | undefined} */ (undefined),
  }
  const sockets = new Set()

  const ensureStarted = () => {
    if (state.child !== undefined) return 'starting'
    if (state.consecutiveFailures >= maxFailures) return 'failed'
    if (Date.now() - state.spawnedAt < minSpawnInterval) return 'starting'
    if (options.start === undefined) return 'starting'
    let child
    try {
      child = options.start()
    } catch (error) {
      log(`spawn failed: ${String(error?.message ?? error)}`)
      state.consecutiveFailures += 1
      state.spawnedAt = Date.now()
      return state.consecutiveFailures >= maxFailures ? 'failed' : 'starting'
    }
    state.spawnedAt = Date.now()
    state.spawns += 1
    if (child === undefined) return 'starting'
    state.child = child
    state.backendSeen = false
    log(`started dsh web (pid ${String(child.pid ?? '?')})`)
    child.once('exit', (code, signal) => {
      const uptime = Date.now() - state.spawnedAt
      state.child = undefined
      if (uptime < FAST_EXIT_MS && !state.backendSeen) state.consecutiveFailures += 1
      else state.consecutiveFailures = 0
      log(`dsh web exited (code ${String(code)}, signal ${String(signal)}) after ${String(Math.round(uptime / 1000))}s; failures=${String(state.consecutiveFailures)}`)
    })
    child.once('error', (error) => { log(`dsh web process error: ${String(error?.message ?? error)}`) })
    return 'starting'
  }

  /** Decide what to tell a client while the proxy port is down. */
  const classify = async () => {
    if (options.dsh !== undefined && await isListening(options.dsh)) return 'remote-disabled'
    return ensureStarted()
  }

  const answerLocally = (socket, kind, head) => {
    const method = head?.method ?? 'GET'
    const wantsHtml = (method === 'GET' || method === 'HEAD') && String(head?.headers.accept ?? '').includes('text/html')
    const body = wantsHtml ? splashHtml(kind) : `${MESSAGES[kind].title}\n`
    const lines = [
      'HTTP/1.1 503 Service Unavailable',
      `Content-Type: ${wantsHtml ? 'text/html' : 'text/plain'}; charset=utf-8`,
      `Content-Length: ${String(Buffer.byteLength(body))}`,
      'Cache-Control: no-store',
      'Retry-After: 2',
      `X-DSH-Relay: ${kind}`,
      'Connection: close',
      '',
      '',
    ]
    socket.end(lines.join('\r\n') + (method === 'HEAD' ? '' : body))
  }

  const handleLocally = (socket, firstChunk) => {
    let buffer = firstChunk ?? Buffer.alloc(0)
    let settled = false
    const finish = async (head) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.off('data', onData)
      const kind = await classify()
      if (kind !== state.lastKind) {
        state.lastKind = kind
        log(`proxy port down; answering ${kind}`)
      }
      if (!socket.destroyed) answerLocally(socket, kind, head)
    }
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const head = parseRequestHead(buffer)
      if (head !== undefined) void finish(head)
      else if (buffer.length > HEAD_LIMIT) { socket.destroy() }
    }
    const timer = setTimeout(() => { void finish(parseRequestHead(buffer)) }, HEAD_TIMEOUT_MS)
    socket.on('data', onData)
    const head = parseRequestHead(buffer)
    if (head !== undefined) void finish(head)
  }

  const onConnection = async (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    // Do not read yet: whatever the client sends stays buffered in the socket
    // until we either pipe it upstream or parse it ourselves.
    const upstream = await tryConnect(options.backend)
    if (socket.destroyed) {
      upstream?.destroy()
      return
    }
    if (upstream !== undefined) {
      if (state.lastKind !== undefined) {
        log('proxy port is back; splicing')
        state.lastKind = undefined
      }
      state.consecutiveFailures = 0
      state.backendSeen = true
      sockets.add(upstream)
      upstream.once('close', () => sockets.delete(upstream))
      upstream.on('error', () => socket.destroy())
      socket.on('error', () => upstream.destroy())
      socket.once('close', () => upstream.destroy())
      upstream.once('close', () => socket.destroy())
      socket.pipe(upstream)
      upstream.pipe(socket)
      return
    }
    handleLocally(socket, undefined)
  }

  const server = createServer({ allowHalfOpen: false }, (socket) => { void onConnection(socket) })

  return {
    state,
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.listenPort, options.listenHost, () => {
        server.off('error', reject)
        const address = server.address()
        resolve(typeof address === 'object' && address !== null ? address.port : options.listenPort)
      })
    }),
    close: async ({ stopChild = false, graceMs = 15_000 } = {}) => {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => { server.close(() => resolve()) })
      const child = state.child
      if (stopChild && child !== undefined && child.exitCode === null) {
        log(`stopping dsh web (pid ${String(child.pid ?? '?')})`)
        stop(child, 'SIGTERM')
        await new Promise((resolve) => {
          const timer = setTimeout(() => { stop(child, 'SIGKILL'); resolve() }, graceMs)
          child.once('exit', () => { clearTimeout(timer); resolve() })
        })
      }
    },
  }
}

/** Signal the child's process group (it was spawned detached = its own group); falls back to the child alone. */
export function killProcessGroup(child, signal) {
  if (child.exitCode !== null || child.pid === undefined) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try { child.kill(signal) } catch { /* already gone */ }
  }
}

// ---- CLI -------------------------------------------------------------------

function parseEndpoint(value, fallback) {
  const text = String(value ?? fallback)
  const at = text.lastIndexOf(':')
  if (at === -1) return { host: '127.0.0.1', port: Number(text) }
  return { host: text.slice(0, at) || '127.0.0.1', port: Number(text.slice(at + 1)) }
}

export function parseArgs(argv) {
  const out = { listen: '127.0.0.1:3083', backend: '127.0.0.1:3084', dsh: '127.0.0.1:3080', cwd: process.cwd(), start: 'pnpm dsh web --no-open', log: '', help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg.startsWith('--') && arg.slice(2) in out) {
      out[arg.slice(2)] = argv[i + 1] ?? ''
      i += 1
    } else throw new Error(`unknown argument ${arg}`)
  }
  return out
}

const USAGE = `usage: node relay.mjs [--listen 127.0.0.1:3083] [--backend 127.0.0.1:3084] [--dsh 127.0.0.1:3080]
                      [--cwd DIR] [--start "pnpm dsh web --no-open"] [--log FILE]

Accepts every connection on --listen. Splices to --backend (the dsh-tailscale-remote
proxy) when it is up; otherwise runs --start in a login shell (cwd --cwd, output
appended to --log) and answers a self-reloading "starting" page. Never starts
DSH while --dsh (DSH's own port) is already listening.
`

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(USAGE)
    return
  }
  const listen = parseEndpoint(args.listen)
  const backend = parseEndpoint(args.backend)
  const dsh = args.dsh === '' ? undefined : parseEndpoint(args.dsh)
  let logFd
  if (args.log !== '') {
    await mkdir(dirname(args.log), { recursive: true })
    logFd = openSync(args.log, 'a')
  }
  const relay = createRelay({
    listenHost: listen.host,
    listenPort: listen.port,
    backend,
    dsh,
    // A login shell (PATH, exported API keys) running the command as written
    // (so `VAR=x cmd` works), in its own process group so stopping the relay
    // stops zsh, pnpm and node together.
    start: () => spawn('/bin/zsh', ['-lc', args.start], {
      cwd: args.cwd,
      detached: true,
      stdio: ['ignore', logFd ?? 'inherit', logFd ?? 'inherit'],
      env: { ...process.env, DSH_WEB_RELAY: '1' },
    }),
  })
  const port = await relay.listen()
  process.stderr.write(`${timestamp()} relay: listening on ${listen.host}:${String(port)} -> ${backend.host}:${String(backend.port)} (start: ${args.start} in ${args.cwd})\n`)
  const shutdown = (signal) => {
    process.stderr.write(`${timestamp()} relay: ${signal}, shutting down\n`)
    void relay.close({ stopChild: true }).then(() => process.exit(0))
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`relay: ${String(error?.message ?? error)}\n`)
    process.exit(1)
  })
}

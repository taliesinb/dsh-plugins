/**
 * The "Server" pane's data: who is connected to this DSH, and the processes
 * that make up this instance (relay, dsh web, Dock app, afm) with the actions
 * that apply to each.
 *
 * Clients are observed on DSH's own `http.Server` (every request and every
 * WebSocket upgrade passes through it, whether from a loopback tab or through
 * the tailnet proxy), keyed by (login, address, user agent):
 *   - login/address: the proxy's trusted `x-dsh-tailscale-remote-*` headers
 *     for proxied clients; `local` + the socket peer for direct ones;
 *   - open sockets: `/api/remote.mux` upgrades still alive = live GUI tabs;
 *   - last session: sniffed from `POST /api/session/*` bodies (the tracker only
 *     listens to the request stream, it never consumes it).
 * Rows expire after IDLE_MS without a request or an open socket.
 */
import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const IDLE_MS = 2 * 60 * 1000
const BODY_SNIFF_LIMIT = 64 * 1024
const MUX_PATH = '/api/remote.mux'

function header(req, name) {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

/** Short, human user-agent label. */
export function describeUserAgent(ua) {
  const text = String(ua ?? '')
  if (text === '') return 'unknown'
  if (/DSHDock\//.test(text)) return 'Dock app'
  if (/curl\//.test(text)) return 'curl'
  if (/CriOS|Chrome\//.test(text) && !/Edg\//.test(text)) return /Mobile/.test(text) ? 'Chrome mobile' : 'Chrome'
  if (/Edg\//.test(text)) return 'Edge'
  if (/Firefox\//.test(text)) return 'Firefox'
  if (/Safari\//.test(text)) return /iPhone|iPad/.test(text) ? 'iOS Safari' : 'Safari'
  return 'other'
}

/** Identity facts of one request as seen by DSH. */
export function clientFacts(req) {
  const proxied = header(req, 'x-dsh-tailscale-remote') === '1'
  const login = proxied ? header(req, 'x-dsh-tailscale-remote-login') : undefined
  const admitted = proxied ? header(req, 'x-dsh-tailscale-remote-admitted') ?? 'unknown' : 'local'
  const address = (proxied ? header(req, 'x-forwarded-for') : undefined) ?? String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/i, '')
  const self = !proxied || header(req, 'x-dsh-tailscale-remote-self') === '1'
  const userAgent = header(req, 'user-agent') ?? ''
  return { proxied, login: login ?? (proxied ? undefined : 'local'), admitted, address, self, userAgent }
}

/** Session-ish facts in a `POST /api/session/...` body, if any. */
export function sniffSession(method, bodyText) {
  if (!/^session\//.test(method)) return undefined
  let parsed
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return undefined
  }
  const args = parsed?.payload?.args
  const record = Array.isArray(args) ? args[0] : args
  if (typeof record !== 'object' || record === null) return undefined
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId : typeof record.id === 'string' && record.id.startsWith('session-') ? record.id : undefined
  const cwd = typeof record.cwd === 'string' ? record.cwd : undefined
  if (sessionId === undefined && cwd === undefined) return undefined
  return { method, sessionId, cwd }
}

/**
 * @param {import('node:http').Server} httpServer DSH's server (`ctx.webServer.server`)
 * @param {{ now?: () => number }} [options]
 */
export function attachClientTracker(httpServer, options = {}) {
  const now = options.now ?? Date.now
  /** @type {Map<string, any>} */
  const clients = new Map()

  const rowFor = (req) => {
    const facts = clientFacts(req)
    const key = `${facts.login ?? '?'}|${facts.address}|${facts.userAgent}`
    let row = clients.get(key)
    if (row === undefined) {
      row = { key, ...facts, agent: describeUserAgent(facts.userAgent), firstSeen: now(), lastSeen: now(), requests: 0, sockets: 0, lastSession: undefined, lastPath: undefined }
      clients.set(key, row)
    }
    row.lastSeen = now()
    return row
  }

  const onRequest = (req) => {
    const row = rowFor(req)
    row.requests += 1
    const url = String(req.url ?? '/')
    const path = url.split('?')[0]
    // The Server pane's own polling is not "viewing" anything.
    if (!path.startsWith('/tailscale-remote/')) row.lastPath = path
    if (req.method === 'POST' && url.startsWith('/api/')) {
      const method = url.slice('/api/'.length).split('?')[0]
      if (/^session\//.test(method)) {
        let text = ''
        let over = false
        const onData = (chunk) => {
          if (over) return
          text += chunk.toString('utf8')
          if (text.length > BODY_SNIFF_LIMIT) over = true
        }
        req.on('data', onData)
        req.once('end', () => {
          req.off('data', onData)
          if (over) return
          const found = sniffSession(method, text)
          if (found !== undefined) row.lastSession = { ...found, at: now() }
        })
      }
    }
  }

  const onUpgrade = (req, socket) => {
    const row = rowFor(req)
    row.requests += 1
    if (String(req.url ?? '').split('?')[0] !== MUX_PATH) return
    row.sockets += 1
    socket.once('close', () => {
      row.sockets = Math.max(0, row.sockets - 1)
      row.lastSeen = now()
    })
  }

  httpServer.on('request', onRequest)
  httpServer.on('upgrade', onUpgrade)

  return {
    snapshot: () => {
      const cutoff = now() - IDLE_MS
      for (const [key, row] of clients) {
        if (row.sockets === 0 && row.lastSeen < cutoff) clients.delete(key)
      }
      return [...clients.values()]
        .sort((a, b) => (b.sockets - a.sockets) || (b.lastSeen - a.lastSeen))
        .map(row => ({ ...row, userAgent: row.userAgent.slice(0, 200) }))
    },
    dispose: () => {
      httpServer.off('request', onRequest)
      httpServer.off('upgrade', onUpgrade)
      clients.clear()
    },
  }
}

/** Workspace directory a session id lives under (`--Users-tali-x--` → `/Users/tali/x`), from the sessions store. */
export async function workspaceOfSession(sessionId, dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')) {
  const root = join(dshHome, 'sessions')
  for (const entry of await readdir(root).catch(() => [])) {
    const inside = await readdir(join(root, entry)).catch(() => [])
    if (inside.includes(sessionId)) return entry.replace(/^--/, '/').replace(/--$/, '').replace(/-/g, '/')
  }
  return undefined
}

// ---- processes -------------------------------------------------------------

async function run(binary, args) {
  try {
    const { stdout } = await execFileAsync(binary, args, { maxBuffer: 4 * 1024 * 1024 })
    return { code: 0, stdout: String(stdout) }
  } catch (error) {
    return { code: typeof error?.code === 'number' ? error.code : 1, stdout: String(error?.stdout ?? ''), stderr: String(error?.stderr ?? '') }
  }
}

async function pidsMatching(pattern) {
  const result = await run('/usr/bin/pgrep', ['-f', pattern])
  return result.code === 0 ? result.stdout.trim().split(/\s+/).filter(Boolean).map(Number) : []
}

/** macOS `ps` prints elapsed time as `[[dd-]hh:]mm:ss` (no `etimes` like Linux). */
export function parseEtime(text) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(text).trim())
  if (match === null) return undefined
  const [, days = '0', hours = '0', minutes, seconds] = match
  return Number(days) * 86400 + Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)
}

/** `ps` facts for one pid: elapsed seconds, rss KB, parent, command. */
async function psFacts(pid) {
  const result = await run('/bin/ps', ['-o', 'etime=,rss=,ppid=,command=', '-p', String(pid)])
  if (result.code !== 0) return undefined
  const line = result.stdout.trim()
  const match = /^\s*(\S+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
  if (match === null) return undefined
  return { pid, uptimeSeconds: parseEtime(match[1]), rssKb: Number(match[2]), ppid: Number(match[3]), command: match[4] }
}

/**
 * @param {{ relay?: { loaded: boolean, pid?: number, label?: string, listening: boolean, spec: { listen: string } },
 *   dockAppPath: string, dockAppName: string, port: number, dshHome: string, afm?: boolean }} spec
 */
export async function processTable(spec) {
  const rows = []
  const relay = spec.relay
  if (relay !== undefined) {
    const facts = relay.pid === undefined ? undefined : await psFacts(relay.pid)
    rows.push({
      id: 'relay',
      title: 'Relay',
      details: [`LaunchAgent ${relay.label ?? ''}`, `listening on ${relay.spec.listen}`, `→ proxy ${relay.spec.backend}`, ...(facts === undefined ? [] : [facts.command])],
      pid: relay.pid,
      running: relay.loaded && relay.pid !== undefined,
      uptimeSeconds: facts?.uptimeSeconds,
      rssKb: facts?.rssKb,
      actions: [
        { id: 'restart', label: 'Restart', note: 'launchctl kickstart -k: restarts the relay AND the DSH it started; the page shows the starting screen and comes back', danger: true },
        { id: 'stop', label: 'Stop', note: 'launchctl bootout: the relay stays down until reinstalled from the panel', danger: true },
      ],
    })
  }
  const self = await psFacts(process.pid)
  const parent = self === undefined ? undefined : await psFacts(self.ppid)
  rows.push({
    id: 'dsh',
    title: 'dsh web',
    details: [
      'this server',
      `http://127.0.0.1:${String(spec.port)}/`,
      `DSH_HOME ${spec.dshHome}`,
      ...(parent === undefined ? [] : [`started by pid ${String(parent.pid)}: ${parent.command}`]),
      ...(self === undefined ? [] : [self.command]),
    ],
    pid: process.pid,
    running: true,
    uptimeSeconds: Math.round(process.uptime()),
    rssKb: Math.round(process.memoryUsage().rss / 1024),
    actions: [
      { id: 'restart', label: 'Restart', note: 'graceful SIGTERM; with the relay in front the next request starts DSH again and this page reloads through the starting screen', danger: true },
      { id: 'quit', label: 'Quit', note: 'graceful SIGTERM; DSH stays down until something connects through the relay (or you start it by hand)', danger: true },
    ],
  })
  const dockPids = await pidsMatching(`${spec.dockAppPath}/Contents/MacOS/`)
  const dockFacts = dockPids.length === 0 ? undefined : await psFacts(dockPids[0])
  rows.push({
    id: 'dock-app',
    title: `${spec.dockAppName}.app`,
    details: [spec.dockAppPath, ...(dockFacts === undefined ? [] : [dockFacts.command])],
    pid: dockPids[0],
    running: dockPids.length > 0,
    uptimeSeconds: dockFacts?.uptimeSeconds,
    rssKb: dockFacts?.rssKb,
    actions: dockPids.length > 0
      ? [
          { id: 'relaunch', label: 'Relaunch', note: 'quit and open the Dock app again' },
          { id: 'quit', label: 'Quit', note: 'quit the Dock app (this page, if you are reading it there)', danger: true },
        ]
      : [{ id: 'launch', label: 'Launch', note: 'open the Dock app' }],
  })
  if (spec.afm !== false) {
    const afmPids = (await run('/usr/bin/pgrep', ['-x', 'afm'])).stdout.trim().split(/\s+/).filter(Boolean).map(Number)
    if (afmPids.length > 0) {
      const facts = await psFacts(afmPids[0])
      rows.push({
        id: 'afm',
        title: 'afm',
        details: ['Apple Foundation model server', 'started on demand by local-model-supervisor', ...(facts === undefined ? [] : [facts.command])],
        pid: afmPids[0],
        running: true,
        uptimeSeconds: facts?.uptimeSeconds,
        rssKb: facts?.rssKb,
        actions: [{ id: 'stop', label: 'Stop', note: 'SIGTERM; restarted on the next apple/* request' }],
      })
    }
  }
  return rows
}

/**
 * Carry out one action. `deferSelf` runs the process-ending step after the
 * response has gone out.
 * @param {{ target: string, action: string }} request
 * @param {{ relayInstance: string, dockAppPath: string, dockAppName: string, restartRelay: () => Promise<void>,
 *   stopRelay: () => Promise<void>, deferSelf: (fn: () => void) => void, log: (line: string) => void }} deps
 */
export async function performAction(request, deps) {
  const { target, action } = request
  const key = `${target}/${action}`
  switch (key) {
    case 'relay/restart':
      deps.log('server pane: restarting the relay (kickstart -k)')
      // kickstart -k kills this very process as well; answer first.
      deps.deferSelf(() => { void deps.restartRelay() })
      return { message: 'Relay restarting — this DSH goes down with it and comes back on the next request.' }
    case 'relay/stop':
      await deps.stopRelay()
      return { message: 'Relay stopped (LaunchAgent unloaded). Reinstall it from the Tailscale remote panel when wanted.' }
    case 'dsh/restart':
    case 'dsh/quit':
      deps.log(`server pane: ${action} requested; sending SIGTERM to self`)
      deps.deferSelf(() => { process.kill(process.pid, 'SIGTERM') })
      return { message: action === 'restart' ? 'DSH is shutting down; reload in a moment — the relay starts it again.' : 'DSH is shutting down.' }
    case 'dock-app/quit':
      await run('/usr/bin/pkill', ['-TERM', '-f', `${deps.dockAppPath}/Contents/MacOS/`])
      return { message: `${deps.dockAppName} quit.` }
    case 'dock-app/relaunch':
      await run('/usr/bin/pkill', ['-TERM', '-f', `${deps.dockAppPath}/Contents/MacOS/`])
      await new Promise(resolve => setTimeout(resolve, 800))
      await run('/usr/bin/open', [deps.dockAppPath])
      return { message: `${deps.dockAppName} relaunched.` }
    case 'dock-app/launch':
      await run('/usr/bin/open', [deps.dockAppPath])
      return { message: `${deps.dockAppName} launched.` }
    case 'afm/stop':
      await run('/usr/bin/pkill', ['-TERM', '-x', 'afm'])
      return { message: 'afm stopped.' }
    default:
      throw new Error(`unknown action ${key}`)
  }
}

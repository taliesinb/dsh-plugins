/**
 * dsh-remote-workspaces — mirror workspaces of other DSH servers in this GUI.
 *
 * A remote workspace is a sidebar row whose sessions live on another DSH host
 * (reached over the tailnet, typically published by that host's
 * `dsh-tailscale-remote`). Selecting one of its sessions frames the remote
 * GUI's chrome-less page (`?embed=<sessionId>`, DSH branch `feat/embed-session`)
 * in an iframe that this plugin serves SAME-ORIGIN at `/remote/<serverId>/…`
 * through an egress proxy (egress.mjs) holding the remote's credentials.
 * Management calls (list / create / rename sessions) go host-to-host through
 * the same egress and the remote's Typert Remote endpoints.
 *
 * Phase 2 (this file): the egress proxy + a control channel with `status` and
 * `probe`. Servers come from the persisted registry (state.mjs) merged with
 * the `servers` config seed. Phase 3 adds the registry mutations and the
 * browser half (sidebar rows, add-remote modal, iframe pool).
 *
 * Config:
 *   routePrefix  local mount of the egress routes                    /remote
 *   stateFile    registry ('' = $DSH_HOME/remote-workspaces.json)   ''
 *   servers[]    seed entries { id, url, label?, token? } (not persisted)
 */
import Schema from '@deepseek-ai/schemastery'
import { createEgress } from './egress.mjs'
import { defaultStateFile, loadState, normalizeState, saveState } from './state.mjs'

export const name = 'remote-workspaces'
export const inject = ['webServer', 'connection']

export const Config = Schema.object({
  routePrefix: Schema.string().default('/remote'),
  stateFile: Schema.string().default(''),
  servers: Schema.array(Schema.object({
    id: Schema.string().required(),
    url: Schema.string().required(),
    label: Schema.string().default(''),
    token: Schema.string().default(''),
  })).default([]),
})

/** RPC channel the browser half calls (`POST /remote-workspaces/<endpoint>`). */
export const CONTROL_CHANNEL = '/remote-workspaces'
/** The one upgrade the embedded shell opens, relative to its document directory. */
const MUX_PATH = '/api/remote.mux'
const MAX_CONTROL_BODY = 64 * 1024

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * One control request: DSH's trust + auth gate, then the Connection JSON
 * envelope (`client-request` in, `server-response` out).
 */
export async function controlRoute(req, res, connection, dispatch) {
  const rejection = connection.requestRejection(req)
  if (rejection !== undefined) {
    res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
    return
  }
  const endpoint = new URL(req.url ?? '/', 'http://x').pathname.slice(CONTROL_CHANNEL.length + 1)
  if (req.method !== 'POST' || endpoint === '' || endpoint.includes('/')) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  let message
  try {
    message = JSON.parse(await readBody(req, MAX_CONTROL_BODY))
  } catch {
    res.writeHead(400)
    res.end('body is not JSON')
    return
  }
  if (typeof message !== 'object' || message === null || message.type !== 'client-request' || typeof message.rpcId !== 'string' || message.method !== endpoint) {
    res.writeHead(400)
    res.end('invalid client-request envelope')
    return
  }
  let result
  try {
    result = await dispatch(endpoint, message.payload)
  } catch (error) {
    result = { ok: false, error: { code: 'remote-workspaces/internal', message: String(error?.message ?? error), details: {} } }
  }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result }))
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<typeof Config>} config
 */
export function apply(ctx, config) {
  const stateFile = config.stateFile || defaultStateFile()
  const prefix = `/${config.routePrefix.replace(/^\/+|\/+$/g, '')}`
  const log = message => ctx.logger.info(message)
  const warn = message => ctx.logger.warn(message)
  const ok = value => ({ ok: true, value })
  const fail = (code, message, details = {}) => ({ ok: false, error: { code: `remote-workspaces/${code}`, message, details } })

  /** @type {ReturnType<typeof normalizeState>} */
  let state = normalizeState({})
  /** Seed servers from config: present every boot, never written to the file. */
  const seeds = new Map(config.servers.map(entry => [entry.id, {
    id: entry.id, url: entry.url, label: entry.label || entry.id, token: entry.token || undefined, seeded: true,
  }]))
  /** @type {Map<string, { server: object, egress: ReturnType<typeof createEgress>, dispose: () => void }>} */
  const mounted = new Map()
  let disposed = false

  const gate = (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection === undefined) return true
    res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
    return false
  }

  /** Mount the egress routes of one server (idempotent per id). */
  const mount = (server) => {
    if (mounted.has(server.id)) return mounted.get(server.id)
    const localBase = `${prefix}/${server.id}`
    const egress = createEgress({
      id: server.id,
      url: server.url,
      localBase,
      token: () => mounted.get(server.id)?.server.token,
      log,
      warn,
    })
    const disposeRoute = ctx.webServer.register({
      kind: 'prefix',
      path: localBase,
      handler: (req, res) => {
        if (!gate(req, res)) return
        const url = req.url ?? '/'
        return egress.handleRequest(req, res, url.slice(localBase.length))
      },
    })
    const disposeUpgrade = ctx.webServer.registerUpgrade({
      path: `${localBase}${MUX_PATH}`,
      handler: (req, socket, head) => {
        const rejection = ctx.connection.requestRejection(req)
        if (rejection !== undefined) {
          socket.end(`HTTP/1.1 ${String(rejection)} ${rejection === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
          return
        }
        return egress.handleUpgrade(req, socket, head, (req.url ?? '/').slice(localBase.length))
      },
    })
    const entry = {
      server,
      egress,
      dispose: () => {
        disposeUpgrade()
        disposeRoute()
      },
    }
    mounted.set(server.id, entry)
    log(`remote-workspaces: ${localBase}/ -> ${egress.remote.url} (${egress.status().mode})`)
    return entry
  }

  const unmount = (id) => {
    const entry = mounted.get(id)
    if (entry === undefined) return
    mounted.delete(id)
    entry.dispose()
  }

  /** Effective server list: persisted entries, then seeds not already persisted. */
  const servers = () => {
    const out = [...state.servers.map(server => ({ ...server, seeded: false }))]
    for (const seed of seeds.values()) if (!out.some(server => server.id === seed.id)) out.push(seed)
    return out
  }

  const syncMounts = () => {
    const wanted = new Map(servers().map(server => [server.id, server]))
    for (const id of [...mounted.keys()]) if (!wanted.has(id)) unmount(id)
    for (const server of wanted.values()) {
      const current = mounted.get(server.id)
      if (current !== undefined && current.server.url !== server.url) unmount(server.id)
      const entry = mount(server)
      entry.server = server
    }
  }

  const snapshot = () => ({
    routePrefix: prefix,
    servers: servers().map(server => ({
      id: server.id,
      url: server.url,
      label: server.label,
      seeded: server.seeded,
      hasToken: server.token !== undefined,
      localBase: `${prefix}/${server.id}/`,
      bridge: mounted.get(server.id)?.egress.status(),
    })),
    workspaces: state.workspaces,
  })

  const persist = () => saveState(stateFile, state)

  /** Confirm the remote accepts this host: exchange the token if any, then list its sessions. */
  const probe = async (serverId) => {
    const entry = mounted.get(String(serverId ?? ''))
    if (entry === undefined) return fail('unknown-server', `no remote server "${String(serverId)}"`)
    const started = Date.now()
    try {
      await entry.egress.exchange()
    } catch (error) {
      return fail('unreachable', String(error?.message ?? error), { bridge: entry.egress.status() })
    }
    const listed = await entry.egress.call('session', 'list', { _request: {} })
    if (!listed.ok) return listed
    const items = Array.isArray(listed.value?.items) ? listed.value.items : []
    return ok({
      serverId: entry.server.id,
      url: entry.egress.remote.url,
      elapsedMs: Date.now() - started,
      sessionCount: items.length,
      // Item shape (verified 2026-09-16): { sessionId, updatedAt, running, blank, cwd, projections: { values: { title, … } } }.
      sessions: items.slice(0, 20).map(item => ({ id: item.sessionId, title: item.projections?.values?.title ?? '', cwd: item.cwd })),
      bridge: entry.egress.status(),
    })
  }

  const dispatch = async (endpoint, payload) => {
    await boot
    const args = typeof payload === 'object' && payload !== null && typeof payload.args === 'object' && payload.args !== null ? payload.args : {}
    switch (endpoint) {
      case 'status': return ok(snapshot())
      case 'probe': return probe(args.serverId)
      default: return fail('unknown-endpoint', `unknown endpoint ${endpoint}`)
    }
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CONTROL_CHANNEL,
    handler: (req, res) => controlRoute(req, res, ctx.connection, dispatch),
  }), 'remote-workspaces: control channel')

  const boot = (async () => {
    try {
      state = await loadState(stateFile)
    } catch (error) {
      warn(String(error?.message ?? error))
    }
    if (disposed) return
    syncMounts()
  })()

  ctx.effect(() => () => {
    disposed = true
    return boot.then(() => { for (const id of [...mounted.keys()]) unmount(id) })
  }, 'remote-workspaces: egress routes')

  // Registry mutations (add/remove server, add workspace) arrive in phase 3 and
  // will use `persist` + `syncMounts`; referenced here so the intent is explicit.
  void persist
}

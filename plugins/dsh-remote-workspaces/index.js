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
import os from 'node:os'
import Schema from '@deepseek-ai/schemastery'
import { createEgress, friendlyRemoteName, parseRemoteUrl } from './egress.mjs'
import { defaultStateFile, generateId, loadState, normalizeState, routeIdFor, saveState } from './state.mjs'

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
  // The client's envelope parser requires `error.details` to be an object;
  // errors forwarded from a remote or hand-built without one would otherwise
  // surface as "invalid server-response failure" and hide the real message.
  if (result?.ok === false && (typeof result.error?.details !== 'object' || result.error.details === null)) {
    result = { ok: false, error: { ...result.error, details: {} } }
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

  /** Serialize registry mutations so two panel actions cannot interleave writes. */
  let chain = Promise.resolve()
  const exclusive = fn => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => {})
    return next
  }
  const persist = () => saveState(stateFile, state)

  const snapshot = () => {
    const byServer = new Map(servers().map(server => [server.id, server]))
    const lastServer = [...byServer.values()].filter(server => server.lastUsedAt !== undefined)
      .sort((a, b) => String(b.lastUsedAt).localeCompare(String(a.lastUsedAt)))[0]
    return {
      routePrefix: prefix,
      lastServerUrl: lastServer?.url,
      servers: [...byServer.values()].map(server => ({
        id: server.id,
        url: server.url,
        label: server.label,
        seeded: server.seeded,
        hasToken: server.token !== undefined,
        localBase: `${prefix}/${server.id}/`,
        bridge: mounted.get(server.id)?.egress.status(),
      })),
      workspaces: [...state.workspaces].sort((a, b) => a.order - b.order).map(workspace => ({
        ...workspace,
        server: byServer.get(workspace.serverId) === undefined ? undefined : {
          id: workspace.serverId, label: byServer.get(workspace.serverId).label, localBase: `${prefix}/${workspace.serverId}/`,
        },
      })),
    }
  }

  const egressOf = (serverId) => {
    const entry = mounted.get(String(serverId ?? ''))
    if (entry === undefined) throw new Error(`no remote server "${String(serverId)}"`)
    return entry.egress
  }
  const workspaceOf = (id) => {
    const workspace = state.workspaces.find(candidate => candidate.id === String(id ?? ''))
    if (workspace === undefined) throw new Error(`no remote workspace "${String(id)}"`)
    return workspace
  }
  /** Unwrap a remote result or throw its message. */
  const must = (result, what) => {
    if (result.ok) return result.value
    throw new Error(`${what}: ${result.error?.message ?? result.error?.code ?? 'failed'}`)
  }
  const sessionRow = (item, remoteIndex) => ({
    id: item.sessionId,
    title: item.projections?.values?.title ?? '',
    updatedAt: new Date(Number(item.updatedAt) || 0).toISOString(),
    running: item.running === true,
    // The remote's account order is creation order for a workspace whose
    // rows were never dragged; `session.list` carries no createdAt.
    remoteIndex,
    ...(item.projections?.values?.permissions === undefined ? {} : { permissions: item.projections.values.permissions }),
  })

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
      sessions: items.slice(0, 20).map(item => ({ ...sessionRow(item), cwd: item.cwd })),
      bridge: entry.egress.status(),
    })
  }

  /**
   * Reach a remote by URL (+ optional token) and list its workspaces — the
   * add-remote modal's first step. Reuses a known server's bridge when the URL
   * is already registered and no different token is offered.
   */
  const probeServer = async (url, token) => {
    let remote
    try {
      remote = parseRemoteUrl(String(url ?? ''))
    } catch (error) {
      return fail('bad-url', String(error?.message ?? error))
    }
    const known = servers().find(server => parseRemoteUrl(server.url).url === remote.url)
    const offeredToken = typeof token === 'string' && token !== '' ? token : undefined
    const egress = known !== undefined && (offeredToken === undefined || offeredToken === known.token)
      ? egressOf(known.id)
      : createEgress({ id: 'probe', url: remote.url, localBase: `${prefix}/probe`, token: () => offeredToken ?? known?.token, log, warn })
    const started = Date.now()
    try {
      await egress.exchange()
    } catch (error) {
      return fail('unreachable', String(error?.message ?? error))
    }
    const listed = await egress.call('workspace', 'list', {})
    if (!listed.ok) {
      if (listed.error?.code === 'gateway/arguments-invalid' || String(listed.error?.message ?? '').includes('unknown method')) {
        return fail('old-remote', 'the remote DSH lacks workspace.list — it needs the feat/embed-session branch', { error: listed.error })
      }
      return listed
    }
    const items = Array.isArray(listed.value?.items) ? listed.value.items : []
    // Already mirrored here: the modal grays these out instead of adding twice.
    const mirrored = new Set(known === undefined ? [] : state.workspaces.filter(workspace => workspace.serverId === known.id).map(workspace => workspace.remoteWorkspaceId))
    return ok({
      url: remote.url,
      hostname: remote.hostname,
      serverId: known?.id,
      label: known?.label ?? friendlyRemoteName(remote.url),
      elapsedMs: Date.now() - started,
      mode: egress.status().mode,
      workspaces: items.map(view => ({
        workspaceId: view.workspaceId, path: view.path, title: view.title, sessionCount: view.sessionIds.length, mirrored: mirrored.has(view.workspaceId),
      })),
    })
  }

  /** Find or register the server for a URL; a token offered here becomes the stored one. */
  const ensureServer = async (url, token, label) => {
    const remote = parseRemoteUrl(String(url))
    const offeredToken = typeof token === 'string' && token !== '' ? token : undefined
    let server = state.servers.find(candidate => parseRemoteUrl(candidate.url).url === remote.url)
    const seeded = [...seeds.values()].find(candidate => parseRemoteUrl(candidate.url).url === remote.url)
    if (server === undefined && seeded !== undefined) {
      // Seeded servers are usable as-is; persisting one only when it gains a token or label.
      if (offeredToken === undefined || offeredToken === seeded.token) {
        seeded.lastUsedAt = new Date().toISOString()
        return seeded
      }
      server = { id: seeded.id, url: seeded.url, label: seeded.label }
      state.servers.push(server)
    }
    if (server === undefined) {
      const taken = new Set([...state.servers.map(candidate => candidate.id), ...seeds.keys()])
      server = { id: routeIdFor(label || friendlyRemoteName(remote.url), taken), url: remote.url, label: label || friendlyRemoteName(remote.url) }
      state.servers.push(server)
    }
    if (offeredToken !== undefined) server.token = offeredToken
    server.lastUsedAt = new Date().toISOString()
    await persist()
    syncMounts()
    return server
  }

  /**
   * Local manual order over the remote's order, like the local tree's
   * per-workspace order: ids the operator arranged keep their relative order;
   * sessions not yet arranged (new ones) stay in front, in the remote's order.
   */
  const applySessionOrder = (ids, order) => {
    if (!Array.isArray(order) || order.length === 0) return ids
    const present = new Set(ids)
    const arranged = order.filter(id => present.has(id))
    const arrangedSet = new Set(arranged)
    return [...ids.filter(id => !arrangedSet.has(id)), ...arranged]
  }

  /** Refresh one mirrored workspace from the remote: existence, path/title, visible sessions. */
  const pollWorkspace = async (workspace) => {
    const egress = egressOf(workspace.serverId)
    const baseline = must(await egress.call('workspace', 'list', {}), 'workspace.list')
    const view = (baseline.items ?? []).find(candidate => candidate.workspaceId === workspace.remoteWorkspaceId)
    if (view === undefined) {
      workspace.cache = { ...workspace.cache, gone: true, polledAt: new Date().toISOString() }
      await persist()
      return fail('gone', `the remote no longer has workspace "${workspace.title}"`, { workspace })
    }
    const archived = new Set(baseline.archivedSessionIds ?? [])
    const listed = must(await egress.call('session', 'list', { _request: {} }), 'session.list')
    const byId = new Map((listed.items ?? []).map(item => [item.sessionId, item]))
    const visible = view.sessionIds.filter(id => byId.has(id) && !archived.has(id) && byId.get(id).blank !== true)
    const sessions = applySessionOrder(visible, workspace.sessionOrder).map(id => sessionRow(byId.get(id), view.sessionIds.indexOf(id)))
    // Blank sessions (no turn yet) are not rows, but the browser needs their
    // ids: a blank session with a persisted draft gets a dimmed "ghost" row so
    // the draft stays reachable after switching away (local-tree parity).
    const blankIds = view.sessionIds.filter(id => byId.has(id) && !archived.has(id) && byId.get(id).blank === true)
    workspace.remotePath = view.path
    workspace.remoteTitle = view.title
    workspace.remoteCreatedAt = view.createdAt
    workspace.cache = { sessions, blankIds, polledAt: new Date().toISOString() }
    const server = state.servers.find(candidate => candidate.id === workspace.serverId)
    if (server !== undefined) server.lastUsedAt = workspace.cache.polledAt
    await persist()
    return ok({ workspace: snapshot().workspaces.find(candidate => candidate.id === workspace.id) })
  }

  const addWorkspace = (args) => exclusive(async () => {
    if (disposed) return fail('disposed', 'plugin is unloading')
    let server
    try {
      server = await ensureServer(args.url, args.token, args.label)
    } catch (error) {
      return fail('bad-url', String(error?.message ?? error))
    }
    const egress = egressOf(server.id)
    let view
    try {
      if (typeof args.remotePath === 'string' && args.remotePath.trim() !== '') {
        view = must(await egress.call('workspace', 'create', { request: { path: args.remotePath.trim() } }), 'workspace.create').workspace
      } else {
        const baseline = must(await egress.call('workspace', 'list', {}), 'workspace.list')
        view = (baseline.items ?? []).find(candidate => candidate.workspaceId === String(args.remoteWorkspaceId ?? ''))
        if (view === undefined) return fail('unknown-workspace', 'the remote has no such workspace')
      }
    } catch (error) {
      return fail('remote', String(error?.message ?? error))
    }
    const existing = state.workspaces.find(candidate => candidate.serverId === server.id && candidate.remoteWorkspaceId === view.workspaceId)
    if (existing !== undefined) {
      // Both picker paths land here: a grayed-out pick bypassed, or a typed
      // directory the remote resolved to a workspace this sidebar already has.
      return fail('already-added', `"${existing.title}" already mirrors ${view.title} (${view.path}) from ${server.label}`, { workspaceId: existing.id })
    }
    const workspace = {
      id: generateId('rws'),
      serverId: server.id,
      remoteWorkspaceId: view.workspaceId,
      title: String(args.title ?? '').trim() || `${server.label}-${view.title}`,
      remotePath: view.path,
      createdAt: new Date().toISOString(),
      order: state.workspaces.reduce((max, candidate) => Math.max(max, candidate.order), -1) + 1,
      cache: { sessions: [] },
    }
    state.workspaces.push(workspace)
    await persist()
    return pollWorkspace(workspace)
  })

  const removeWorkspace = id => exclusive(async () => {
    const before = state.workspaces.length
    state.workspaces = state.workspaces.filter(candidate => candidate.id !== String(id ?? ''))
    if (state.workspaces.length === before) return fail('unknown-workspace', `no remote workspace "${String(id)}"`)
    await persist()
    return ok(snapshot())
  })

  const renameWorkspace = (id, title) => exclusive(async () => {
    const workspace = workspaceOf(id)
    const next = String(title ?? '').trim()
    if (next === '') return fail('invalid', 'a title is required')
    workspace.title = next
    await persist()
    return ok(snapshot())
  })

  /** Persist a new order of the mirrored workspaces (ids in display order). */
  const reorderWorkspaces = ids => exclusive(async () => {
    const wanted = Array.isArray(ids) ? ids.map(String) : []
    const known = new Map(state.workspaces.map(workspace => [workspace.id, workspace]))
    let order = 0
    for (const id of wanted) if (known.has(id)) known.get(id).order = order++
    for (const workspace of [...state.workspaces].sort((a, b) => a.order - b.order)) if (!wanted.includes(workspace.id)) workspace.order = order++
    await persist()
    return ok(snapshot())
  })

  /** Persist the operator's session order within one mirrored workspace and re-project its cache. */
  const reorderSessions = (workspaceId, ids) => exclusive(async () => {
    const workspace = workspaceOf(workspaceId)
    workspace.sessionOrder = Array.isArray(ids) ? ids.map(String) : []
    const cachedIds = workspace.cache.sessions.map(session => session.id)
    const byId = new Map(workspace.cache.sessions.map(session => [session.id, session]))
    workspace.cache = { ...workspace.cache, sessions: applySessionOrder(cachedIds, workspace.sessionOrder).map(id => byId.get(id)) }
    await persist()
    return ok({ workspace: snapshot().workspaces.find(candidate => candidate.id === workspace.id) })
  })

  const renameSession = (workspaceId, sessionId, title) => exclusive(async () => {
    const workspace = workspaceOf(workspaceId)
    const egress = egressOf(workspace.serverId)
    const result = await egress.call('session', 'rename', { request: { sessionId: String(sessionId), title: String(title ?? '').trim() } })
    if (!result.ok) return result
    return pollWorkspace(workspace)
  })

  const archiveSession = (workspaceId, sessionId) => exclusive(async () => {
    const workspace = workspaceOf(workspaceId)
    const egress = egressOf(workspace.serverId)
    const result = await egress.call('workspace', 'archiveSession', { request: { sessionId: String(sessionId) } })
    if (!result.ok) return result
    return pollWorkspace(workspace)
  })

  /**
   * Start a session in a remote workspace the way the local shell does for a
   * local one: reuse that workspace's blank session or create one. The
   * embedded page then shows the remote's own composer (its models, presets,
   * attachments, and draft persistence), so nothing else is sent until the
   * operator submits there.
   */
  const startSession = workspaceId => exclusive(async () => {
    const workspace = workspaceOf(workspaceId)
    const egress = egressOf(workspace.serverId)
    const baseline = must(await egress.call('workspace', 'list', {}), 'workspace.list')
    const view = (baseline.items ?? []).find(candidate => candidate.workspaceId === workspace.remoteWorkspaceId)
    if (view === undefined) return fail('gone', `the remote no longer has workspace "${workspace.title}"`)
    const archived = new Set(baseline.archivedSessionIds ?? [])
    const listed = must(await egress.call('session', 'list', { _request: {} }), 'session.list')
    const blank = (listed.items ?? []).find(item => item.blank === true && item.cwd === view.path
      && view.sessionIds.includes(item.sessionId) && !archived.has(item.sessionId))
    if (blank !== undefined) return ok({ sessionId: blank.sessionId, created: false })
    const created = must(await egress.call('session', 'create', { request: { workspaceId: view.workspaceId } }), 'session.create')
    return ok({ sessionId: created.sessionId, created: true })
  })

  // ---- moving sessions across hosts -------------------------------------
  //
  // Local operations go through the local Connection's own fetch handler
  // in-process (same code path the browser's requests take after the
  // Host/Origin fence), so no token or cookie is involved. Remote operations
  // go through the egress (Typert `call` for JSON, `fetchRaw` for the export
  // and import routes' binary bodies).

  const localApi = ctx.connection.createSharedFetchHandler('/api')
  const LOCAL_ORIGIN = 'http://dsh.local'
  /** Call a local Typert Remote in-process. */
  const localCall = async (namespace, method, args) => {
    const rpcId = crypto.randomUUID()
    const response = await localApi.fetch(new Request(`${LOCAL_ORIGIN}/api/${namespace}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: `${namespace}/${method}`, payload: { args } }),
    }))
    const envelope = await response.json().catch(() => undefined)
    if (typeof envelope !== 'object' || envelope === null || typeof envelope.result !== 'object') {
      return { ok: false, error: { code: 'remote-workspaces/bad-response', message: `local ${namespace}.${method} answered HTTP ${String(response.status)}` } }
    }
    return envelope.result
  }
  /** Read the local export ZIP of one session (with descendants) as a Buffer. */
  const localExport = async (sessionId) => {
    const response = await localApi.fetch(new Request(`${LOCAL_ORIGIN}/api/session.export?sessionId=${encodeURIComponent(sessionId)}&includeDescendants=true`))
    if (response.status !== 200) throw new Error(`local export failed: HTTP ${String(response.status)} ${await response.text()}`)
    return Buffer.from(await response.arrayBuffer())
  }
  /** Import one ZIP Buffer into a local workspace; returns the import result. */
  const localImport = async (zip, destination, origin) => {
    const query = 'workspaceId' in destination
      ? `workspaceId=${encodeURIComponent(destination.workspaceId)}`
      : `cwd=${encodeURIComponent(destination.path)}`
    const response = await localApi.fetch(new Request(`${LOCAL_ORIGIN}/api/session.import?${query}&origin=${encodeURIComponent(origin)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/zip' },
      body: zip,
    }))
    const text = await response.text()
    if (response.status !== 200) throw new Error(`local import failed: HTTP ${String(response.status)} ${text}`)
    return JSON.parse(text)
  }
  /** Read a remote session's export ZIP as a Buffer. */
  const remoteExport = async (egress, sessionId) => {
    const response = await egress.fetchRaw('GET', `/api/session.export?sessionId=${encodeURIComponent(sessionId)}&includeDescendants=true`)
    const chunks = []
    for await (const chunk of response) chunks.push(chunk)
    if (response.statusCode !== 200) throw new Error(`remote export failed: HTTP ${String(response.statusCode)} ${Buffer.concat(chunks).toString('utf8').slice(0, 300)}`)
    return Buffer.concat(chunks)
  }
  /** Import one ZIP Buffer into a remote workspace. */
  const remoteImport = async (egress, zip, remoteWorkspaceId, origin) => {
    const response = await egress.fetchRaw('POST',
      `/api/session.import?workspaceId=${encodeURIComponent(remoteWorkspaceId)}&origin=${encodeURIComponent(origin)}`,
      { body: zip, headers: { 'content-type': 'application/zip' } })
    const chunks = []
    for await (const chunk of response) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString('utf8')
    if (response.statusCode !== 200) throw new Error(`remote import failed: HTTP ${String(response.statusCode)} ${text.slice(0, 300)}`)
    return JSON.parse(text)
  }
  const hostLabel = () => os.hostname()
  const remoteLabel = (serverId) => {
    const server = state.servers.find(candidate => candidate.id === serverId)
    return server?.label ?? serverId
  }
  /** Is the session resident on the given remote right now (`running` or open)? Cheap check via its list row. */
  const remoteSessionLive = async (egress, sessionId) => {
    const listed = await egress.call('session', 'list', { _request: {} })
    if (!listed.ok) return false
    const row = (listed.value.items ?? []).find(item => item.sessionId === sessionId)
    return row?.running === true
  }

  /**
   * Move a session between two workspaces of the same remote: the remote's
   * own `session.move`, refusals passed through as-is (the UI answers
   * `session/move-live` with stop-and-move).
   */
  const moveSessionWithinRemote = (fromWorkspaceId, sessionId, toWorkspaceId, stopLive) => exclusive(async () => {
    const from = workspaceOf(fromWorkspaceId)
    const to = workspaceOf(toWorkspaceId)
    if (from.serverId !== to.serverId) return fail('cross-remote', 'use sessions.transfer for moves between different remotes')
    const egress = egressOf(from.serverId)
    const result = await egress.call('session', 'move', { request: {
      sessionId: String(sessionId), destination: { workspaceId: to.remoteWorkspaceId }, stopLive: stopLive === true,
    } })
    if (!result.ok) return result
    await pollWorkspace(from)
    return pollWorkspace(to)
  })

  /**
   * Move a session across hosts: export at the source, import at the
   * destination, then archive the source copy (kept as a tombstone rather
   * than deleted — the one place a bug would lose work). Source and
   * destination are each `{ local: true, sessionId?, workspaceId? }` or
   * `{ workspaceId: <remote workspace id> }`. A source session that is live
   * refuses unless `stopLive`.
   */
  const transferSession = (spec) => exclusive(async () => {
    const { sessionId } = spec
    const source = spec.source
    const destination = spec.destination
    if (source.local === true && destination.local === true) return fail('bad-request', 'a local→local move is session.move, not a transfer')
    // 1. Source liveness.
    if (source.local === true) {
      const listed = await localCall('session', 'list', { _request: {} })
      const row = listed.ok ? (listed.value.items ?? []).find(item => item.sessionId === sessionId) : undefined
      if (row === undefined) return fail('missing', `no local session "${String(sessionId)}"`)
      // A running turn, background jobs or loaded subagents all die with the
      // agent; the wire error carries `details` (the client rejects an
      // error envelope without an object there).
      if (row.running === true && spec.stopLive !== true) {
        return { ok: false, error: { code: 'session/move-live', message: 'the session is running; stop it first or move with stopLive', details: { sessionId, blockers: [{ kind: 'turn' }] } } }
      }
      if (row.running === true) {
        const cancelled = await localCall('session', 'cancel', { request: { sessionId } })
        if (!cancelled.ok) return cancelled
      }
    } else {
      const from = workspaceOf(source.workspaceId)
      const egress = egressOf(from.serverId)
      if (await remoteSessionLive(egress, sessionId)) {
        if (spec.stopLive !== true) {
          return { ok: false, error: { code: 'session/move-live', message: 'the remote session is running; stop it first or move with stopLive', details: { sessionId, blockers: [{ kind: 'turn' }] } } }
        }
        const cancelled = await egress.call('session', 'cancel', { request: { sessionId } })
        if (!cancelled.ok) return cancelled
      }
    }
    // 2. Export at the source.
    const originLabel = source.local === true ? `${hostLabel()} (local)` : remoteLabel(workspaceOf(source.workspaceId).serverId)
    const zip = source.local === true
      ? await localExport(sessionId)
      : await remoteExport(egressOf(workspaceOf(source.workspaceId).serverId), sessionId)
    // 3. Import at the destination.
    let imported
    if (destination.local === true) {
      imported = await localImport(zip, destination.workspaceId !== undefined ? { workspaceId: destination.workspaceId } : { path: destination.path }, originLabel)
    } else {
      const to = workspaceOf(destination.workspaceId)
      imported = await remoteImport(egressOf(to.serverId), zip, to.remoteWorkspaceId, originLabel)
      await pollWorkspace(to)
    }
    // 4. Archive the source copy (tombstone); never delete.
    if (source.local === true) {
      await localCall('workspace', 'archiveSession', { request: { sessionId } })
    } else {
      const from = workspaceOf(source.workspaceId)
      await egressOf(from.serverId).call('workspace', 'archiveSession', { request: { sessionId } })
      await pollWorkspace(from)
    }
    return ok({ sessionId: imported.sessionId, imported: imported.imported, bytes: zip.byteLength })
  })

  const dispatch = async (endpoint, payload) => {
    await boot
    const args = typeof payload === 'object' && payload !== null && typeof payload.args === 'object' && payload.args !== null ? payload.args : {}
    try {
      switch (endpoint) {
        case 'status': return ok(snapshot())
        case 'probe': return probe(args.serverId)
        case 'servers.probe': return probeServer(args.url, args.token)
        case 'workspaces.add': return addWorkspace(args)
        case 'workspaces.poll': return exclusive(() => pollWorkspace(workspaceOf(args.id)))
        case 'workspaces.remove': return removeWorkspace(args.id)
        case 'workspaces.rename': return renameWorkspace(args.id, args.title)
        case 'workspaces.reorder': return reorderWorkspaces(args.ids)
        case 'sessions.reorder': return reorderSessions(args.workspaceId, args.ids)
        case 'sessions.rename': return renameSession(args.workspaceId, args.sessionId, args.title)
        case 'sessions.archive': return archiveSession(args.workspaceId, args.sessionId)
        case 'sessions.start': return startSession(args.workspaceId)
        case 'sessions.move': return moveSessionWithinRemote(args.fromWorkspaceId, args.sessionId, args.toWorkspaceId, args.stopLive)
        case 'sessions.transfer': return transferSession(args)
        default: return fail('unknown-endpoint', `unknown endpoint ${endpoint}`)
      }
    } catch (error) {
      return fail('failed', String(error?.message ?? error))
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
      // Servers labelled by the old derivation (bare first hostname label,
      // e.g. "127") get the friendly name; ids stay so routes and frames hold.
      let relabelled = false
      for (const server of state.servers) {
        let remote
        try { remote = parseRemoteUrl(server.url) } catch { continue }
        if (server.label === remote.hostname.split('.')[0] && server.label !== friendlyRemoteName(server.url)) {
          server.label = friendlyRemoteName(server.url)
          relabelled = true
        }
      }
      if (relabelled) await persist()
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
}

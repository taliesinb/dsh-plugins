/**
 * dsh-tailscale-remote — drive this DSH Web GUI from another device on the
 * tailnet, at `https://<node>.<tailnet>.ts.net/dsh/`.
 *
 * One feature, deliberately: an authenticating loopback reverse proxy
 * (proxy.mjs) published by `tailscale serve` on a path mount (tailscale.mjs),
 * with a "Tailscale remote" settings section (src/client) offering Enable /
 * Disable, the URL with copy-to-clipboard, a comma-separated allowlist of
 * tailnet logins that may enter without a token, and a QR code that carries
 * the standing token so any device that scans it is let in.
 *
 * Requires the DSH branch `fix/tailscale-mounting` (document-relative Host
 * URLs); on stock DSH the shell's `/api`, `/plugins` and WebSocket URLs escape
 * the `/dsh` mount and 404.
 *
 * This Mac's own Dock app rides the same route: the node's own login is
 * always admitted (Serve injects it for the node's requests to itself), so
 * the WKWebView wrapper in dock-app/ needs no token or cookie. An always-on
 * relay (relay/) can sit between `tailscale serve` and the proxy so the Dock
 * app also works when DSH is not running (it starts it). Both are installed
 * from the settings section or the pnpm scripts.
 *
 * Node half only here; the browser half is `./client` (lib/client.js). Config:
 *   listenHost   loopback address of the proxy                     127.0.0.1
 *   listenPort   proxy port                                        3084
 *   publishPort  port tailscale serve points at: the relay's port, or 0 to
 *                publish the proxy itself                           3083
 *   mountPath    path mount on the node                           /dsh
 *   servePort    HTTPS port on the node                           443
 *   tailscalePath  CLI path override ('' = PATH / app bundle)     ''
 *   stateFile    persisted intent + token ('' = $DSH_HOME/tailscale-remote.json)
 *   cookieName   the proxy's own session cookie                   dsh-tailscale-remote
 *   relayStart   shell command the relay runs to start DSH        pnpm dsh web --no-open
 *   relayCwd     where it runs ('' = this process's cwd)           ''
 *   relayLogDir  relay + DSH logs ('' = $DSH_HOME/logs)            ''
 *   dockAppName  bundle name under ~/Applications                 DSH
 *   dockAppGlyphColor / dockAppTileColor  icon colours            #000000 / #ffffff
 */
import Schema from '@deepseek-ai/schemastery'
import { renderSVG } from 'uqr'
import { dockAppStatus, installDockApp, uninstallDockApp } from './dock-app.mjs'
import { startProxy } from './proxy.mjs'
import { defaultLogDir, installRelayAgent, relayStatus, uninstallRelayAgent } from './relay/launch-agent.mjs'
import { defaultStateFile, generateToken, loadState, parseUserList, saveState } from './state.mjs'
import { createTailscaleManager, normalizeMountPath } from './tailscale.mjs'

export const name = 'tailscale-remote'
export const inject = ['webServer', 'connection']

export const Config = Schema.object({
  listenHost: Schema.string().default('127.0.0.1'),
  listenPort: Schema.natural().max(65535).default(3084),
  publishPort: Schema.natural().max(65535).default(3083),
  mountPath: Schema.string().default('/dsh'),
  servePort: Schema.natural().min(1).max(65535).default(443),
  tailscalePath: Schema.string().default(''),
  stateFile: Schema.string().default(''),
  cookieName: Schema.string().default('dsh-tailscale-remote'),
  relayStart: Schema.string().default('pnpm dsh web --no-open'),
  relayCwd: Schema.string().default(''),
  relayLogDir: Schema.string().default(''),
  dockAppName: Schema.string().default('DSH'),
  dockAppGlyphColor: Schema.string().default('#000000'),
  dockAppTileColor: Schema.string().default('#ffffff'),
})

/** RPC channel the browser half calls (`POST /tailscale-remote/<endpoint>`); the proxy refuses to forward it. */
export const CONTROL_CHANNEL = '/tailscale-remote'

const TOKEN_QUERY = 'token'

function qrSvg(text) {
  try {
    return renderSVG(text, { ecc: 'M', border: 2 })
  } catch {
    return undefined
  }
}

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
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ requestRejection(req: unknown): number | undefined }} connection
 * @param {(endpoint: string, payload: unknown) => Promise<unknown>} dispatch
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
    result = { ok: false, error: { code: 'tailscale-remote/internal', message: String(error?.message ?? error), details: {} } }
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
  const mountPath = normalizeMountPath(config.mountPath)
  const log = message => ctx.logger.info(message)
  const warn = message => ctx.logger.warn(message)

  /** @type {{ version: number, enabled: boolean, allowedUsers: string[], token: string }} */
  let state
  /** @type {Awaited<ReturnType<typeof startProxy>> | undefined} */
  let proxy
  let disposed = false
  /** Serialize enable/disable/rotate so two panel clicks cannot interleave CLI calls. */
  let chain = Promise.resolve()
  const exclusive = fn => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => {})
    return next
  }

  /** What Serve publishes: the relay (publishPort) or the proxy listener itself. */
  const publishedTarget = () => (config.publishPort !== 0 ? `http://127.0.0.1:${String(config.publishPort)}` : proxy?.url ?? '')
  const publishedPort = () => (config.publishPort !== 0 ? config.publishPort : proxy?.port ?? config.listenPort)

  const tailscale = createTailscaleManager({
    configuredPath: config.tailscalePath,
    port: config.servePort,
    mountPath,
    target: publishedTarget,
    log,
  })

  /** Last `tailscale status` that knew this node: the proxy's identity facts (self login/addresses, public host). */
  let lastRoute
  const routeStatus = async () => {
    const route = await tailscale.status()
    if (route.dnsName !== undefined) lastRoute = route
    return route
  }
  const publicHosts = () => {
    const hosts = []
    if (lastRoute?.dnsName !== undefined) hosts.push(lastRoute.dnsName, `${lastRoute.dnsName}:${String(config.servePort)}`)
    if (config.publishPort !== 0) hosts.push(`127.0.0.1:${String(config.publishPort)}`, `localhost:${String(config.publishPort)}`)
    return hosts
  }

  const persist = () => saveState(stateFile, state)

  const ensureProxy = async () => {
    if (proxy !== undefined) return proxy
    await routeStatus()
    proxy = await startProxy({
      listenHost: config.listenHost,
      listenPort: config.listenPort,
      backendHost: '127.0.0.1',
      backendPort: ctx.webServer.port,
      connection: ctx.connection,
      token: () => state.token,
      allowedUsers: () => state.allowedUsers,
      selfLogin: () => lastRoute?.selfLogin,
      selfAddresses: () => lastRoute?.selfAddresses ?? [],
      publicHosts,
      cookieName: config.cookieName,
      controlPrefix: CONTROL_CHANNEL,
      mountPath,
      log,
      warn,
    })
    log(`tailscale-remote: proxy ${proxy.url} -> http://127.0.0.1:${String(ctx.webServer.port)}${config.publishPort !== 0 ? ` (published through the relay on :${String(config.publishPort)})` : ''}`)
    return proxy
  }

  const relayCwd = config.relayCwd || process.cwd()
  const relayLogDir = config.relayLogDir || defaultLogDir()
  const relaySpec = () => ({
    listen: `127.0.0.1:${String(config.publishPort)}`,
    backend: `${config.listenHost}:${String(config.listenPort)}`,
    dsh: `127.0.0.1:${String(ctx.webServer.port)}`,
    cwd: relayCwd,
    start: config.relayStart,
    logDir: relayLogDir,
  })
  /** Where the Dock app goes when the tailnet is unreachable: the relay (or proxy) on loopback, token exchange included. */
  const fallbackUrl = () => `http://127.0.0.1:${String(publishedPort())}/`

  const stopProxy = async () => {
    const current = proxy
    proxy = undefined
    if (current !== undefined) await current.close()
  }

  const snapshot = async () => {
    const route = await routeStatus()
    const url = route.url
    const tokenUrl = url === undefined ? undefined : `${url}?${TOKEN_QUERY}=${encodeURIComponent(state.token)}`
    const [relay, dockApp] = await Promise.all([
      config.publishPort !== 0 ? relayStatus({ listenPort: config.publishPort }) : Promise.resolve(undefined),
      dockAppStatus({ name: config.dockAppName, url: url ?? '' }),
    ])
    return {
      enabled: state.enabled,
      proxyRunning: proxy !== undefined,
      proxyUrl: proxy?.url,
      route: route.state,
      detail: route.detail,
      dnsName: route.dnsName,
      mappedTarget: route.mappedTarget,
      url,
      tokenUrl,
      qrSvg: tokenUrl === undefined ? undefined : qrSvg(tokenUrl),
      allowedUsers: state.allowedUsers,
      selfLogin: route.selfLogin ?? lastRoute?.selfLogin,
      mountPath,
      servePort: config.servePort,
      publishPort: config.publishPort,
      relay: relay === undefined ? undefined : { ...relay, spec: relaySpec() },
      dockApp: { ...dockApp, name: config.dockAppName, fallbackUrl: fallbackUrl() },
    }
  }

  const ok = value => ({ ok: true, value })
  const fail = (code, message, details = {}) => ({ ok: false, error: { code: `tailscale-remote/${code}`, message, details } })

  const enable = () => exclusive(async () => {
    if (disposed) return fail('disposed', 'plugin is unloading')
    try {
      await ensureProxy()
    } catch (error) {
      return fail('proxy', `could not start the proxy on ${config.listenHost}:${String(config.listenPort)}: ${String(error?.message ?? error)}`)
    }
    const outcome = await tailscale.enable()
    if (outcome !== 'ok') {
      await stopProxy()
      const route = await routeStatus()
      const reasons = {
        'unavailable': `Tailscale is not available (${route.detail ?? 'unknown'}): is the Tailscale app running and logged in?`,
        'conflict': `${mountPath} on this node is already mapped to ${route.mappedTarget ?? 'another service'}`,
        'failed': 'tailscale serve failed — see the DSH log',
        'verify-failed': 'tailscale serve returned success but the route did not appear',
      }
      return fail(outcome, reasons[outcome] ?? outcome, { route })
    }
    state.enabled = true
    await persist()
    return ok(await snapshot())
  })

  const disable = () => exclusive(async () => {
    const outcome = await tailscale.disable()
    if (outcome === 'failed') return fail('failed', 'tailscale serve off failed — see the DSH log')
    await stopProxy()
    state.enabled = false
    await persist()
    return ok(await snapshot())
  })

  const setUsers = value => exclusive(async () => {
    state.allowedUsers = parseUserList(value)
    await persist()
    return ok(await snapshot())
  })

  const rotateToken = () => exclusive(async () => {
    state.token = generateToken()
    await persist()
    return ok(await snapshot())
  })

  const installDock = () => exclusive(async () => {
    const route = await routeStatus()
    if (route.url === undefined) return fail('no-route', 'Tailscale hostname unknown: is Tailscale running and logged in?')
    if (route.selfLogin === undefined) return fail('tagged-node', 'This node has no Tailscale user (tagged device), so its own requests would carry no identity; the Dock app would need the QR token instead.')
    try {
      const result = await installDockApp({
        name: config.dockAppName,
        url: route.url,
        fallbackUrl: fallbackUrl(),
        tokenFile: stateFile,
        glyphColor: config.dockAppGlyphColor,
        tileColor: config.dockAppTileColor,
        log,
      })
      log(`tailscale-remote: Dock app installed at ${result.path} (replaced: ${result.replaced}, pinned: ${String(result.pinned)})`)
    } catch (error) {
      return fail('dock-app', String(error?.message ?? error))
    }
    return ok(await snapshot())
  })

  const uninstallDock = () => exclusive(async () => {
    try {
      await uninstallDockApp({ name: config.dockAppName })
    } catch (error) {
      return fail('dock-app', String(error?.message ?? error))
    }
    return ok(await snapshot())
  })

  const installRelay = () => exclusive(async () => {
    if (config.publishPort === 0) return fail('no-relay', 'publishPort is 0: the proxy is published directly, there is no relay to install')
    try {
      const result = await installRelayAgent({ ...relaySpec(), log })
      if (!result.listening) warn(`tailscale-remote: relay LaunchAgent loaded but 127.0.0.1:${String(config.publishPort)} is not answering yet — see ${relayLogDir}/relay.log`)
    } catch (error) {
      return fail('relay', String(error?.message ?? error))
    }
    return ok(await snapshot())
  })

  const uninstallRelay = () => exclusive(async () => {
    try {
      await uninstallRelayAgent({ log })
    } catch (error) {
      return fail('relay', String(error?.message ?? error))
    }
    return ok(await snapshot())
  })

  // ---- control channel (never forwarded by the proxy) --------------------
  // Registered straight on the web server with DSH's own request gate
  // (Host/Origin fence + browser-session cookie) rather than through
  // `ctx.connection.rpc.handle`: that helper resolves `webServer` through the
  // traceable service context and fails with "cannot get property webServer
  // without inject" on DSH master as of 2026-09-15 (no in-tree caller uses it).
  // Wire shape is the Connection envelope, so the browser half keeps using
  // `ctx.connection.rpc.call(CONTROL_CHANNEL, endpoint, { args })`.
  const dispatch = async (endpoint, payload) => {
    await boot
    const args = typeof payload === 'object' && payload !== null && typeof payload.args === 'object' && payload.args !== null ? payload.args : {}
    switch (endpoint) {
      case 'status': return ok(await snapshot())
      case 'enable': return enable()
      case 'disable': return disable()
      case 'set-users': return setUsers(args.allowedUsers)
      case 'rotate-token': return rotateToken()
      case 'install-dock-app': return installDock()
      case 'uninstall-dock-app': return uninstallDock()
      case 'install-relay': return installRelay()
      case 'uninstall-relay': return uninstallRelay()
      default: return fail('unknown-endpoint', `unknown endpoint ${endpoint}`)
    }
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CONTROL_CHANNEL,
    handler: (req, res) => controlRoute(req, res, ctx.connection, dispatch),
  }), 'tailscale-remote: control channel')

  // ---- boot: restore persisted intent -----------------------------------
  const boot = (async () => {
    state = await loadState(stateFile)
    if (!state.enabled || disposed) return
    try {
      await ensureProxy()
      const route = await routeStatus()
      if (route.state !== 'active') {
        const outcome = await tailscale.enable()
        if (outcome !== 'ok') warn(`tailscale-remote: persisted route could not be republished (${outcome}); the proxy stays up on ${proxy?.url ?? ''}`)
      }
    } catch (error) {
      warn(`tailscale-remote: persisted start skipped: ${String(error?.message ?? error)}`)
    }
  })()

  ctx.effect(() => () => {
    disposed = true
    // The tailscale route is intent that survives DSH restarts (tailscaled
    // persists it); only the loopback listener belongs to this process.
    return boot.then(() => chain).then(stopProxy)
  }, 'tailscale-remote: proxy listener')
}

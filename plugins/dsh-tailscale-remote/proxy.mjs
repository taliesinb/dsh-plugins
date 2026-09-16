/**
 * Loopback reverse proxy that Tailscale Serve publishes at `https://<node>/dsh/`.
 *
 * Every request is admitted by exactly one of:
 *   1. an allowlisted tailnet user — `Tailscale-User-Login` injected by Serve,
 *      trusted only when the forwarding facts look like a Serve peer (loopback
 *      socket, rightmost `x-forwarded-for` inside Tailscale's address ranges);
 *   2. the standing token as `?token=` on a GET of `/` (what the QR encodes) —
 *      exchanged for the proxy's own HttpOnly cookie and redirected to `./`;
 *   3. that cookie.
 * Anything else is 401. The DSH control channel of this plugin
 * (`/tailscale-remote/*`) is never forwarded, so the remote page cannot flip
 * the route or read the token.
 *
 * Admitted requests are forwarded to DSH on loopback with `Host`/`Origin`
 * rewritten to the loopback authority (DSH's /api Host+Origin fence) and the
 * browser's cookies replaced by the DSH browser-session cookie this process
 * obtained by exchanging its own launch token. WebSocket upgrades take the
 * same gate. Tailscale strips the `/dsh` mount before we see the path, so
 * `https://node/dsh` and `https://node/dsh/` both arrive as `/`; index
 * responses therefore carry a head script that adds the missing trailing
 * slash — without it the shell's document-relative asset URLs would resolve
 * at the site root.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { normalizeLogin } from './state.mjs'
import { isTailscaleAddress, TAILSCALE_IDENTITY_HEADERS, TAILSCALE_LOGIN_HEADER } from './tailscale.mjs'

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade'])
/** Request headers we never forward: forwarding facts (re-derived), browser cookies (replaced), fetch metadata (re-set). */
const DROPPED_REQUEST_HEADERS = new Set([
  'host', 'cookie', 'origin', 'referer', 'referrer',
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-proto', 'x-real-ip',
  'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user',
  ...TAILSCALE_IDENTITY_HEADERS,
])
const TOKEN_QUERY = 'token'
/** Public shell files DSH itself serves unauthenticated; browsers fetch a manifest without cookies. */
const PUBLIC_PATHS = new Set(['/manifest.webmanifest', '/favicon.svg'])
const UPSTREAM_COOKIE_TTL_MS = 6 * 60 * 60 * 1000
const MAX_REQUEST_BYTES = 64 * 1024 * 1024
/** Runs before any other head script: fixes `https://node/dsh` → `https://node/dsh/`. */
const TRAILING_SLASH_GUARD = '<script data-plugin="dsh-tailscale-remote">(function(){var p=location.pathname;'
  + 'if(!p.endsWith("/")&&!p.endsWith("/index.html"))location.replace(p+"/"+location.search+location.hash)})()</script>'

function isLoopbackAddress(address) {
  const ip = String(address ?? '').replace(/^::ffff:/i, '')
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.')
}

function lastHeader(value) {
  const text = Array.isArray(value) ? value[value.length - 1] : value
  const parts = String(text ?? '').split(',').map(part => part.trim()).filter(Boolean)
  return parts[parts.length - 1]
}

/**
 * Whether the request's forwarding facts are consistent with a Tailscale Serve
 * peer. Serve forces `x-forwarded-for` to the peer's tailnet address, and a
 * non-tailnet client can never be the last hop with a CGNAT/ULA address.
 */
export function looksLikeServePeer(req) {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false
  const last = lastHeader(req.headers['x-forwarded-for'])
  return last !== undefined && isTailscaleAddress(last)
}

/** Verified login of an allowlisted tailnet user, or undefined. */
export function identityOf(req, allowedUsers) {
  if (allowedUsers.length === 0) return undefined
  const raw = req.headers[TAILSCALE_LOGIN_HEADER]
  const login = normalizeLogin(Array.isArray(raw) ? raw[0] : raw)
  if (login === '' || !allowedUsers.includes(login)) return undefined
  return looksLikeServePeer(req) ? login : undefined
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8')
  const right = Buffer.from(String(b), 'utf8')
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

/** Cookie value derived from the token: rotating the token invalidates every device, and a leaked cookie does not reveal the QR URL. */
export function cookieValueFor(token) {
  return createHmac('sha256', token).update('dsh-tailscale-remote/cookie/v1').digest('base64url')
}

function cookieOf(header, name) {
  for (const segment of String(header ?? '').split(';')) {
    const at = segment.indexOf('=')
    if (at !== -1 && segment.slice(0, at).trim() === name) return segment.slice(at + 1).trim()
  }
  return undefined
}

function requestIsHttps(req) {
  const proto = Array.isArray(req.headers['x-forwarded-proto']) ? req.headers['x-forwarded-proto'][0] : req.headers['x-forwarded-proto']
  return isLoopbackAddress(req.socket.remoteAddress) && String(proto ?? '').split(',')[0].trim().toLowerCase() === 'https'
}

function pathnameOf(url) {
  try {
    return new URL(url ?? '/', 'http://x').pathname
  } catch {
    return '/'
  }
}

function drain(req) {
  if (!req.readableEnded) req.resume()
}

function sendText(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(body)
}

function unauthorizedPage(res, req, message) {
  const accept = String(req.headers.accept ?? '')
  if (req.method === 'GET' && accept.includes('text/html')) {
    res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>DSH remote</title>`
      + `<body style="font:16px -apple-system,system-ui,sans-serif;padding:2em;max-width:36em;margin:auto;color:#222">`
      + `<h1 style="font-size:1.3em">Not authorized</h1><p>${message}</p>`
      + `<p style="color:#666">Open <b>Settings → Tailscale remote</b> on the DSH host: scan the QR code, or add your Tailscale login to the allowed users.</p></body>`)
    return
  }
  sendText(res, 401, `unauthorized: ${message}\n`)
}

function forwardHeaders(req, backendAuthority, upstreamCookie, extra = {}) {
  const headers = {}
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase()
    if (value === undefined || HOP_BY_HOP.has(lower) || DROPPED_REQUEST_HEADERS.has(lower)) continue
    headers[lower] = value
  }
  headers.host = backendAuthority
  // DSH's fence: an attached Origin must equal the Host authority; the page
  // really is same-origin with DSH from the proxy's point of view.
  if (req.headers.origin !== undefined) headers.origin = `http://${backendAuthority}`
  headers['sec-fetch-site'] = 'same-origin'
  headers['x-forwarded-for'] = lastHeader(req.headers['x-forwarded-for']) ?? req.socket.remoteAddress ?? ''
  headers['x-forwarded-host'] = req.headers.host ?? ''
  headers['x-forwarded-proto'] = requestIsHttps(req) ? 'https' : 'http'
  headers['x-dsh-tailscale-remote'] = '1'
  if (upstreamCookie !== undefined) headers.cookie = upstreamCookie
  return { ...headers, ...extra }
}

function relayHeaders(headers, keep = new Set()) {
  const out = {}
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase()
    if (value === undefined || lower === 'set-cookie') continue
    if (HOP_BY_HOP.has(lower) && !keep.has(lower)) continue
    out[key] = value
  }
  return out
}

/**
 * Exchange DSH's process launch token for its browser-session cookie, bound to
 * the loopback authority every forwarded request will carry as `Host`.
 * @param {{ authenticatedUrl(base: string): string }} connection
 * @param {string} authority `127.0.0.1:<dsh port>`
 * @returns {Promise<string>} `name=value`
 */
export function bootstrapUpstreamCookie(connection, authority) {
  const launch = new URL(connection.authenticatedUrl(`http://${authority}`))
  return new Promise((resolve, reject) => {
    const up = httpRequest({
      hostname: launch.hostname,
      port: launch.port,
      method: 'GET',
      path: `${launch.pathname}${launch.search}`,
      headers: { host: authority, connection: 'close' },
    }, (response) => {
      const cookie = (response.headers['set-cookie'] ?? []).find(value => value.includes('='))?.split(';', 1)[0]
      const status = response.statusCode ?? 0
      response.resume()
      response.once('end', () => {
        if (status >= 300 && status < 400 && cookie !== undefined) resolve(cookie)
        else reject(new Error(`tailscale-remote: DSH browser-session exchange answered HTTP ${String(status)}`))
      })
    })
    up.once('error', reject)
    up.end()
  })
}

/**
 * @param {{
 *   listenHost: string, listenPort: number,
 *   backendHost: string, backendPort: number,
 *   connection: { authenticatedUrl(base: string): string },
 *   token: () => string, allowedUsers: () => string[],
 *   cookieName: string, controlPrefix: string, mountPath?: string,
 *   log?: (line: string) => void, warn?: (line: string) => void,
 * }} spec
 */
export async function startProxy(spec) {
  const backendAuthority = `${spec.backendHost}:${String(spec.backendPort)}`
  const mount = String(spec.mountPath ?? '/').replace(/\/+$/, '') || '/'
  let upstreamCookie = await bootstrapUpstreamCookie(spec.connection, backendAuthority)
  let upstreamCookieAt = Date.now()
  let refreshing

  const refreshUpstreamCookie = () => {
    refreshing ??= bootstrapUpstreamCookie(spec.connection, backendAuthority).then((cookie) => {
      upstreamCookie = cookie
      upstreamCookieAt = Date.now()
    }).catch((error) => {
      spec.warn?.(`tailscale-remote: refreshing the DSH session cookie failed: ${String(error?.message ?? error)}`)
    }).finally(() => { refreshing = undefined })
    return refreshing
  }
  const cookieForUpstream = () => {
    if (Date.now() - upstreamCookieAt > UPSTREAM_COOKIE_TTL_MS) void refreshUpstreamCookie()
    return upstreamCookie
  }

  const sockets = new Set()
  const track = (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  }

  /** @returns {{ kind: 'user', login: string } | { kind: 'cookie' } | undefined} */
  const admit = (req) => {
    const login = identityOf(req, spec.allowedUsers())
    if (login !== undefined) return { kind: 'user', login }
    const cookie = cookieOf(req.headers.cookie, spec.cookieName)
    if (cookie !== undefined && safeEqual(cookie, cookieValueFor(spec.token()))) return { kind: 'cookie' }
    return undefined
  }

  /**
   * Where the token exchange lands. Behind Tailscale the browser asked for
   * `<mount>?token=…` or `<mount>/?token=…` and we cannot tell which (both
   * arrive as `/`), so the redirect names the mount directory outright — a
   * relative `./` from the slash-less form would resolve to the site root.
   * Directly on the loopback listener the request path is the real one.
   */
  const exchangeTarget = req => (req.headers['x-forwarded-host'] !== undefined && mount !== '/' ? `${mount}/` : './')

  const setCookieHeader = (req, value, maxAge) => `${spec.cookieName}=${value}; Max-Age=${String(maxAge)}; Path=/; HttpOnly; SameSite=Lax${requestIsHttps(req) ? '; Secure' : ''}`

  const onRequest = (req, res) => {
    const path = pathnameOf(req.url)
    const method = req.method ?? 'GET'
    if (path === spec.controlPrefix || path.startsWith(`${spec.controlPrefix}/`)) {
      drain(req)
      sendText(res, 403, 'the Tailscale remote is controlled from the DSH host only\n')
      return
    }
    // Token exchange: only on the shell entry, only GET/HEAD, exactly one token.
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.searchParams.has(TOKEN_QUERY)) {
      drain(req)
      const tokens = url.searchParams.getAll(TOKEN_QUERY)
      if ((method === 'GET' || method === 'HEAD') && (path === '/' || path === '/index.html') && tokens.length === 1 && safeEqual(tokens[0], spec.token())) {
        res.writeHead(303, {
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          'location': exchangeTarget(req),
          'set-cookie': setCookieHeader(req, cookieValueFor(spec.token()), 400 * 24 * 3600),
        })
        res.end()
        spec.log?.(`tailscale-remote: token accepted from ${lastHeader(req.headers['x-forwarded-for']) ?? req.socket.remoteAddress ?? '?'}`)
        return
      }
      unauthorizedPage(res, req, 'The link is not valid for this DSH host (the token may have been rotated).')
      return
    }
    const admitted = admit(req)
    if (admitted === undefined && !((method === 'GET' || method === 'HEAD') && PUBLIC_PATHS.has(path))) {
      drain(req)
      unauthorizedPage(res, req, 'You are not signed in to this DSH host.')
      return
    }
    proxyRequest(req, res, path)
  }

  const proxyRequest = (req, res, path) => {
    const length = Number(req.headers['content-length'] ?? 0)
    if (!Number.isFinite(length) || length < 0 || length > MAX_REQUEST_BYTES) {
      drain(req)
      sendText(res, 413, 'request too large\n', { connection: 'close' })
      return
    }
    const isIndex = path === '/' || path === '/index.html'
    const headers = forwardHeaders(req, backendAuthority, cookieForUpstream(), isIndex ? { 'accept-encoding': 'identity' } : {})
    const up = httpRequest({
      hostname: spec.backendHost,
      port: spec.backendPort,
      method: req.method,
      path: req.url,
      headers,
    })
    up.on('response', (upRes) => {
      const status = upRes.statusCode ?? 502
      if (status === 401) void refreshUpstreamCookie()
      const relayed = relayHeaders(upRes.headers)
      const type = String(upRes.headers['content-type'] ?? '')
      if (isIndex && status === 200 && type.startsWith('text/html')) {
        const chunks = []
        upRes.on('data', chunk => chunks.push(chunk))
        upRes.on('end', () => {
          const html = Buffer.concat(chunks).toString('utf8')
          const body = Buffer.from(html.replace(/<head(?:\s[^>]*)?>/i, open => `${open}${TRAILING_SLASH_GUARD}`), 'utf8')
          delete relayed['content-length']
          delete relayed['transfer-encoding']
          res.writeHead(status, { ...relayed, 'content-length': String(body.byteLength) })
          res.end(body)
        })
        upRes.on('error', () => { if (!res.destroyed) res.destroy() })
        return
      }
      res.writeHead(status, relayed)
      upRes.pipe(res)
    })
    up.on('error', (error) => {
      if (!res.headersSent) sendText(res, 502, `DSH is not reachable: ${error.message}\n`)
      else res.destroy()
    })
    res.on('close', () => { if (!up.destroyed) up.destroy() })
    req.pipe(up)
  }

  const server = createServer({ maxHeaderSize: 32 * 1024 }, onRequest)
  server.on('connection', track)
  server.on('upgrade', (req, socket, head) => {
    track(socket)
    const path = pathnameOf(req.url)
    const admitted = path.startsWith(spec.controlPrefix) ? undefined : admit(req)
    if (admitted === undefined) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const headers = forwardHeaders(req, backendAuthority, cookieForUpstream(), {
      connection: 'Upgrade',
      upgrade: req.headers.upgrade ?? 'websocket',
    })
    const up = httpRequest({ hostname: spec.backendHost, port: spec.backendPort, method: 'GET', path: req.url, headers })
    up.on('upgrade', (upRes, upSocket, upHead) => {
      track(upSocket)
      const lines = [`HTTP/1.1 ${String(upRes.statusCode ?? 101)} ${upRes.statusMessage ?? 'Switching Protocols'}`]
      for (const [key, value] of Object.entries(relayHeaders(upRes.headers, new Set(['connection', 'upgrade'])))) {
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${String(item)}`)
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (upHead.length > 0) socket.write(upHead)
      if (head.length > 0) upSocket.write(head)
      upSocket.pipe(socket)
      socket.pipe(upSocket)
      upSocket.on('error', () => socket.destroy())
      socket.on('error', () => upSocket.destroy())
    })
    up.on('response', (upRes) => {
      if (upRes.statusCode === 401) void refreshUpstreamCookie()
      upRes.resume()
      socket.end(`HTTP/1.1 ${String(upRes.statusCode ?? 502)} ${upRes.statusMessage ?? 'Bad Gateway'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    })
    up.on('error', () => socket.destroy())
    socket.on('error', () => up.destroy())
    up.end()
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(spec.listenPort, spec.listenHost, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : spec.listenPort

  return {
    host: spec.listenHost,
    port,
    url: `http://${spec.listenHost}:${String(port)}`,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy()
      server.closeAllConnections?.()
      const timer = setTimeout(() => resolve(), 2000)
      server.close(() => {
        clearTimeout(timer)
        resolve()
      })
    }),
  }
}

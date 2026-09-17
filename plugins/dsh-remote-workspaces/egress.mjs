/**
 * Egress to one remote DSH host: the local DSH serves `/remote/<id>/…` and
 * this module forwards each request to `<remote url>…`, so a page of the
 * remote GUI (`?embed=<sessionId>`) can be framed by the local GUI as a
 * SAME-ORIGIN iframe — the local browser-session cookie, the Host/Origin
 * fence and the cross-site refusal all see one origin. The remote's own
 * credentials never reach the browser: this process holds them.
 *
 * Admission at the remote is one of
 *   1. tailnet identity — the remote runs `dsh-tailscale-remote` and Tailscale
 *      Serve injects this machine's `Tailscale-User-Login`; nothing to do here;
 *   2. a standing token — exchanged once (`GET <url>?token=…` → 303 +
 *      Set-Cookie, the same exchange a browser does) for a cookie forwarded on
 *      every request, refreshed after a TTL or an upstream 401. Works against
 *      `dsh-tailscale-remote` (its token) and against a bare DSH (its launch
 *      token) alike, which is what the local two-instance test uses.
 *
 * Forwarding facts: `Host` is the remote authority, an attached `Origin`
 * becomes the remote origin (DSH's fence wants Origin == Host), browser
 * cookies are replaced by the bridged one, `x-forwarded-*` are dropped (Serve
 * derives them). Responses relay verbatim except `Set-Cookie` (dropped) and
 * `Location` (remote paths mapped back under the local mount). Upgrades pipe
 * both sockets. The generic `call()` speaks the Connection envelope for the
 * remote's Typert Remote endpoints (`POST /api/<ns>/<method>`).
 */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade'])
const DROPPED_REQUEST_HEADERS = new Set([
  'host', 'cookie', 'origin', 'referer', 'referrer',
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-proto', 'x-real-ip',
  'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user',
])
const TOKEN_QUERY = 'token'
const COOKIE_TTL_MS = 6 * 60 * 60 * 1000
const MAX_REQUEST_BYTES = 64 * 1024 * 1024
const CALL_TIMEOUT_MS = 20_000
const MAX_CALL_RESPONSE_BYTES = 8 * 1024 * 1024

/**
 * Split a remote URL into the facts the forwarders need.
 * @param {string} url e.g. `https://node.tail.ts.net/dsh/` or `http://127.0.0.1:3082/`
 */
export function parseRemoteUrl(url) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`remote url must be http(s): ${url}`)
  if (parsed.search !== '' || parsed.hash !== '') throw new Error(`remote url must not carry a query or fragment: ${url}`)
  const basePath = parsed.pathname.replace(/\/+$/, '')
  return {
    secure: parsed.protocol === 'https:',
    hostname: parsed.hostname,
    port: parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port),
    authority: parsed.host,
    origin: parsed.origin,
    /** Mount path without trailing slash: `/dsh` or `` for a root-served host. */
    basePath,
    /** Canonical display form, always slash-terminated. */
    url: `${parsed.origin}${basePath}/`,
  }
}

/**
 * Map an upstream `Location` back under the local mount.
 * @param {string} value the header value
 * @param {{ origin: string, basePath: string }} remote
 * @param {string} localBase `/remote/<id>` (no trailing slash)
 */
export function rewriteLocation(value, remote, localBase) {
  let pathAndRest = value
  if (/^https?:\/\//i.test(value)) {
    let absolute
    try {
      absolute = new URL(value)
    } catch {
      return value
    }
    if (absolute.origin !== remote.origin) return value
    pathAndRest = `${absolute.pathname}${absolute.search}${absolute.hash}`
  } else if (!value.startsWith('/')) {
    return value // relative: the browser resolves it against the proxied document
  }
  if (pathAndRest === remote.basePath || pathAndRest.startsWith(`${remote.basePath}/`) || pathAndRest.startsWith(`${remote.basePath}?`)) {
    return `${localBase}${pathAndRest.slice(remote.basePath.length) || '/'}`
  }
  return pathAndRest
}

function relayHeaders(headers, remote, localBase, keep = new Set()) {
  const out = {}
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase()
    if (value === undefined || lower === 'set-cookie') continue
    if (HOP_BY_HOP.has(lower) && !keep.has(lower)) continue
    out[key] = lower === 'location' && typeof value === 'string' ? rewriteLocation(value, remote, localBase) : value
  }
  return out
}

function drain(req) {
  if (!req.readableEnded) req.resume()
}

function sendText(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(body)
}

/**
 * One remote target with its auth bridge.
 * @param {{
 *   id: string, url: string, token?: () => string | undefined,
 *   localBase: string,
 *   log?: (line: string) => void, warn?: (line: string) => void,
 * }} spec
 */
export function createEgress(spec) {
  const remote = parseRemoteUrl(spec.url)
  const request = remote.secure ? httpsRequest : httpRequest
  const localBase = spec.localBase.replace(/\/+$/, '')
  /** @type {string | undefined} `name=value` of the bridged remote cookie */
  let cookie
  let cookieAt = 0
  /** @type {Promise<void> | undefined} */
  let exchanging
  /** @type {{ at: number, status: number, message: string } | undefined} */
  let lastFailure

  const upstreamPath = rest => `${remote.basePath}${rest === '' ? '/' : rest}`

  /** Exchange the standing token for the remote's cookie; resolves without a cookie when no token is configured. */
  const exchange = () => {
    const token = spec.token?.()
    if (token === undefined || token === '') {
      cookie = undefined
      return Promise.resolve()
    }
    exchanging ??= new Promise((resolve, reject) => {
      const up = request({
        hostname: remote.hostname,
        port: remote.port,
        method: 'GET',
        path: `${upstreamPath('')}?${TOKEN_QUERY}=${encodeURIComponent(token)}`,
        headers: { host: remote.authority, connection: 'close', accept: 'text/html' },
        timeout: CALL_TIMEOUT_MS,
      }, (response) => {
        const status = response.statusCode ?? 0
        const minted = (response.headers['set-cookie'] ?? []).find(value => value.includes('='))?.split(';', 1)[0]
        response.resume()
        response.once('end', () => {
          if (status >= 300 && status < 400 && minted !== undefined) {
            cookie = minted
            cookieAt = Date.now()
            lastFailure = undefined
            spec.log?.(`remote-workspaces[${spec.id}]: token accepted by ${remote.url}`)
            resolve()
          } else {
            lastFailure = { at: Date.now(), status, message: `token exchange answered HTTP ${String(status)}` }
            reject(new Error(`remote-workspaces[${spec.id}]: ${lastFailure.message}`))
          }
        })
      })
      up.once('timeout', () => up.destroy(new Error('token exchange timed out')))
      up.once('error', (error) => {
        lastFailure = { at: Date.now(), status: 0, message: error.message }
        reject(error)
      })
      up.end()
    }).finally(() => { exchanging = undefined })
    return exchanging
  }

  /** Cookie to attach now; kicks off a background refresh past the TTL. */
  const cookieNow = () => {
    if (cookie !== undefined && Date.now() - cookieAt > COOKIE_TTL_MS) {
      exchange().catch(error => spec.warn?.(String(error?.message ?? error)))
    }
    return cookie
  }

  /** Ensure the bridge is ready before the first forward (no-op in identity mode). */
  const ready = async () => {
    if (cookie === undefined && (spec.token?.() ?? '') !== '') await exchange()
  }

  const forwardHeaders = (req, extra = {}) => {
    const headers = {}
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase()
      if (value === undefined || HOP_BY_HOP.has(lower) || DROPPED_REQUEST_HEADERS.has(lower)) continue
      headers[lower] = value
    }
    headers.host = remote.authority
    if (req.headers.origin !== undefined) headers.origin = remote.origin
    headers['sec-fetch-site'] = 'same-origin'
    const bridged = cookieNow()
    if (bridged !== undefined) headers.cookie = bridged
    return { ...headers, ...extra }
  }

  /**
   * Forward one HTTP request whose local path was `${localBase}${rest}`.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} rest `` | `/…` (path + query after the local mount)
   */
  const handleRequest = async (req, res, rest) => {
    if (rest === '' || rest.startsWith('?')) {
      // The embedded shell resolves every Host URL relative to the document
      // directory: `/remote/<id>` must become `/remote/<id>/` before it loads.
      drain(req)
      res.writeHead(301, { location: `${localBase}/${rest}`, 'cache-control': 'no-store' })
      res.end()
      return
    }
    const length = Number(req.headers['content-length'] ?? 0)
    if (!Number.isFinite(length) || length < 0 || length > MAX_REQUEST_BYTES) {
      drain(req)
      sendText(res, 413, 'request too large\n', { connection: 'close' })
      return
    }
    try {
      await ready()
    } catch (error) {
      drain(req)
      sendText(res, 502, `remote is not accepting this host: ${String(error?.message ?? error)}\n`)
      return
    }
    const up = request({
      hostname: remote.hostname,
      port: remote.port,
      method: req.method,
      path: upstreamPath(rest),
      headers: forwardHeaders(req),
    })
    up.on('response', (upRes) => {
      const status = upRes.statusCode ?? 502
      if (status === 401) exchange().catch(error => spec.warn?.(String(error?.message ?? error)))
      res.writeHead(status, relayHeaders(upRes.headers, remote, localBase))
      upRes.pipe(res)
    })
    up.on('error', (error) => {
      lastFailure = { at: Date.now(), status: 0, message: error.message }
      if (!res.headersSent) sendText(res, 502, `remote is not reachable: ${error.message}\n`)
      else res.destroy()
    })
    res.on('close', () => { if (!up.destroyed) up.destroy() })
    req.pipe(up)
  }

  /**
   * Forward one HTTP upgrade (the embedded shell's `api/remote.mux` WebSocket).
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:stream').Duplex} socket
   * @param {Buffer} head
   * @param {string} rest
   */
  const handleUpgrade = async (req, socket, head, rest) => {
    try {
      await ready()
    } catch {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const up = request({
      hostname: remote.hostname,
      port: remote.port,
      method: 'GET',
      path: upstreamPath(rest),
      headers: forwardHeaders(req, { connection: 'Upgrade', upgrade: req.headers.upgrade ?? 'websocket' }),
    })
    up.on('upgrade', (upRes, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${String(upRes.statusCode ?? 101)} ${upRes.statusMessage ?? 'Switching Protocols'}`]
      for (const [key, value] of Object.entries(relayHeaders(upRes.headers, remote, localBase, new Set(['connection', 'upgrade'])))) {
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${String(item)}`)
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (upHead.length > 0) socket.write(upHead)
      if (head.length > 0) upSocket.write(head)
      upSocket.pipe(socket)
      socket.pipe(upSocket)
      upSocket.on('error', () => socket.destroy())
      socket.on('error', () => upSocket.destroy())
      socket.on('close', () => upSocket.destroy())
      upSocket.on('close', () => socket.destroy())
    })
    up.on('response', (upRes) => {
      if (upRes.statusCode === 401) exchange().catch(error => spec.warn?.(String(error?.message ?? error)))
      upRes.resume()
      socket.end(`HTTP/1.1 ${String(upRes.statusCode ?? 502)} ${upRes.statusMessage ?? 'Bad Gateway'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    })
    up.on('error', () => socket.destroy())
    socket.on('error', () => up.destroy())
    up.end()
  }

  /**
   * Call one Typert Remote endpoint on the remote host.
   * @param {string} namespace e.g. `session`
   * @param {string} method e.g. `list`
   * @param {Record<string, unknown>} args named by the method's parameters (`{ request: {...} }`)
   * @returns {Promise<{ ok: true, value: unknown } | { ok: false, error: { code: string, message: string, details?: unknown } }>}
   */
  const call = async (namespace, method, args, { retry = true } = {}) => {
    await ready()
    const rpcId = crypto.randomUUID()
    const body = Buffer.from(JSON.stringify({
      type: 'client-request', rpcId, method: `${namespace}/${method}`, payload: { args },
    }), 'utf8')
    const outcome = await new Promise((resolve, reject) => {
      const headers = {
        host: remote.authority,
        'content-type': 'application/json',
        'content-length': String(body.byteLength),
        accept: 'application/json',
      }
      const bridged = cookieNow()
      if (bridged !== undefined) headers.cookie = bridged
      const up = request({
        hostname: remote.hostname,
        port: remote.port,
        method: 'POST',
        path: `${remote.basePath}/api/${namespace}/${method}`,
        headers,
        timeout: CALL_TIMEOUT_MS,
      }, (response) => {
        const chunks = []
        let size = 0
        response.on('data', (chunk) => {
          size += chunk.length
          if (size > MAX_CALL_RESPONSE_BYTES) {
            response.destroy(new Error('remote response too large'))
            return
          }
          chunks.push(chunk)
        })
        response.on('error', reject)
        response.on('end', () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
      })
      up.once('timeout', () => up.destroy(new Error('remote call timed out')))
      up.once('error', reject)
      up.end(body)
    })
    if (outcome.status === 401) {
      if (retry && (spec.token?.() ?? '') !== '') {
        await exchange()
        return call(namespace, method, args, { retry: false })
      }
      lastFailure = { at: Date.now(), status: 401, message: 'remote refused this host (401)' }
      return { ok: false, error: { code: 'remote-workspaces/unauthorized', message: 'the remote DSH did not accept this host: add this machine\'s tailnet login to its allowed users, or provide its token', details: { status: 401 } } }
    }
    if (outcome.status === 403) {
      lastFailure = { at: Date.now(), status: 403, message: 'remote refused this host (403)' }
      return { ok: false, error: { code: 'remote-workspaces/forbidden', message: 'the remote DSH refused the request (Host/Origin fence)', details: { status: 403 } } }
    }
    let envelope
    try {
      envelope = JSON.parse(outcome.text)
    } catch {
      return { ok: false, error: { code: 'remote-workspaces/bad-response', message: `remote answered HTTP ${String(outcome.status)} with a non-JSON body`, details: { status: outcome.status, body: outcome.text.slice(0, 200) } } }
    }
    if (typeof envelope !== 'object' || envelope === null || envelope.type !== 'server-response' || envelope.rpcId !== rpcId || typeof envelope.result !== 'object') {
      return { ok: false, error: { code: 'remote-workspaces/bad-response', message: 'remote answered with an unexpected envelope', details: { status: outcome.status } } }
    }
    lastFailure = undefined
    return envelope.result
  }

  /**
   * One authenticated raw HTTP request to the remote (binary routes such as
   * `/api/session.export` and `/api/session.import`, which are not Typert
   * Remotes). The response is handed back as the Node IncomingMessage so the
   * caller streams it; a 401 with a token configured re-exchanges once.
   * @param {string} method
   * @param {string} pathAndQuery path below the remote base, e.g. `/api/session.export?sessionId=…`
   * @param {{ body?: import('node:stream').Readable | Buffer, headers?: Record<string, string>, timeoutMs?: number }} [options]
   * @returns {Promise<import('node:http').IncomingMessage>}
   */
  const fetchRaw = async (method, pathAndQuery, options = {}, { retry = true } = {}) => {
    await ready()
    const response = await new Promise((resolve, reject) => {
      const headers = { host: remote.authority, accept: '*/*', ...(options.headers ?? {}) }
      const bridged = cookieNow()
      if (bridged !== undefined) headers.cookie = bridged
      if (Buffer.isBuffer(options.body)) headers['content-length'] = String(options.body.byteLength)
      const up = request({
        hostname: remote.hostname,
        port: remote.port,
        method,
        path: `${remote.basePath}${pathAndQuery}`,
        headers,
        timeout: options.timeoutMs ?? 10 * 60 * 1000,
      }, resolve)
      up.once('timeout', () => up.destroy(new Error('remote request timed out')))
      up.once('error', reject)
      if (options.body === undefined) up.end()
      else if (Buffer.isBuffer(options.body)) up.end(options.body)
      else options.body.pipe(up)
    })
    if (response.statusCode === 401 && retry && (spec.token?.() ?? '') !== '') {
      response.resume()
      await exchange()
      return fetchRaw(method, pathAndQuery, options, { retry: false })
    }
    return response
  }

  return {
    id: spec.id,
    remote,
    localBase,
    handleRequest,
    handleUpgrade,
    call,
    fetchRaw,
    /** Force the token exchange now (probe). */
    exchange,
    status: () => ({
      url: remote.url,
      mode: (spec.token?.() ?? '') === '' ? 'identity' : 'token',
      bridged: cookie !== undefined,
      bridgedAt: cookie === undefined ? undefined : new Date(cookieAt).toISOString(),
      lastFailure,
    }),
  }
}

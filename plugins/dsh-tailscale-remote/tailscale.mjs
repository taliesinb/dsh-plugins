/**
 * Tailscale Serve path route in front of the proxy listener.
 *
 *   tailscale serve --bg --yes --https=443 --set-path /dsh http://127.0.0.1:<proxy>
 *
 * publishes the relay (or, with `publishPort: 0`, the proxy — never the DSH
 * backend) at `https://<node-fqdn>/dsh/`.
 * tailscaled strips the mount prefix before forwarding (verified: `/dsh`,
 * `/dsh/` and `/dsh/x?y` arrive as `/`, `/` and `/x?y`), keeps the tailnet
 * `Host`, and adds `x-forwarded-{for,host,proto}`. For a request from a
 * user-owned device it also injects `Tailscale-User-Login` (tailnet-verified;
 * client-supplied copies are overwritten). Serve config lives in tailscaled
 * and survives restarts, so this module treats `serve status --json` as the
 * truth for "is the route active" and only ever republishes or removes it.
 */
import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

/** Request header carrying the tailnet-verified login (lower-cased for Node's header map). */
export const TAILSCALE_LOGIN_HEADER = 'tailscale-user-login'
/** Every identity/capability header Serve may inject; never forwarded to DSH. */
export const TAILSCALE_IDENTITY_HEADERS = new Set([
  TAILSCALE_LOGIN_HEADER,
  'tailscale-user-name',
  'tailscale-user-profile-pic',
  'tailscale-app-capabilities',
])

const CLI_TIMEOUT_MS = 15_000
const MAC_APP_BINARY = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'

function run(binary, args) {
  return new Promise((resolve) => {
    execFile(binary, args, { timeout: CLI_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? error?.message ?? '') })
    })
  })
}

async function executable(path) {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Locate the CLI: explicit config, then PATH, then the macOS app bundle and the usual prefixes. */
export async function resolveTailscaleBinary(configuredPath = '') {
  const configured = String(configuredPath).trim()
  if (configured !== '') return (await executable(configured)) ? configured : undefined
  for (const dir of String(process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, 'tailscale')
    if (await executable(candidate)) return candidate
  }
  for (const candidate of [MAC_APP_BINARY, '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/usr/bin/tailscale']) {
    if (await executable(candidate)) return candidate
  }
  return undefined
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Normalize a mount path: leading slash, no trailing slash (`/dsh`). */
export function normalizeMountPath(value) {
  const trimmed = String(value ?? '').trim().replace(/\/+$/, '')
  if (trimmed === '' || trimmed === '/') return '/'
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

/** Public URL of the route: `https://<fqdn>/dsh/` — WITH the trailing slash (see proxy.mjs). */
export function routeUrl(dnsName, port, mountPath) {
  const authority = port === 443 ? dnsName : `${dnsName}:${String(port)}`
  const mount = normalizeMountPath(mountPath)
  return `https://${authority}${mount === '/' ? '/' : `${mount}/`}`
}

function sameTarget(a, b) {
  try {
    const left = new URL(a)
    const right = new URL(b)
    return left.protocol === right.protocol && left.hostname === right.hostname && (left.port || '80') === (right.port || '80')
  } catch {
    return a === b
  }
}

/**
 * @param {{ configuredPath: string, port: number, mountPath: string, target: () => string, log?: (m: string) => void }} options
 *   `target` is the proxy listener URL (`http://127.0.0.1:3083`), '' while it is down.
 */
export function createTailscaleManager(options) {
  const mount = normalizeMountPath(options.mountPath)
  const portFlag = `--https=${String(options.port)}`
  let binary
  let binaryResolved = false

  const resolveBinary = async () => {
    if (!binaryResolved) {
      binary = await resolveTailscaleBinary(options.configuredPath)
      binaryResolved = true
    }
    return binary
  }

  /**
   * @returns {Promise<{ state: 'off'|'active'|'conflict'|'unavailable', detail?: string, binary?: string,
   *   dnsName?: string, backendState?: string, url?: string, mappedTarget?: string,
   *   selfLogin?: string, selfAddresses?: string[] }>}
   *   `selfLogin` / `selfAddresses` describe THIS node (its user's login as Serve
   *   will inject it for requests the node makes to itself, and its tailnet
   *   IPs, which appear as `x-forwarded-for` on such requests). Absent when the
   *   node is tagged (tagged nodes have no user identity).
   */
  const status = async () => {
    const cli = await resolveBinary()
    if (cli === undefined) return { state: 'unavailable', detail: 'binary-missing' }
    const node = await run(cli, ['status', '--json'])
    const nodeJson = node.code === 0 ? parseJson(node.stdout) : undefined
    if (nodeJson === undefined) return { state: 'unavailable', detail: 'daemon-unreachable', binary: cli }
    const dnsName = String(nodeJson.Self?.DNSName ?? '').replace(/\.$/, '')
    const base = { binary: cli, backendState: nodeJson.BackendState, dnsName: dnsName || undefined, ...selfIdentity(nodeJson) }
    if (dnsName !== '') base.url = routeUrl(dnsName, options.port, mount)
    if (nodeJson.BackendState !== 'Running') return { ...base, state: 'unavailable', detail: 'not-running' }
    const serve = await run(cli, ['serve', 'status', '--json'])
    // An empty serve config prints nothing with exit 0.
    const serveJson = serve.code === 0 ? (parseJson(serve.stdout) ?? {}) : undefined
    if (serveJson === undefined) return { ...base, state: 'unavailable', detail: 'daemon-unreachable' }
    const handlers = serveJson.Web?.[`${dnsName}:${String(options.port)}`]?.Handlers ?? {}
    const mapped = handlers[mount]?.Proxy
    if (typeof mapped !== 'string' || mapped === '') return { ...base, state: 'off' }
    const target = options.target()
    if (target !== '' ? sameTarget(mapped, target) : isLoopbackProxy(mapped)) return { ...base, state: 'active', mappedTarget: mapped }
    return { ...base, state: 'conflict', mappedTarget: mapped }
  }

  return {
    mount,
    status,
    /** @returns {Promise<'ok'|'unavailable'|'conflict'|'failed'|'verify-failed'>} */
    enable: async () => {
      const target = options.target()
      if (target === '') return 'failed'
      const before = await status()
      if (before.binary === undefined || before.backendState !== 'Running' || before.dnsName === undefined) return 'unavailable'
      // A stale loopback mapping (our port changed) is ours to overwrite; a
      // non-loopback target is somebody else's service on this mount.
      if (before.state === 'conflict' && !isLoopbackProxy(before.mappedTarget ?? '')) return 'conflict'
      const args = ['serve', '--bg', '--yes', portFlag]
      if (mount !== '/') args.push(`--set-path=${mount}`)
      args.push(target)
      const result = await run(before.binary, args)
      if (result.code !== 0) {
        options.log?.(`tailscale-remote: tailscale serve failed (${String(result.code)}): ${result.stderr.trim() || result.stdout.trim()}`)
        return 'failed'
      }
      const after = await status()
      if (after.state !== 'active') return 'verify-failed'
      options.log?.(`tailscale-remote: route ${after.url ?? ''} -> ${target}`)
      return 'ok'
    },
    /** @returns {Promise<'ok'|'unavailable'|'failed'>} */
    disable: async () => {
      const before = await status()
      if (before.binary === undefined || before.backendState !== 'Running') return 'unavailable'
      if (before.state === 'off') return 'ok'
      const args = ['serve', portFlag]
      if (mount !== '/') args.push(`--set-path=${mount}`)
      args.push('off')
      const result = await run(before.binary, args)
      if (result.code !== 0) {
        options.log?.(`tailscale-remote: tailscale serve off failed (${String(result.code)}): ${result.stderr.trim() || result.stdout.trim()}`)
        return 'failed'
      }
      options.log?.(`tailscale-remote: route ${before.url ?? mount} removed`)
      return 'ok'
    },
  }
}

/**
 * This node's own identity from `tailscale status --json`: the login Serve
 * injects for the node's requests to itself (undefined for tagged nodes, which
 * carry no user) and the node's tailnet addresses.
 * @param {any} statusJson
 * @returns {{ selfLogin?: string, selfAddresses: string[] }}
 */
export function selfIdentity(statusJson) {
  const self = statusJson?.Self ?? {}
  const addresses = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.map(String) : []
  const tags = Array.isArray(self.Tags) ? self.Tags : []
  const userId = self.UserID
  const user = userId === undefined ? undefined : statusJson?.User?.[String(userId)]
  const login = tags.length === 0 && typeof user?.LoginName === 'string' && user.LoginName !== '' && user.LoginName !== 'tagged-devices'
    ? user.LoginName.toLowerCase()
    : undefined
  return { selfLogin: login, selfAddresses: addresses }
}

/** A loopback proxy target on our mount is assumed to be an earlier run of ours. */
function isLoopbackProxy(target) {
  try {
    const url = new URL(target)
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  } catch {
    return false
  }
}

/** Tailscale node ranges: IPv4 CGNAT block and the IPv6 ULA prefix. */
export function isTailscaleAddress(ip) {
  const text = String(ip ?? '').replace(/^::ffff:/i, '')
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(text)
  if (v4 !== null) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    return a === 100 && b >= 64 && b <= 127
  }
  return /^fd7a:115c:a1e0:/i.test(text)
}

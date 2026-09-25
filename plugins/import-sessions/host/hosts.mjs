/**
 * Who is talking to whom: the server's own host name, and whether the client
 * of a request is the same machine or a remote device (and, over a tailnet,
 * which one).
 *
 * The dsh-tailscale-remote proxy stamps every forwarded request with
 * `x-dsh-tailscale-remote: 1`, `x-dsh-tailscale-remote-self: 1` when the peer
 * is this very node, and `x-forwarded-for` = the peer's tailnet address. A
 * request that did not come through the proxy is local (the Dock app / a
 * browser on this machine talking to loopback). The peer's host name comes
 * from `tailscale status --json` (cached; absent when the CLI is missing).
 */
import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { hostname } from 'node:os'

const TAILSCALE_CANDIDATES = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/bin/tailscale',
]
const STATUS_TTL_MS = 60_000

/** `tali-macbook-air.local` → `tali-macbook-air`. */
export function shortHost(name) {
  const text = String(name ?? '').trim()
  if (text === '') return undefined
  return text.replace(/\.local$/i, '').split('.')[0] || undefined
}

export function serverHost() {
  return shortHost(hostname())
}

function header(req, name) {
  const value = req?.headers?.[name]
  const text = Array.isArray(value) ? value[0] : value
  return typeof text === 'string' && text !== '' ? text : undefined
}

export function isLoopback(address) {
  const ip = String(address ?? '').replace(/^::ffff:/i, '')
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || ip.startsWith('127.')
}

/** Proxy facts of one request (mirrors dsh-tailscale-remote's `clientFacts`). */
export function requestClient(req) {
  const proxied = header(req, 'x-dsh-tailscale-remote') === '1'
  const forwarded = header(req, 'x-forwarded-for')
  const address = (proxied ? forwarded?.split(',').at(-1)?.trim() : undefined) ?? String(req?.socket?.remoteAddress ?? '').replace(/^::ffff:/i, '')
  const self = proxied ? header(req, 'x-dsh-tailscale-remote-self') === '1' : isLoopback(address)
  return { proxied, address, sameMachine: self }
}

let binaryPromise
async function tailscaleBinary() {
  binaryPromise ??= (async () => {
    for (const candidate of TAILSCALE_CANDIDATES) {
      try { await access(candidate, constants.X_OK); return candidate } catch { /* next */ }
    }
    return undefined
  })()
  return binaryPromise
}

let statusCache
/** `tailscale status --json`, cached for a minute; undefined without the CLI. */
export async function tailscaleStatus() {
  if (statusCache !== undefined && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.value
  const binary = await tailscaleBinary()
  if (binary === undefined) return undefined
  const value = await new Promise((resolve) => {
    execFile(binary, ['status', '--json'], { timeout: 4000, maxBuffer: 4 << 20 }, (error, stdout) => {
      if (error) { resolve(undefined); return }
      try { resolve(JSON.parse(String(stdout))) } catch { resolve(undefined) }
    })
  })
  statusCache = { at: Date.now(), value }
  return value
}

/** Host name of the tailnet peer at `address`, when known. */
export async function peerHost(address) {
  if (address === undefined || address === '' || isLoopback(address)) return undefined
  const status = await tailscaleStatus()
  if (status === undefined) return undefined
  const nodes = [status.Self, ...Object.values(status.Peer ?? {})].filter(Boolean)
  for (const node of nodes) {
    if (Array.isArray(node.TailscaleIPs) && node.TailscaleIPs.includes(address)) return shortHost(node.HostName ?? node.DNSName)
  }
  return undefined
}

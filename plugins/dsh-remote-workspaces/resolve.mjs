/**
 * Two host-side helpers of the add-remote flow.
 *
 * 1. `normalizeRemoteInput` — what the operator may type into "Remote DSH
 *    server" besides a full URL:
 *
 *      user@host              →  https://host.<magic-dns-suffix>/dsh/user/
 *      host/dsh/user          →  https://host.<magic-dns-suffix>/dsh/user/
 *      host.tail1234.ts.net/dsh/user   →  https:// added
 *      localhost:3082/x, 127.0.0.1:3082, [::1]:3082, 10.0.0.5:3080  →  http:// added
 *      https://…              →  kept (trailing slash added)
 *
 *    A dot-less host is a MagicDNS short name; it gets the tailnet suffix
 *    (`tailscale status --json` → MagicDNSSuffix, cached; else the suffix of a
 *    known `*.ts.net` server; else left bare). The suffix matters because the
 *    Serve certificate is for the FQDN — `https://studio/` would fail TLS.
 *
 * 2. `inspectPath` — the filesystem facts behind the "New workspace" path
 *    field, answered by the plugin *on the remote* through its control channel
 *    (`fs.inspect`, `fs.mkdir`): `~` resolved against that account's home,
 *    whether the path exists / is a directory / can be created (nearest
 *    existing ancestor is a directory), and tab-completion candidates — the
 *    child directories of the typed directory whose names start with the typed
 *    last segment, shell style.
 */
import { execFile } from 'node:child_process'
import { access, constants, mkdir, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'

const SUFFIX_TTL_MS = 5 * 60 * 1000
const CLI_TIMEOUT_MS = 5000
/** Completion candidates per answer (shared with remote-fs.mjs, which builds the same answer over DSH's directory picker). */
export const MAX_SUGGESTIONS = 40

// ---------------------------------------------------------------------------
// remote input normalization

/** `localhost`, loopback and private/tailnet IP literals speak plain http (a bare `dsh web` or a LAN box). */
export function isPlainHttpHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '::1' || host.endsWith('.localhost')) return true
  if (/^127\./.test(host)) return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true // any IPv4 literal: no certificate can name it
  return host.includes(':') // IPv6 literal
}

/**
 * Turn what the operator typed into a canonical http(s) URL with a trailing
 * slash, or throw with a message the modal can show.
 * @param {string} text
 * @param {{ magicDnsSuffix?: string | (() => Promise<string | undefined>) }} [options]
 *   tailnet suffix for dot-less hosts (`tail1234.ts.net`), or a function
 *   consulted only when the input actually has a dot-less host.
 * @returns {Promise<string>}
 */
export async function normalizeRemoteInput(text, options = {}) {
  const suffixFor = async (host) => {
    if (host.includes('.') || isPlainHttpHost(host)) return undefined
    const suffix = typeof options.magicDnsSuffix === 'function' ? await options.magicDnsSuffix() : options.magicDnsSuffix
    return suffix ? String(suffix).replace(/^\.|\.$/g, '') : undefined
  }
  let input = String(text ?? '').trim()
  if (input === '') throw new Error('type the remote DSH server')
  if (/\s/.test(input)) throw new Error(`"${input}" is not a server address`)

  // Full URL: scheme present.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    const url = new URL(input)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`remote url must be http(s): ${input}`)
    if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`
    const suffix = await suffixFor(url.hostname)
    if (suffix !== undefined) url.hostname = `${url.hostname}.${suffix}`
    return url.toString()
  }

  // `user@host` — sugar for `host/dsh/user` (one DSH per macOS account on a shared machine).
  const sugar = /^([^@/:\s]+)@([^@/\s]+)$/.exec(input)
  if (sugar !== null) input = `${sugar[2]}/dsh/${sugar[1]}`

  const slash = input.indexOf('/')
  let authority = slash === -1 ? input : input.slice(0, slash)
  let path = slash === -1 ? '/' : input.slice(slash)
  if (authority === '') throw new Error(`"${input}" has no host`)
  if (!path.endsWith('/')) path = `${path}/`

  // host[:port]; bracketed IPv6 keeps its brackets.
  const hostMatch = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(authority)
  if (hostMatch === null) throw new Error(`"${authority}" is not a host[:port]`)
  let host = hostMatch[1]
  const port = hostMatch[2]
  const plain = isPlainHttpHost(host)
  const suffix = await suffixFor(host)
  if (suffix !== undefined) host = `${host}.${suffix}`
  authority = port === undefined ? host : `${host}:${port}`
  const url = new URL(`${plain ? 'http' : 'https'}://${authority}${path}`)
  return url.toString()
}

// ---------------------------------------------------------------------------
// MagicDNS suffix

const MAC_APP_BINARY = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'

async function executable(path) {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function tailscaleBinary() {
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

/**
 * The tailnet's MagicDNS suffix (`tail1234.ts.net`) from `tailscale status
 * --json`, cached; undefined when the CLI or daemon is unavailable.
 * @param {(suffix: string | undefined) => void} [log]
 */
export function createMagicDnsSuffixSource() {
  let cached
  let cachedAt = 0
  let pending
  const read = async () => {
    const cli = await tailscaleBinary()
    if (cli === undefined) return undefined
    const json = await new Promise((resolve) => {
      execFile(cli, ['status', '--json'], { timeout: CLI_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        if (error !== null) { resolve(undefined); return }
        try { resolve(JSON.parse(String(stdout))) } catch { resolve(undefined) }
      })
    })
    const suffix = String(json?.MagicDNSSuffix ?? '').replace(/^\.|\.$/g, '')
    if (suffix !== '') return suffix
    const self = String(json?.Self?.DNSName ?? '').replace(/\.$/, '')
    const dot = self.indexOf('.')
    return dot === -1 ? undefined : self.slice(dot + 1)
  }
  return async () => {
    if (cached !== undefined && Date.now() - cachedAt < SUFFIX_TTL_MS) return cached
    pending ??= read().then((suffix) => {
      pending = undefined
      if (suffix !== undefined) { cached = suffix; cachedAt = Date.now() }
      return suffix ?? cached
    }, () => { pending = undefined; return cached })
    return pending
  }
}

/** The `*.ts.net` suffix of any known server URL — the fallback when the CLI is not around. */
export function suffixFromKnownUrls(urls) {
  for (const value of urls) {
    try {
      const host = new URL(value).hostname
      const match = /^[^.]+\.(.+\.ts\.net)$/.exec(host)
      if (match !== null) return match[1]
    } catch { /* not a URL */ }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// filesystem facts for the "New workspace" field

/** `~` / `~/x` → this account's home. */
export function expandHome(text, home = homedir()) {
  if (text === '~') return home
  if (text.startsWith('~/')) return home + text.slice(1)
  return text
}

/**
 * @param {string} input what the operator typed (`~/proj/th`, `/Users/x/`)
 * @param {{ list?: boolean, home?: string }} [options]
 * @returns {Promise<{
 *   home: string, resolved: string, kind: 'directory'|'file'|'missing', creatable: boolean,
 *   blocker?: string, entries: { name: string, path: string }[], truncated: boolean }>}
 *   `blocker` names the nearest existing ancestor when it is not a directory.
 */
export async function inspectPath(input, options = {}) {
  const home = options.home ?? homedir()
  let text = expandHome(String(input ?? '').trim(), home)
  if (text === '') text = home
  if (!isAbsolute(text)) throw new Error('type an absolute path, or one starting with ~/')
  const endsWithSlash = text.length > 1 && text.endsWith('/')
  const resolved = resolvePath(text)

  const kindOf = async (path) => {
    try {
      return (await stat(path)).isDirectory() ? 'directory' : 'file'
    } catch {
      return 'missing'
    }
  }
  const kind = await kindOf(resolved)
  let creatable = kind === 'directory'
  let blocker
  if (kind === 'missing') {
    // Walk up to the nearest existing ancestor: mkdir -p succeeds iff it is a directory.
    let current = dirname(resolved)
    for (;;) {
      const ancestor = await kindOf(current)
      if (ancestor === 'directory') { creatable = true; break }
      if (ancestor === 'file') { blocker = current; break }
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  }

  let entries = []
  let truncated = false
  if (options.list !== false) {
    // Shell completion: the typed last segment is a prefix over its parent's
    // children; a trailing slash means "everything inside this directory".
    const dir = endsWithSlash ? resolved : dirname(resolved)
    const prefix = endsWithSlash ? '' : basename(resolved)
    const lower = prefix.toLowerCase()
    try {
      const dirents = await readdir(dir, { withFileTypes: true })
      const matches = []
      for (const dirent of dirents) {
        if (!dirent.name.toLowerCase().startsWith(lower)) continue
        if (dirent.name.startsWith('.') && !prefix.startsWith('.')) continue
        let isDir = dirent.isDirectory()
        if (!isDir && dirent.isSymbolicLink()) {
          try { isDir = (await stat(join(dir, dirent.name))).isDirectory() } catch { isDir = false }
        }
        if (isDir) matches.push(dirent.name)
      }
      matches.sort((a, b) => a.localeCompare(b))
      truncated = matches.length > MAX_SUGGESTIONS
      entries = matches.slice(0, MAX_SUGGESTIONS).map(name => ({ name, path: join(dir, name) }))
    } catch {
      // Unreadable or missing parent: no suggestions, the kind/creatable facts still stand.
    }
  }
  return { home, resolved, kind, creatable, ...(blocker === undefined ? {} : { blocker }), entries, truncated }
}

/**
 * `mkdir -p` for the "Directory will be created" promise.
 * @param {string} input
 * @returns {Promise<{ path: string, created: boolean }>}
 */
export async function makeDirectory(input, home = homedir()) {
  const text = expandHome(String(input ?? '').trim(), home)
  if (!isAbsolute(text)) throw new Error('type an absolute path, or one starting with ~/')
  const target = resolvePath(text)
  const before = await inspectPath(target, { list: false, home })
  if (before.kind === 'file') throw new Error(`${target} exists and is not a directory`)
  if (before.kind === 'directory') return { path: target, created: false }
  await mkdir(target, { recursive: true })
  return { path: target, created: true }
}

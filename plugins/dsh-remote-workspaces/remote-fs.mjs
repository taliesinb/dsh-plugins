/**
 * The filesystem questions the add-remote modal asks about a path ON THE
 * REMOTE — "does it exist, is it a directory, can it be made, what completes
 * here" (`inspect`) and "make it" (`mkdir`) — answered through whichever of
 * two doors that remote has open:
 *
 *   1. its own dsh-remote-workspaces control channel (`fs.inspect`,
 *      `fs.mkdir`, resolve.mjs): one round-trip, exact (`stat`), `mkdir -p`;
 *   2. DSH's own `directoryPicker` Remote namespace — `list(path)` and
 *      `createDirectory(parent, name)`, the primitives behind the in-app
 *      directory browser, present on every instance whose composed picker is
 *      the `browse` backend (every headless / relay-started instance of the
 *      fork). Kind and creatability are read off listing failures (ENOENT /
 *      ENOTDIR in the message); a missing directory is made one segment at a
 *      time from the nearest listable ancestor.
 *
 * Door 2 is what lets a remote that deliberately runs no dsh-remote-workspaces
 * (a shared server under the "no Remotes" host policy) still answer the field
 * with "Directory exists" / "Directory will be created". Only a remote with
 * neither door — no plugin AND a native (OS chooser) picker, or a DSH without
 * the namespace — is reported `fs-unavailable`, and the modal falls back to
 * "absolute path that already exists".
 *
 * Every function answers the control-channel envelope (`{ ok, value }` /
 * `{ ok: false, error }`) so callers treat both doors alike.
 */
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path/posix'
import { expandHome, MAX_SUGGESTIONS } from './resolve.mjs'

/** Answers meaning "that door is not there" (as opposed to "the path is bad" or "you are not allowed"). */
const NO_SUCH_DOOR = /^remote-workspaces\/(unknown-endpoint|bad-response)$|^directory-picker\/unavailable$/

const fail = (code, message, details = {}) => ({ ok: false, error: { code: `remote-workspaces/${code}`, message, details } })
const ok = value => ({ ok: true, value })

/** The errno a browse-backend listing failure carries in its message (`cannot list /x: ENOENT: no such file or directory, opendir '/x'`). */
function errnoOf(message) {
  const match = /\b(ENOENT|ENOTDIR|EACCES|EPERM|ELOOP|ENAMETOOLONG)\b/.exec(String(message ?? ''))
  return match?.[1] ?? 'other'
}

/**
 * @param {{ callControl: (endpoint: string, args: object) => Promise<any>, call: (namespace: string, method: string, args: object) => Promise<any> }} egress
 */
export function createRemoteFs(egress) {
  /** Remembered per egress: once the peer's plugin answered "no such endpoint", every later question goes straight to DSH's picker. */
  let peerMissing = false
  /** The remote account's home, from the first listing (`list()` without a path lists it). */
  let home

  // --- door 2: DSH's directoryPicker (browse capability) -------------------

  /**
   * One listing level. `{ ok: true, value }` for a readable directory;
   * `{ ok: false, errno }` for a path opendir refused (ENOENT, ENOTDIR, …);
   * `{ ok: false, hard: envelope }` for anything else (no such door, 401, …).
   */
  const list = async (path, memo) => {
    const key = path ?? ''
    if (memo.has(key)) return memo.get(key)
    const result = await egress.call('directoryPicker', 'list', path === undefined ? {} : { path })
    let answer
    if (result.ok) {
      home = result.value.home ?? home
      answer = { ok: true, value: result.value }
    } else if (result.error?.code === 'directory-picker/unreadable') {
      answer = { ok: false, errno: errnoOf(result.error.message), message: result.error.message }
    } else {
      answer = { ok: false, hard: result }
    }
    memo.set(key, answer)
    if (answer.ok) memo.set(answer.value.path, answer)
    return answer
  }

  /**
   * Walk from the typed path up to the nearest listable ancestor; the failures
   * on the way down from it say what the path is.
   * @returns {Promise<{ ok: true, value: object, ancestor: string } | { ok: false, error: object }>}
   */
  const inspectNative = async (input, { withEntries = true } = {}) => {
    const memo = new Map()
    if (home === undefined) {
      const first = await list(undefined, memo)
      if (!first.ok) return first.hard ?? fail('remote', `cannot list the remote home: ${first.message}`)
    }
    let text = expandHome(String(input ?? '').trim(), home)
    if (text === '') text = home
    if (!isAbsolute(text)) return fail('bad-path', 'type an absolute path, or one starting with ~/')
    const endsWithSlash = text.length > 1 && text.endsWith('/')
    const resolved = resolvePath(text)

    const failures = [] // from `resolved` up to the child of the nearest listable ancestor
    let ancestor = resolved
    let level
    for (;;) {
      const answer = await list(ancestor, memo)
      if (answer.ok) { level = answer.value; break }
      if (answer.hard !== undefined) return answer.hard
      failures.push({ path: ancestor, errno: answer.errno, message: answer.message })
      const parent = dirname(ancestor)
      if (parent === ancestor) return fail('remote', `cannot list ${ancestor} on the remote: ${answer.message}`)
      ancestor = parent
    }

    let kind = 'directory'
    let creatable = true
    let blocker
    const nearest = failures[failures.length - 1]
    if (nearest !== undefined) {
      // Its parent lists fine, so the errno is about this very component.
      switch (nearest.errno) {
        case 'ENOTDIR': // a file
          if (nearest.path === resolved) kind = 'file'
          else { kind = 'missing'; blocker = nearest.path }
          creatable = false
          break
        case 'ENOENT':
          kind = 'missing'
          break
        case 'EACCES':
        case 'EPERM': // exists, cannot be read: a directory as far as the field is concerned
          kind = nearest.path === resolved ? 'directory' : 'missing'
          break
        default:
          return fail('remote', `cannot check ${nearest.path} on the remote: ${nearest.message}`)
      }
    }

    let entries = []
    let truncated = false
    if (withEntries) {
      // Shell completion over the typed directory (trailing slash) or the
      // typed segment's parent; the picker lists directories only, name-sorted.
      const dir = endsWithSlash ? resolved : dirname(resolved)
      const prefix = endsWithSlash ? '' : basename(resolved)
      const lower = prefix.toLowerCase()
      const listing = dir === level.path ? level : (dir === resolved && kind !== 'directory') ? undefined : (await list(dir, memo)).value
      if (listing !== undefined) {
        const matches = listing.entries.filter(entry => entry.name.toLowerCase().startsWith(lower) && (!entry.name.startsWith('.') || prefix.startsWith('.')))
        truncated = matches.length > MAX_SUGGESTIONS || listing.truncated === true
        entries = matches.slice(0, MAX_SUGGESTIONS).map(entry => ({ name: entry.name, path: join(dir, entry.name) }))
      }
    }
    return { ...ok({ home, resolved, kind, creatable, ...(blocker === undefined ? {} : { blocker }), entries, truncated }), ancestor }
  }

  /** `mkdir -p` out of single-segment `createDirectory` calls, from the nearest existing ancestor down. */
  const mkdirNative = async (input) => {
    const info = await inspectNative(input, { withEntries: false })
    if (!info.ok) return info
    const { resolved, kind, creatable, blocker } = info.value
    if (kind === 'file') return fail('remote', `${resolved} exists and is not a directory`)
    if (kind === 'directory') return ok({ path: resolved, created: false })
    if (!creatable) return fail('remote', `cannot create ${resolved}: ${blocker ?? 'an ancestor'} is a file`)
    let parent = info.ancestor
    for (const name of resolved.slice(parent.length).split('/').filter(segment => segment !== '')) {
      const made = await egress.call('directoryPicker', 'createDirectory', { path: parent, name })
      // `exists`: somebody made it between the inspection and now — fine.
      if (!made.ok && made.error?.code !== 'directory-picker/exists') return made
      parent = join(parent, name)
    }
    return ok({ path: resolved, created: true })
  }

  // --- door 1 first, door 2 when it is not there ----------------------------

  const through = async (endpoint, args, native) => {
    let peer
    if (!peerMissing) {
      peer = await egress.callControl(endpoint, args)
      if (peer.ok || !NO_SUCH_DOOR.test(peer.error?.code ?? '')) return peer
      peerMissing = true
    }
    const result = await native()
    if (!result.ok && NO_SUCH_DOOR.test(result.error?.code ?? '')) {
      return fail('fs-unavailable', 'the remote DSH cannot inspect paths (no dsh-remote-workspaces there and no browse directory picker)', { peer: peer?.error, native: result.error })
    }
    return result
  }

  return {
    /** @param {string} path what the operator typed (`~/proj/th`, `/Users/x/`) */
    inspect: path => through('fs.inspect', { path }, async () => {
      const result = await inspectNative(path)
      return result.ok ? ok(result.value) : result
    }),
    /** @param {string} path an absolute or `~`-relative directory to make (`mkdir -p`) */
    mkdir: path => through('fs.mkdir', { path }, () => mkdirNative(path)),
  }
}

/**
 * Persisted intent of the Tailscale remote: whether the operator enabled it,
 * which tailnet logins may enter without a token, and the standing access
 * token. Lives beside the DSH home (`$DSH_HOME/tailscale-remote.json`, mode
 * 0600) because the token is a credential: whoever holds it drives an agent
 * that runs commands on this machine.
 *
 * tailscaled — not this file — is the source of truth for whether the route
 * is actually published; `enabled` only says what the operator asked for.
 */
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const VERSION = 1
/** 192-bit token, base64url (32 chars) — long enough to be unguessable, short enough for a QR. */
const TOKEN_BYTES = 24

/** Default state file: `$DSH_HOME/tailscale-remote.json`. */
export function defaultStateFile() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'tailscale-remote.json')
}

export function generateToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/** Lower-cased, trimmed login for exact-match comparison. */
export function normalizeLogin(value) {
  return String(value ?? '').trim().toLowerCase()
}

/**
 * Parse a comma/space/newline separated login list into unique normalized
 * entries. Entries with quotes or angle brackets are dropped as typos.
 * @param {unknown} value
 * @returns {string[]}
 */
export function parseUserList(value) {
  const raw = Array.isArray(value) ? value.map(String) : String(value ?? '').split(/[\s,;]+/)
  const out = []
  for (const entry of raw) {
    const login = normalizeLogin(entry)
    if (login === '' || login.length > 254 || /["'<>]/.test(login)) continue
    if (!out.includes(login)) out.push(login)
  }
  return out
}

function normalizeState(raw) {
  const record = typeof raw === 'object' && raw !== null ? raw : {}
  const token = typeof record.token === 'string' && /^[A-Za-z0-9_-]{16,}$/.test(record.token) ? record.token : generateToken()
  return {
    version: VERSION,
    enabled: record.enabled === true,
    allowedUsers: parseUserList(record.allowedUsers),
    token,
  }
}

/**
 * Load the state file, creating a fresh (disabled, tokened) state when it is
 * missing or unreadable. A missing/short token is regenerated.
 * @param {string} file
 */
export async function loadState(file) {
  let raw
  try {
    raw = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn(`tailscale-remote: state file ${file} unreadable, starting fresh: ${String(error?.message ?? error)}`)
    raw = undefined
  }
  const state = normalizeState(raw)
  // Persist immediately when the file did not exist or lacked a valid token,
  // so the QR shown to the operator survives a restart.
  if (raw === undefined || raw.token !== state.token) await saveState(file, state)
  return state
}

/**
 * Write the state atomically with owner-only permissions.
 * @param {string} file
 * @param {{ version: number, enabled: boolean, allowedUsers: string[], token: string }} state
 */
export async function saveState(file, state) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, file)
}

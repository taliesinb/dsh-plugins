/**
 * Persisted registry of remote DSH servers and the remote workspaces mirrored
 * in this GUI (`$DSH_HOME/remote-workspaces.json`, mode 0600 — a server entry
 * may carry a standing token). Remote workspaces are NOT entries of the local
 * `dsh-workspace` registry (that one needs a real local directory); they live
 * here and the client half merges them into the sidebar.
 *
 *   servers[]    { id, url, label, token?, lastUsedAt }
 *   workspaces[] { id, serverId, remoteWorkspaceId, title, remotePath, createdAt, order,
 *                  cache: { sessions: [{ id, title, updatedAt? }], polledAt? } }
 */
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const VERSION = 1

/** Default state file: `$DSH_HOME/remote-workspaces.json`. */
export function defaultStateFile() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'remote-workspaces.json')
}

export function generateId(prefix) {
  return `${prefix}-${randomBytes(6).toString('base64url')}`
}

/** A short, URL-safe route segment derived from a server label (`robotics-vm`), unique among `taken`. */
export function routeIdFor(label, taken = new Set()) {
  const base = String(label ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'remote'
  let candidate = base
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${base}-${String(n)}`
  return candidate
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

function normalizeServer(raw) {
  if (typeof raw !== 'object' || raw === null) return undefined
  const id = String(raw.id ?? '')
  const url = String(raw.url ?? '')
  if (!ID_PATTERN.test(id) || url === '') return undefined
  return {
    id,
    url,
    label: String(raw.label ?? id),
    token: typeof raw.token === 'string' && raw.token !== '' ? raw.token : undefined,
    lastUsedAt: typeof raw.lastUsedAt === 'string' ? raw.lastUsedAt : undefined,
  }
}

function normalizeWorkspace(raw, serverIds) {
  if (typeof raw !== 'object' || raw === null) return undefined
  const id = String(raw.id ?? '')
  const serverId = String(raw.serverId ?? '')
  const remoteWorkspaceId = String(raw.remoteWorkspaceId ?? '')
  if (id === '' || !serverIds.has(serverId) || remoteWorkspaceId === '') return undefined
  const cache = typeof raw.cache === 'object' && raw.cache !== null ? raw.cache : {}
  const sessions = Array.isArray(cache.sessions)
    ? cache.sessions.flatMap(entry => (typeof entry === 'object' && entry !== null && typeof entry.id === 'string'
      ? [{ id: entry.id, title: String(entry.title ?? ''), ...(typeof entry.updatedAt === 'string' ? { updatedAt: entry.updatedAt } : {}) }]
      : []))
    : []
  return {
    id,
    serverId,
    remoteWorkspaceId,
    title: String(raw.title ?? remoteWorkspaceId),
    remotePath: String(raw.remotePath ?? ''),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString(),
    order: Number.isFinite(raw.order) ? Number(raw.order) : 0,
    cache: { sessions, ...(typeof cache.polledAt === 'string' ? { polledAt: cache.polledAt } : {}) },
  }
}

export function normalizeState(raw) {
  const record = typeof raw === 'object' && raw !== null ? raw : {}
  const servers = (Array.isArray(record.servers) ? record.servers : []).flatMap(entry => {
    const server = normalizeServer(entry)
    return server === undefined ? [] : [server]
  })
  const seen = new Set()
  const uniqueServers = servers.filter(server => !seen.has(server.id) && seen.add(server.id))
  const serverIds = new Set(uniqueServers.map(server => server.id))
  const workspaces = (Array.isArray(record.workspaces) ? record.workspaces : []).flatMap(entry => {
    const workspace = normalizeWorkspace(entry, serverIds)
    return workspace === undefined ? [] : [workspace]
  })
  return { version: VERSION, servers: uniqueServers, workspaces }
}

/** @returns {Promise<ReturnType<typeof normalizeState>>} */
export async function loadState(file) {
  try {
    return normalizeState(JSON.parse(await readFile(file, 'utf8')))
  } catch (error) {
    if (error?.code === 'ENOENT') return normalizeState({})
    throw new Error(`remote-workspaces: cannot read ${file}: ${String(error?.message ?? error)}`)
  }
}

export async function saveState(file, state) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${String(process.pid)}.tmp`
  await writeFile(tmp, `${JSON.stringify(normalizeState(state), null, 2)}\n`, { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, file)
}

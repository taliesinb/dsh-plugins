/**
 * Typed face over the plugin's control channel (`POST /remote-workspaces/<endpoint>`,
 * Connection envelope). Mirrors the host half's snapshot shapes (index.js).
 */
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'

export const CHANNEL = '/remote-workspaces'

export interface BridgeStatus {
  url: string
  mode: 'identity' | 'token'
  bridged: boolean
  bridgedAt?: string
  lastFailure?: { at: number; status: number; message: string }
}

export interface ServerInfo {
  id: string
  url: string
  label: string
  seeded: boolean
  hasToken: boolean
  /** `/remote/<id>/` — the iframe base. */
  localBase: string
  bridge?: BridgeStatus
}

export interface CachedSession {
  id: string
  title: string
  updatedAt?: string
  running?: boolean
}

export interface RemoteWorkspace {
  id: string
  serverId: string
  remoteWorkspaceId: string
  /** Local display title. */
  title: string
  remotePath: string
  remoteTitle?: string
  createdAt: string
  order: number
  sessionOrder?: string[]
  cache: { sessions: CachedSession[]; polledAt?: string; gone?: boolean }
  server?: { id: string; label: string; localBase: string }
}

export interface StatusSnapshot {
  routePrefix: string
  lastServerUrl?: string
  servers: ServerInfo[]
  workspaces: RemoteWorkspace[]
}

export interface ProbeResult {
  url: string
  hostname: string
  serverId?: string
  label: string
  elapsedMs: number
  mode: 'identity' | 'token'
  workspaces: { workspaceId: string; path: string; title: string; sessionCount: number; mirrored: boolean }[]
}

export class RemoteApiError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message)
  }
}

export interface RemoteApi {
  status(): Promise<StatusSnapshot>
  probeServer(url: string, token?: string): Promise<ProbeResult>
  addWorkspace(input: { url: string; token?: string; label?: string; remoteWorkspaceId?: string; remotePath?: string; title?: string }): Promise<RemoteWorkspace>
  pollWorkspace(id: string): Promise<RemoteWorkspace>
  removeWorkspace(id: string): Promise<StatusSnapshot>
  renameWorkspace(id: string, title: string): Promise<StatusSnapshot>
  reorderWorkspaces(ids: string[]): Promise<StatusSnapshot>
  reorderSessions(workspaceId: string, ids: string[]): Promise<RemoteWorkspace>
  renameSession(workspaceId: string, sessionId: string, title: string): Promise<RemoteWorkspace>
  archiveSession(workspaceId: string, sessionId: string): Promise<RemoteWorkspace>
  startSession(workspaceId: string): Promise<{ sessionId: string; created: boolean }>
}

export function createApi(rpc: ClientConnectionRpc): RemoteApi {
  const call = async <T>(endpoint: string, args: Record<string, unknown> = {}): Promise<T> => {
    const result = await rpc.call(CHANNEL, endpoint, { args }) as
      | { ok: true; value: T }
      | { ok: false; error: { code: string; message: string; details?: unknown } }
    if (!result.ok) throw new RemoteApiError(result.error.code, result.error.message, result.error.details)
    return result.value
  }
  const workspaceOf = (value: { workspace: RemoteWorkspace }): RemoteWorkspace => value.workspace
  return {
    status: () => call<StatusSnapshot>('status'),
    probeServer: (url, token) => call<ProbeResult>('servers.probe', { url, token }),
    addWorkspace: input => call<{ workspace: RemoteWorkspace }>('workspaces.add', input).then(workspaceOf),
    pollWorkspace: id => call<{ workspace: RemoteWorkspace }>('workspaces.poll', { id }).then(workspaceOf),
    removeWorkspace: id => call<StatusSnapshot>('workspaces.remove', { id }),
    renameWorkspace: (id, title) => call<StatusSnapshot>('workspaces.rename', { id, title }),
    reorderWorkspaces: ids => call<StatusSnapshot>('workspaces.reorder', { ids }),
    reorderSessions: (workspaceId, ids) => call<{ workspace: RemoteWorkspace }>('sessions.reorder', { workspaceId, ids }).then(workspaceOf),
    renameSession: (workspaceId, sessionId, title) => call<{ workspace: RemoteWorkspace }>('sessions.rename', { workspaceId, sessionId, title }).then(workspaceOf),
    archiveSession: (workspaceId, sessionId) => call<{ workspace: RemoteWorkspace }>('sessions.archive', { workspaceId, sessionId }).then(workspaceOf),
    startSession: workspaceId => call<{ sessionId: string; created: boolean }>('sessions.start', { workspaceId }),
  }
}

/**
 * View helpers of the Remotes section: the View-options menu (group by
 * Workspace / Server / In one list; order by Manual / Last updated / Last
 * created), the sort/group derivations, and the hover cards that mirror the
 * local tree's (title, time, status; path and server for groups).
 */
import { HoverCard, IconPersonalizationOutline16, Menu, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { CachedSession, RemoteWorkspace, ServerInfo } from './api.ts'
import type { RemoteGroupBy, RemoteOrderBy } from './store.ts'

// ---------------------------------------------------------------------------
// ordering

/** A session row with the workspace it belongs to (flat and server views need both). */
export interface PlacedSession {
  session: CachedSession & { placeholder?: boolean }
  workspace: RemoteWorkspace
}

function updatedMs(session: CachedSession): number {
  return session.updatedAt === undefined ? 0 : Date.parse(session.updatedAt) || 0
}

/**
 * Order one workspace's cached sessions. Manual = the poll's order (the
 * remote's, with local drags layered by the host); updated = newest activity
 * first; created = the remote account's position (creation order unless
 * someone dragged there), newest first.
 */
export function orderSessions<T extends CachedSession>(sessions: readonly T[], orderBy: RemoteOrderBy): T[] {
  if (orderBy === 'manual') return [...sessions]
  const copy = [...sessions]
  if (orderBy === 'updated') return copy.sort((a, b) => updatedMs(b) - updatedMs(a))
  return copy.sort((a, b) => (b.remoteIndex ?? -1) - (a.remoteIndex ?? -1))
}

/** Order workspaces for the section (manual = the persisted order; otherwise by their newest session / registration). */
export function orderWorkspaces(workspaces: readonly RemoteWorkspace[], orderBy: RemoteOrderBy): RemoteWorkspace[] {
  if (orderBy === 'manual') return [...workspaces]
  const newest = (workspace: RemoteWorkspace): number => Math.max(0, ...workspace.cache.sessions.map(updatedMs))
  const created = (workspace: RemoteWorkspace): number => Date.parse(workspace.remoteCreatedAt ?? workspace.createdAt) || 0
  const key = orderBy === 'updated' ? newest : created
  return [...workspaces].sort((a, b) => key(b) - key(a))
}

/** Every session of every workspace, placed, in the chosen order (flat view). */
export function flatten(workspaces: readonly RemoteWorkspace[], orderBy: RemoteOrderBy): PlacedSession[] {
  const placed: PlacedSession[] = []
  for (const workspace of orderWorkspaces(workspaces, orderBy)) {
    for (const session of orderSessions(workspace.cache.sessions, orderBy)) placed.push({ session, workspace })
  }
  if (orderBy === 'manual') return placed
  return placed.sort((a, b) => orderBy === 'updated'
    ? updatedMs(b.session) - updatedMs(a.session)
    : (b.session.remoteIndex ?? -1) - (a.session.remoteIndex ?? -1))
}

/** Workspaces grouped by server, servers in first-seen order. */
export function byServer(workspaces: readonly RemoteWorkspace[]): { serverId: string; label: string; workspaces: RemoteWorkspace[] }[] {
  const groups = new Map<string, { serverId: string; label: string; workspaces: RemoteWorkspace[] }>()
  for (const workspace of workspaces) {
    const group = groups.get(workspace.serverId) ?? { serverId: workspace.serverId, label: workspace.server?.label ?? workspace.serverId, workspaces: [] }
    group.workspaces.push(workspace)
    groups.set(workspace.serverId, group)
  }
  return [...groups.values()]
}

// ---------------------------------------------------------------------------
// time labels (the local tree's vocabulary)

export function relativeLabel(iso: string | undefined, now: number): string {
  if (iso === undefined) return ''
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const minutes = Math.max(0, Math.round((now - ms) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${String(minutes)}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${String(hours)}h`
  const days = Math.round(hours / 24)
  if (days < 30) return `${String(days)}d`
  return new Date(ms).toLocaleDateString()
}

function relativeSentence(iso: string | undefined, now: number): string {
  const short = relativeLabel(iso, now)
  if (short === '') return ''
  if (short === 'now') return 'just now'
  if (/^\d+[mhd]$/u.test(short)) {
    const n = Number(short.slice(0, -1))
    const unit = { m: 'minute', h: 'hour', d: 'day' }[short.slice(-1) as 'm' | 'h' | 'd']
    return `${String(n)} ${unit}${n === 1 ? '' : 's'} ago`
  }
  return short
}

function absoluteLabel(iso: string | undefined): string | undefined {
  if (iso === undefined) return undefined
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return undefined
  const pad = (v: number): string => String(v).padStart(2, '0')
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ---------------------------------------------------------------------------
// hover cards (Rows.module.css .hoverContent / .hoverTitle / .hoverPath / .hoverTime / .hoverStatus)

const H = {
  content: { display: 'flex', flexDirection: 'column', gap: 8 } as CSSProperties,
  title: { fontSize: 14, lineHeight: '20px', color: '#FFFFFF', overflowWrap: 'break-word' } as CSSProperties,
  path: { fontSize: 12, lineHeight: '16px', color: '#CFD3D6', wordBreak: 'break-all' } as CSSProperties,
  time: { fontSize: 12, lineHeight: '16px', color: '#CFD3D6' } as CSSProperties,
  status: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, lineHeight: '20px', color: '#CFD3D6' } as CSSProperties,
}

const COPY = { copyLabel: 'Copy', copiedLabel: 'Copied' }

function permissionLabel(permissions: unknown): string | undefined {
  const mode = typeof permissions === 'object' && permissions !== null ? (permissions as { mode?: unknown }).mode : undefined
  if (typeof mode !== 'string') return undefined
  return ({ 'workspace-write': 'Workspace Write', 'read-only': 'Read Only', 'danger-full-access': 'Full Access' } as Record<string, string>)[mode] ?? mode
}

export function SessionHover({ anchor, session, workspace, now, disabled }: {
  anchor: ReactNode
  session: CachedSession & { placeholder?: boolean }
  workspace: RemoteWorkspace
  now: number
  disabled: boolean
}) {
  const title = session.title !== '' ? session.title : session.placeholder === true ? 'New session' : `Untitled · ${session.id.replace(/^session-/u, '').slice(0, 8)}`
  const server = workspace.server?.label ?? workspace.serverId
  const permission = permissionLabel(session.permissions)
  return (
    <HoverCard
      anchor={anchor}
      disabled={disabled}
      copyText={session.title === '' ? undefined : session.title}
      {...COPY}
      content={(
        <div style={H.content}>
          <div style={H.title}>{title}</div>
          <div style={H.path}>{workspace.title} · {server}</div>
          {session.placeholder !== true && relativeSentence(session.updatedAt, now) !== '' && <div style={H.time}>{relativeSentence(session.updatedAt, now)}</div>}
          <div style={H.status}>
            <StateDot state={session.running === true ? 'ongoing' : 'done'} />
            <span>{session.running === true ? 'Running' : 'Idle'}</span>
          </div>
          {permission !== undefined && <div style={H.time}>{permission}</div>}
        </div>
      )}
    />
  )
}

export function WorkspaceHover({ anchor, workspace, now, disabled }: { anchor: ReactNode; workspace: RemoteWorkspace; now: number; disabled: boolean }) {
  const server = workspace.server?.label ?? workspace.serverId
  const polled = workspace.cache.polledAt
  const running = workspace.cache.sessions.filter(session => session.running === true).length
  const created = absoluteLabel(workspace.remoteCreatedAt)
  return (
    <HoverCard
      anchor={anchor}
      disabled={disabled}
      copyText={workspace.remotePath}
      {...COPY}
      content={(
        <div style={H.content}>
          <div style={H.title}>{workspace.title}</div>
          <div style={H.path}>{server}:{workspace.remotePath}</div>
          {workspace.remoteTitle !== undefined && workspace.remoteTitle !== workspace.title && <div style={H.time}>Named “{workspace.remoteTitle}” on {server}</div>}
          {created !== undefined && <div style={H.time}>Created {created}</div>}
          <div style={H.time}>
            {workspace.cache.gone === true
              ? 'No longer on the remote'
              : polled === undefined
                ? 'Not yet fetched'
                : `${String(workspace.cache.sessions.length)} session${workspace.cache.sessions.length === 1 ? '' : 's'}${running > 0 ? `, ${String(running)} running` : ''} · fetched ${relativeSentence(polled, now)}`}
          </div>
        </div>
      )}
    />
  )
}

export function ServerHover({ anchor, server, workspaces, now, disabled }: {
  anchor: ReactNode
  server: ServerInfo | undefined
  workspaces: readonly RemoteWorkspace[]
  now: number
  disabled: boolean
}) {
  const sessions = workspaces.reduce((sum, workspace) => sum + workspace.cache.sessions.length, 0)
  const running = workspaces.reduce((sum, workspace) => sum + workspace.cache.sessions.filter(session => session.running === true).length, 0)
  const bridge = server?.bridge
  const failure = bridge?.lastFailure
  return (
    <HoverCard
      anchor={anchor}
      disabled={disabled}
      copyText={server?.url}
      {...COPY}
      content={(
        <div style={H.content}>
          <div style={H.title}>{server?.label ?? 'Remote'}</div>
          {server !== undefined && <div style={H.path}>{server.url}</div>}
          <div style={H.time}>
            {String(workspaces.length)} workspace{workspaces.length === 1 ? '' : 's'}, {String(sessions)} session{sessions === 1 ? '' : 's'}{running > 0 ? `, ${String(running)} running` : ''}
          </div>
          {bridge !== undefined && (
            <div style={H.status}>
              <StateDot state={failure === undefined ? 'done' : 'warning'} />
              <span>
                {failure === undefined
                  ? `${bridge.mode === 'token' ? 'Token' : 'Identity'} auth${bridge.bridgedAt === undefined ? '' : ` · connected ${relativeSentence(bridge.bridgedAt, now)}`}`
                  : failure.message}
              </span>
            </div>
          )}
        </div>
      )}
    />
  )
}

// ---------------------------------------------------------------------------
// view options

export function ViewOptions({ groupBy, orderBy, onGroupBy, onOrderBy, iconButtonStyle }: {
  groupBy: RemoteGroupBy
  orderBy: RemoteOrderBy
  onGroupBy: (mode: RemoteGroupBy) => void
  onOrderBy: (mode: RemoteOrderBy) => void
  iconButtonStyle: CSSProperties
}) {
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState(false)
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={[
        { type: 'label', id: 'group-by', text: 'Group by' },
        { id: 'workspace', label: 'Workspace' },
        { id: 'server', label: 'Server' },
        { id: 'flat', label: 'In one list' },
        { type: 'separator', id: 'sep' },
        { type: 'label', id: 'order-by', text: 'Order by' },
        { id: 'manual', label: 'Manual' },
        { id: 'updated', label: 'Last updated' },
        { id: 'created', label: 'Last created' },
      ]}
      selectedIds={[groupBy, orderBy]}
      onSelect={(id) => {
        if (id === 'workspace' || id === 'server' || id === 'flat') onGroupBy(id)
        else if (id === 'manual' || id === 'updated' || id === 'created') onOrderBy(id)
        setOpen(false)
      }}
      align="end"
      dense
      portal
      anchor={(
        <Tooltip label="View options" side="bottom" delayMs={500}>
          <button
            type="button"
            aria-label="View options"
            style={{ ...iconButtonStyle, background: hover ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent' }}
            onMouseEnter={() => { setHover(true) }}
            onMouseLeave={() => { setHover(false) }}
            onClick={() => { setOpen(value => !value) }}
          >
            <IconPersonalizationOutline16 />
          </button>
        </Tooltip>
      )}
    />
  )
}

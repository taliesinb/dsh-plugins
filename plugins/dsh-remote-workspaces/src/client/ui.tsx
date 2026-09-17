/**
 * Browser components of dsh-remote-workspaces. English only, inline styles on
 * the shell's alias tokens (house pattern of the other plugins).
 *
 *  - RemotesSection    extra seat below the local tree: the "Remotes" section —
 *                      header (label, refresh-all, add) and one collapsible
 *                      group per mirrored workspace (cached sessions with
 *                      spinners while a poll runs, ↻ / … / + actions, session
 *                      … menus, drag-to-reorder groups and sessions).
 *  - AddRemoteModal    URL (+token) → probe → pick a remote workspace or type
 *                      a directory → name → Done.
 *  - RemoteSessionPanel  keyed `main` entry: an empty host the frame pool
 *                      positions over. Mounted only while our panel is active.
 *  - FramePool         `shell.overlay` entry: the iframes. Always mounted, so a
 *                      hidden frame keeps its WebSocket until the TTL sweep.
 */
import {
  Button, IconEllipsisOutline16, IconFolderClose16, IconFolderOpen16, IconGlobeOutline14, IconLoadingOutline16,
  IconPlusOutline16, IconProjectAddOutline16, IconRefreshOutline16, IconTriangleRightFill14, Input, Menu, Modal, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { ProbeResult, RemoteApi, RemoteWorkspace, ServerInfo } from './api.ts'
import { FLAT_POLL_INTERVAL_MS, PANEL_ID, type RemoteSelection, type RemoteWorkspacesModel, type RuntimeState, type ViewState } from './store.ts'
import { byServer, flatten, orderSessions, orderWorkspaces, relativeLabel, ServerHover, SessionHover, ViewOptions, WorkspaceHover } from './view.tsx'

/** Inject face every component of this plugin receives. */
export interface RemoteInjected {
  model: RemoteWorkspacesModel
  api: RemoteApi
  /** Select a remote session and bring our main panel forward. */
  openRemoteSession: (selection: RemoteSelection) => void
  /** Local workspaces (destinations for a remote → local move). */
  localWorkspaces: () => readonly LocalWorkspaceView[]
  hooks: {
    view: RemoteWorkspacesModel['view']
    runtime: RemoteWorkspacesModel['runtime']
  }
}

/** The slice of a local workspace the move dialog needs. */
export interface LocalWorkspaceView {
  workspaceId: string
  title: string
  path: string
}
type Face = InjectFace<RemoteInjected>

// ---------------------------------------------------------------------------
// styles

const S = {
  iconButton: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 6,
    border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', position: 'relative',
  } as CSSProperties,
  badge: {
    position: 'absolute', right: 2, bottom: 2, width: 12, height: 12, borderRadius: 6, display: 'grid', placeItems: 'center',
    background: 'var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base))', color: 'var(--dsw-alias-state-business-primary)',
  } as CSSProperties,
  // Mirrors WorkspaceBrowser.module.css .sectionHeader (36px, tertiary label) —
  // the "Workspaces" header this section sits under.
  sectionHeader: {
    flex: 'none', display: 'flex', alignItems: 'center', gap: 4, height: 36, paddingLeft: 4, marginBottom: 4,
    boxSizing: 'border-box', color: 'var(--dsw-alias-label-tertiary)', fontSize: 13,
  } as CSSProperties,
  sectionLabel: { flex: 'none', minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', lineHeight: '20px' } as CSSProperties,
  group: {} as CSSProperties,
  // Mirrors ui-workspace Rows.module.css: .projectRow (34px, pad 0 8, gap 6),
  // a 16x20 leading slot (folder, chevron on hover), hover-revealed actions
  // (16px buttons, gap 12).
  groupRow: {
    display: 'flex', alignItems: 'center', gap: 6, height: 34, padding: '0 8px', borderRadius: 8, cursor: 'pointer',
    userSelect: 'none', color: 'var(--dsw-alias-label-primary)', fontSize: 13, boxSizing: 'border-box',
  } as CSSProperties,
  slot: { flex: 'none', width: 16, height: 20, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', position: 'relative' } as CSSProperties,
  groupTitle: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as CSSProperties,
  rowActions: { flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 12, height: 20 } as CSSProperties,
  rowButton: {
    flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, border: 'none',
    borderRadius: 4, padding: 0, background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer',
  } as CSSProperties,
  // .sessionRow: 32px, pad 0 8, a 16px status slot, then a 4px title gap (no extra indent under a group).
  sessionRow: {
    display: 'flex', alignItems: 'center', gap: 0, height: 32, padding: '0 8px', borderRadius: 8, cursor: 'pointer',
    userSelect: 'none', color: 'var(--dsw-alias-label-primary)', fontSize: 13, boxSizing: 'border-box',
  } as CSSProperties,
  sessionTitle: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: '0 6px 0 4px' } as CSSProperties,
  muted: { color: 'var(--dsw-alias-label-tertiary)' } as CSSProperties,
  error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, padding: '2px 8px 4px 28px' } as CSSProperties,
  hint: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, padding: '2px 8px 4px 28px' } as CSSProperties,
  field: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 } as CSSProperties,
  label: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } as CSSProperties,
  caption: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.4 } as CSSProperties,
  list: { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 220, overflow: 'auto', border: '1px solid var(--dsw-alias-border-l4)', borderRadius: 8, padding: 4 } as CSSProperties,
  option: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 13 } as CSSProperties,
}

const HOVER = 'var(--dsw-alias-interactive-bg-hover)'

function Spinner({ size = 14 }: { size?: number }) {
  return (
    <span style={{ display: 'inline-flex', animation: 'dsh-remote-spin 900ms linear infinite', color: 'var(--dsw-alias-label-tertiary)' }}>
      <IconLoadingOutline16 size={size} />
      <style>{'@keyframes dsh-remote-spin { to { transform: rotate(360deg) } }'}</style>
    </span>
  )
}

function IconButton({ label, onClick, children, disabled }: { label: string; onClick: (event: React.MouseEvent) => void; children: ReactNode; disabled?: boolean }) {
  const [hover, setHover] = useState(false)
  return (
    <Tooltip label={label} delayMs={500}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        style={{ ...S.iconButton, background: hover && !disabled ? HOVER : 'transparent', opacity: disabled ? 0.5 : 1 }}
        onMouseEnter={() => { setHover(true) }}
        onMouseLeave={() => { setHover(false) }}
        onClick={(event) => { event.stopPropagation(); onClick(event) }}
      >
        {children}
      </button>
    </Tooltip>
  )
}

/** 16px row action button, like the local tree's `.iconButton`. */
function RowButton({ label, onClick, children, disabled }: { label: string; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  const [hover, setHover] = useState(false)
  return (
    <Tooltip label={label} delayMs={500}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        style={{ ...S.rowButton, color: hover && !disabled ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)', opacity: disabled ? 0.5 : 1 }}
        onMouseEnter={() => { setHover(true) }}
        onMouseLeave={() => { setHover(false) }}
        onClick={(event) => { event.stopPropagation(); onClick() }}
      >
        {children}
      </button>
    </Tooltip>
  )
}

/** Folder icon with the small "remote" globe badge — the row and button decoration. */
function RemoteFolderIcon({ open, active }: { open: boolean; active?: boolean }) {
  return (
    <span style={{ position: 'relative', display: 'inline-flex', width: 16, height: 16, alignItems: 'center', justifyContent: 'center', color: active ? 'var(--dsw-alias-state-business-primary)' : undefined }}>
      {open ? <IconFolderOpen16 size={16} /> : <IconFolderClose16 size={16} />}
      <span style={{ ...S.badge, right: -5, bottom: -4, width: 11, height: 11 }}><IconGlobeOutline14 size={9} /></span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// drag-to-reorder (HTML5 DnD; groups among themselves, sessions within a group)

type DragItem = { kind: 'group'; id: string } | { kind: 'session'; id: string; workspaceId: string }
type DropHalf = 'before' | 'after'
interface DragState {
  item: DragItem | null
  over: { key: string; half: DropHalf } | null
  start: (item: DragItem) => void
  hover: (key: string, half: DropHalf) => void
  leave: (key: string) => void
  end: () => void
}
const NO_SELECT: CSSProperties = { userSelect: 'none', WebkitUserSelect: 'none' }

function dropStyle(state: DragState, key: string): CSSProperties {
  if (state.over?.key !== key) return {}
  return { boxShadow: state.over.half === 'before' ? 'inset 0 2px 0 var(--dsw-alias-state-business-primary)' : 'inset 0 -2px 0 var(--dsw-alias-state-business-primary)' }
}

/** Reorder `ids` so `moved` lands before/after `target`. */
function reorder(ids: readonly string[], moved: string, target: string, half: DropHalf): string[] {
  if (moved === target) return [...ids]
  const rest = ids.filter(id => id !== moved)
  const at = rest.indexOf(target)
  if (at === -1) return [...ids]
  rest.splice(half === 'before' ? at : at + 1, 0, moved)
  return rest
}

function halfOf(event: React.DragEvent<HTMLElement>): DropHalf {
  const rect = event.currentTarget.getBoundingClientRect()
  return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

// ---------------------------------------------------------------------------
// groups

function shortId(id: string): string {
  return id.replace(/^session-/, '').slice(0, 8)
}

function SessionRow({ workspace, session, selected, busy, openRemoteSession, model, drag, order, caption, now, reorderable = true }: {
  workspace: RemoteWorkspace
  session: RemoteWorkspace['cache']['sessions'][number] & { placeholder?: boolean }
  selected: boolean
  busy: boolean
  drag: DragState
  /** Current ids of this group's rows, for computing the dropped order. */
  order: readonly string[]
  /** Context shown under the title when the row is not under its own workspace header (server / flat views). */
  caption?: string | undefined
  now: number
  /** Manual order only: drag handles and drop targets. */
  reorderable?: boolean
} & Pick<Face, 'openRemoteSession' | 'model'>) {
  const dragKey = `session:${session.id}`
  const compatible = reorderable && drag.item?.kind === 'session' && drag.item.workspaceId === workspace.id && drag.item.id !== session.id
  const [hover, setHover] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [rename, setRename] = useState<string | null>(null)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const items: MenuEntry[] = [
    { id: 'rename', label: 'Rename' },
    ...(session.placeholder === true ? [] : [{ id: 'move', label: 'Move to…' }]),
    { id: 'archive', label: 'Archive', danger: true },
  ]
  const onSelect = async (id: string): Promise<void> => {
    setMenuOpen(false)
    if (id === 'rename') { setRename(session.title); setRenameError(null); return }
    if (id === 'move') { model.openMove({ sessionId: session.id, title: session.title, source: { workspaceId: workspace.id } }); return }
    if (id === 'archive') {
      setPending(true)
      try { await model.archiveSession(workspace.id, session.id) } catch { /* the group shows the error */ } finally { setPending(false) }
    }
  }
  const confirmRename = async (): Promise<void> => {
    if (rename === null) return
    setPending(true)
    try {
      await model.renameSession(workspace.id, session.id, rename.trim())
      setRename(null)
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : String(error))
    } finally { setPending(false) }
  }
  const time = session.placeholder === true ? '' : relativeLabel(session.updatedAt, now)
  const row = (
      <div
        role="treeitem"
        aria-selected={selected}
        draggable={reorderable && session.placeholder !== true}
        style={{ ...S.sessionRow, ...NO_SELECT, ...dropStyle(drag, dragKey), height: caption === undefined ? 32 : 44, background: selected || hover ? HOVER : 'transparent', opacity: pending || drag.item?.id === session.id ? 0.6 : 1 }}
        onMouseEnter={() => { setHover(true) }}
        onMouseLeave={() => { setHover(false) }}
        onClick={() => { openRemoteSession({ workspaceId: workspace.id, sessionId: session.id }) }}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', dragKey)
          drag.start({ kind: 'session', id: session.id, workspaceId: workspace.id })
        }}
        onDragEnd={drag.end}
        onDragOver={(event) => { if (compatible) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; drag.hover(dragKey, halfOf(event)) } }}
        onDragLeave={() => { drag.leave(dragKey) }}
        onDrop={(event) => {
          if (!compatible || drag.item === null) return
          event.preventDefault()
          void model.reorderSessions(workspace.id, reorder(order, drag.item.id, session.id, halfOf(event)))
          drag.end()
        }}
      >
        <span style={S.slot}>{busy ? <Spinner /> : session.running === true ? <span style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--dsw-alias-state-business-primary)' }} /> : null}</span>
        <span style={{ ...S.sessionTitle, display: 'flex', flexDirection: 'column', gap: 1, lineHeight: '18px' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {session.title || <span style={S.muted}>{'placeholder' in session && session.placeholder === true ? 'New session' : `Untitled · ${shortId(session.id)}`}</span>}
          </span>
          {caption !== undefined && <span style={{ ...S.muted, fontSize: 11, lineHeight: '14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{caption}</span>}
        </span>
        {!hover && !menuOpen && time !== '' && <span style={{ ...S.muted, fontSize: 12, flex: 'none' }}>{time}</span>}
        <span style={{ ...S.rowActions, display: hover || menuOpen ? 'inline-flex' : 'none' }} onClick={(event) => { event.stopPropagation() }}>
          <Menu
            open={menuOpen}
            items={items}
            onSelect={(id) => { void onSelect(id) }}
            onClose={() => { setMenuOpen(false) }}
            portal
            closeOnPointerLeave
            align="end"
            anchor={(
              <button
                type="button"
                aria-label="Session actions"
                style={S.rowButton}
                onClick={(event) => { event.stopPropagation(); setMenuOpen(open => !open) }}
              >
                <IconEllipsisOutline16 />
              </button>
            )}
          />
        </span>
      </div>
  )
  return (
    <>
      <SessionHover anchor={row} session={session} workspace={workspace} now={now} disabled={menuOpen || drag.item !== null} />
      <Modal
        open={rename !== null}
        onClose={() => { setRename(null) }}
        closeLabel="Close"
        title="Rename remote session"
        footer={(
          <>
            <Button variant="outline" disabled={pending} onClick={() => { setRename(null) }}>Cancel</Button>
            <Button variant="primary" disabled={pending || (rename ?? '').trim() === ''} onClick={() => { void confirmRename() }}>Rename</Button>
          </>
        )}
      >
        <Input value={rename ?? ''} autoFocus disabled={pending} onChange={(event) => { setRename(event.currentTarget.value); setRenameError(null) }}
          onKeyDown={(event) => { if (event.key === 'Enter') void confirmRename() }} />
        {renameError !== null && <div style={{ ...S.error, padding: '6px 0 0' }}>{renameError}</div>}
      </Modal>
    </>
  )
}

function Group({ workspace, model, openRemoteSession, useView, useRuntime, drag, groupOrder, now, hideServerInHover = false }: {
  workspace: RemoteWorkspace
  drag: DragState
  groupOrder: readonly string[]
  now: number
  hideServerInHover?: boolean
} & Face) {
  const dragKey = `group:${workspace.id}`
  const orderBy = useView(state => state.orderBy ?? 'manual')
  const reorderable = orderBy === 'manual'
  const compatible = reorderable && drag.item?.kind === 'group' && drag.item.id !== workspace.id
  const expanded = useView(state => state.expanded[workspace.id] === true)
  const selected = useView(state => state.selected)
  const polling = useRuntime(state => state.polling.includes(workspace.id))
  const starting = useRuntime(state => state.starting.includes(workspace.id))
  const error = useRuntime(state => state.errors[workspace.id])
  const [hover, setHover] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [rename, setRename] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [pending, setPending] = useState(false)
  const items: MenuEntry[] = [
    { id: 'rename', label: 'Rename' },
    { id: 'remove', label: 'Remove from sidebar', danger: true },
  ]
  const start = async (): Promise<void> => {
    if (!expanded) model.setExpanded(workspace.id, true)
    const selection = await model.startSession(workspace.id)
    if (selection !== undefined) {
      openRemoteSession(selection)
      void model.poll(workspace.id)
    }
  }
  const onMenu = (id: string): void => {
    setMenuOpen(false)
    if (id === 'rename') setRename(workspace.title)
    if (id === 'remove') setConfirmRemove(true)
  }
  const serverLabel = workspace.server?.label ?? workspace.serverId
  // A just-started (blank) remote session is not in the remote's visible list
  // yet; while it is the selection, pin a placeholder row like the local tree
  // pins its current blank session.
  const sessions = useMemo(() => {
    const cached = orderSessions(workspace.cache.sessions, orderBy)
    if (selected?.workspaceId === workspace.id && !cached.some(session => session.id === selected.sessionId)) {
      return [{ id: selected.sessionId, title: '', placeholder: true }, ...cached]
    }
    return cached
  }, [workspace.cache.sessions, workspace.id, selected, orderBy])
  void hideServerInHover
  const header = (
      <div
        role="treeitem"
        aria-expanded={expanded}
        draggable={reorderable}
        style={{ ...S.groupRow, ...NO_SELECT, ...dropStyle(drag, dragKey), background: hover || menuOpen ? HOVER : 'transparent', opacity: drag.item?.kind === 'group' && drag.item.id === workspace.id ? 0.6 : 1 }}
        onMouseEnter={() => { setHover(true) }}
        onMouseLeave={() => { setHover(false) }}
        onClick={() => { model.setExpanded(workspace.id, !expanded) }}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', dragKey)
          drag.start({ kind: 'group', id: workspace.id })
        }}
        onDragEnd={drag.end}
        onDragOver={(event) => { if (compatible) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; drag.hover(dragKey, halfOf(event)) } }}
        onDragLeave={() => { drag.leave(dragKey) }}
        onDrop={(event) => {
          if (!compatible || drag.item === null) return
          event.preventDefault()
          void model.reorderWorkspaces(reorder(groupOrder, drag.item.id, workspace.id, halfOf(event)))
          drag.end()
        }}
      >
        {/* Leading slot: the badged folder, swapped for the expand chevron on hover (local-tree pattern). */}
        <span style={{ ...S.slot, color: 'var(--dsw-alias-label-caption)' }}>
          {hover
            ? <span style={{ display: 'inline-flex', transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 150ms var(--ds-ease-in-out)' }}><IconTriangleRightFill14 /></span>
            : <RemoteFolderIcon open={expanded} active={selected?.workspaceId === workspace.id} />}
        </span>
        <span style={S.groupTitle}>{workspace.title}</span>
        {workspace.cache.gone === true && <span style={{ ...S.muted, fontSize: 11 }}>gone</span>}
        {polling && !hover && <Spinner size={12} />}
        {!polling && !hover && !menuOpen && (
          <span style={{ ...S.muted, fontSize: 11, flex: 'none' }}>
            {workspace.cache.polledAt === undefined ? '' : relativeLabel(workspace.cache.polledAt, now)}
          </span>
        )}
        <span style={{ ...S.rowActions, display: hover || menuOpen ? 'inline-flex' : 'none' }}>
          <RowButton label="Refresh from remote" disabled={polling} onClick={() => { void model.poll(workspace.id) }}>
            {polling ? <Spinner size={12} /> : <IconRefreshOutline16 />}
          </RowButton>
          <span style={{ display: 'inline-flex' }} onClick={(event) => { event.stopPropagation() }}>
            <Menu
              open={menuOpen}
              items={items}
              onSelect={onMenu}
              onClose={() => { setMenuOpen(false) }}
              portal
              closeOnPointerLeave
              align="end"
              anchor={(
                <button type="button" aria-label="Remote workspace actions" style={S.rowButton}
                  onClick={(event) => { event.stopPropagation(); setMenuOpen(open => !open) }}>
                  <IconEllipsisOutline16 />
                </button>
              )}
            />
          </span>
          <RowButton label="New remote session" disabled={starting || !expanded || workspace.cache.polledAt === undefined} onClick={() => { void start() }}>
            {starting ? <Spinner size={12} /> : <IconPlusOutline16 />}
          </RowButton>
        </span>
      </div>
  )
  return (
    <div style={S.group}>
      <WorkspaceHover anchor={header} workspace={workspace} now={now} disabled={menuOpen || drag.item !== null} />
      {expanded && (
        <div role="group">
          {sessions.length === 0 && !polling && workspace.cache.polledAt !== undefined && (
            <div style={S.hint}>No sessions yet — press + to start one on {serverLabel}.</div>
          )}
          {sessions.length === 0 && polling && <div style={S.hint}><Spinner size={12} /> Reaching {serverLabel}…</div>}
          {sessions.map(session => (
            <SessionRow
              key={session.id}
              workspace={workspace}
              session={session}
              busy={polling}
              selected={selected?.workspaceId === workspace.id && selected.sessionId === session.id}
              openRemoteSession={openRemoteSession}
              model={model}
              drag={drag}
              order={sessions.map(candidate => candidate.id)}
              now={now}
              reorderable={reorderable}
            />
          ))}
          {error !== undefined && <div style={S.error}>{error}</div>}
        </div>
      )}
      <Modal
        open={rename !== null}
        onClose={() => { setRename(null) }}
        closeLabel="Close"
        title="Rename remote workspace"
        footer={(
          <>
            <Button variant="outline" disabled={pending} onClick={() => { setRename(null) }}>Cancel</Button>
            <Button variant="primary" disabled={pending || (rename ?? '').trim() === ''} onClick={() => {
              setPending(true)
              void model.renameWorkspace(workspace.id, (rename ?? '').trim()).then(() => { setRename(null) }).finally(() => { setPending(false) })
            }}>Rename</Button>
          </>
        )}
      >
        <Input value={rename ?? ''} autoFocus disabled={pending} onChange={(event) => { setRename(event.currentTarget.value) }} />
        <div style={{ ...S.caption, marginTop: 8 }}>Only the name shown in this sidebar changes; the remote workspace keeps its own title.</div>
      </Modal>
      <Modal
        open={confirmRemove}
        onClose={() => { setConfirmRemove(false) }}
        closeLabel="Close"
        title="Remove remote workspace"
        footer={(
          <>
            <Button variant="outline" disabled={pending} onClick={() => { setConfirmRemove(false) }}>Cancel</Button>
            <Button variant="primary" disabled={pending} onClick={() => {
              setPending(true)
              void model.removeWorkspace(workspace.id).then(() => { setConfirmRemove(false) }).finally(() => { setPending(false) })
            }}>Remove</Button>
          </>
        )}
      >
        <div style={{ fontSize: 13 }}>Remove <b>{workspace.title}</b> from this sidebar? Nothing changes on {serverLabel}: the workspace and its sessions stay there.</div>
      </Modal>
    </div>
  )
}

/**
 * The "Remotes" section: anchored at the bottom of the list area (the local
 * tree above it flexes), growing upward to at most half the area, with its own
 * scroll. Header: label, refresh-all, add — nothing else.
 */
export function RemotesSection(props: PropsRuntime<'sidebar.workspaces.extra'> & Face) {
  const { useRuntime, useView, model } = props
  const workspaces = useRuntime(state => state.snapshot?.workspaces)
  const servers = useRuntime(state => state.snapshot?.servers)
  const loaded = useRuntime(state => state.loaded)
  const loadError = useRuntime(state => state.loadError)
  const anyPolling = useRuntime(state => state.polling.length > 0)
  const groupBy = useView(state => state.groupBy ?? 'workspace')
  const orderBy = useView(state => state.orderBy ?? 'manual')
  useEffect(() => { if (!loaded) void model.refresh() }, [loaded, model])
  // A clock for the relative labels (the local tree re-renders on its own
  // ticks; one minute is the coarsest unit we show).
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, 30_000)
    return () => { clearInterval(timer) }
  }, [])
  // Server and flat views show sessions of every workspace, so they must all
  // be current: poll them all on entry and then periodically while the view
  // is up (the Workspace view only polls what is expanded).
  useEffect(() => {
    if (groupBy === 'workspace' || (workspaces?.length ?? 0) === 0) return
    model.pollAll()
    const timer = setInterval(() => { model.pollAll() }, FLAT_POLL_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [groupBy, model, workspaces?.length])

  const [item, setItem] = useState<DragItem | null>(null)
  const [over, setOver] = useState<{ key: string; half: DropHalf } | null>(null)
  const drag = useMemo<DragState>(() => ({
    item, over,
    start: next => { setItem(next); setOver(null) },
    hover: (key, half) => { setOver(current => (current?.key === key && current.half === half ? current : { key, half })) },
    leave: key => { setOver(current => (current?.key === key ? null : current)) },
    end: () => { setItem(null); setOver(null) },
  }), [item, over])

  const ordered = orderWorkspaces(workspaces ?? [], orderBy)
  const groupOrder = ordered.map(workspace => workspace.id)
  return (
    <div
      data-remote-workspaces
      style={{
        flex: 'none', display: 'flex', flexDirection: 'column', minHeight: 0, maxHeight: '50%', marginTop: 4,
        // Right inset matches the local list's reserved scrollbar gutter so rows share one right edge.
        paddingRight: 'calc(var(--dsh-session-list-scrollbar-width, 8px) + var(--dsh-session-list-scrollbar-offset, 2px) + 2px)',
      }}
    >
      <div style={{ ...S.sectionHeader, ...NO_SELECT }}>
        <span style={S.sectionLabel}>Remotes</span>
        <span style={{ flex: '1 1 auto' }} />
        <IconButton label="Refresh all remotes" disabled={anyPolling || (workspaces?.length ?? 0) === 0} onClick={() => { model.pollAll() }}>
          {anyPolling ? <Spinner /> : <IconRefreshOutline16 size={16} />}
        </IconButton>
        <ViewOptions groupBy={groupBy} orderBy={orderBy} onGroupBy={mode => { model.setGroupBy(mode) }} onOrderBy={mode => { model.setOrderBy(mode) }} iconButtonStyle={S.iconButton} />
        <IconButton label="Add remote workspace" onClick={() => { model.setAddOpen(true) }}>
          <IconProjectAddOutline16 size={16} />
          <span style={S.badge}><IconGlobeOutline14 size={9} /></span>
        </IconButton>
      </div>
      <div style={{ minHeight: 0, overflowY: 'auto', paddingBottom: 8 }} onDragOver={(event) => { if (item !== null) event.preventDefault() }}>
        {loadError !== undefined && <div style={{ ...S.error, padding: '2px 8px' }}>Remote workspaces: {loadError}</div>}
        {loaded && loadError === undefined && (workspaces?.length ?? 0) === 0 && (
          <div style={{ ...S.hint, padding: '2px 8px' }}>No remote workspaces yet.</div>
        )}
        {groupBy === 'workspace' && ordered.map(workspace => <Group key={workspace.id} workspace={workspace} drag={drag} groupOrder={groupOrder} now={now} {...props} />)}
        {groupBy === 'server' && byServer(ordered).map(group => (
          <ServerGroup key={group.serverId} group={group} server={servers?.find(server => server.id === group.serverId)} drag={drag} groupOrder={groupOrder} now={now} {...props} />
        ))}
        {groupBy === 'flat' && <FlatList workspaces={ordered} drag={drag} now={now} {...props} />}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// add-remote modal (mounted in shell.overlay so it exists regardless of the sidebar's state)

type Step = 'server' | 'workspace'

export function AddRemoteModal({ model, api, useRuntime, openRemoteSession }: Face) {
  const open = useRuntime(state => state.addOpen)
  const lastUrl = useRuntime(state => state.snapshot?.lastServerUrl)
  const [step, setStep] = useState<Step>('server')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [probing, setProbing] = useState(false)
  const [probe, setProbe] = useState<ProbeResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pick, setPick] = useState<string | 'new'>('new')
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    if (!open) return
    setStep('server'); setProbe(null); setError(null); setPick('new'); setPath(''); setName(''); setNameTouched(false); setToken(''); setShowToken(false)
    setUrl(lastUrl ?? '')
  }, [open, lastUrl])

  const suggestedName = useMemo(() => {
    if (probe === null) return ''
    const workspaceName = pick === 'new'
      ? (path.trim().replace(/\/+$/, '').split('/').pop() ?? '')
      : (probe.workspaces.find(candidate => candidate.workspaceId === pick)?.title ?? '')
    // The server label may carry `:port` / `/path` (localhost:3082, alpha/dsh); a workspace name wants plain dashes.
    const serverPart = probe.label.replace(/[:/]+/gu, '-').replace(/^-+|-+$/gu, '')
    return workspaceName === '' ? '' : `${serverPart}-${workspaceName}`
  }, [probe, pick, path])
  useEffect(() => { if (!nameTouched) setName(suggestedName) }, [suggestedName, nameTouched])

  const runProbe = useCallback(async () => {
    setProbing(true); setError(null)
    try {
      const result = await api.probeServer(url.trim(), token.trim() === '' ? undefined : token.trim())
      setProbe(result)
      setPick(result.workspaces.find(workspace => !workspace.mirrored)?.workspaceId ?? 'new')
      setStep('workspace')
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure)
      setError(message)
      if (/unauthorized|401|accept this host/i.test(message)) setShowToken(true)
    } finally { setProbing(false) }
  }, [api, url, token])

  const done = useCallback(async () => {
    if (probe === null) return
    setAdding(true); setError(null)
    try {
      const workspace = await model.addWorkspace({
        url: probe.url,
        ...(token.trim() === '' ? {} : { token: token.trim() }),
        label: probe.label,
        ...(pick === 'new' ? { remotePath: path.trim() } : { remoteWorkspaceId: pick }),
        title: name.trim(),
      })
      model.setAddOpen(false)
      const first = workspace.cache.sessions[0]
      if (first !== undefined) openRemoteSession({ workspaceId: workspace.id, sessionId: first.id })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally { setAdding(false) }
  }, [probe, token, pick, path, name, model, openRemoteSession])

  const canProbe = url.trim() !== '' && !probing
  const pickMirrored = probe?.workspaces.find(workspace => workspace.workspaceId === pick)?.mirrored === true
  const canDone = probe !== null && !adding && !pickMirrored && name.trim() !== '' && (pick !== 'new' || path.trim().startsWith('/'))

  return (
    <Modal
      open={open}
      onClose={() => { model.setAddOpen(false) }}
      closeLabel="Close"
      title="Add remote workspace"
      footer={step === 'server'
        ? (
          <>
            <Button variant="outline" onClick={() => { model.setAddOpen(false) }}>Cancel</Button>
            <Button variant="primary" disabled={!canProbe} onClick={() => { void runProbe() }}>{probing ? 'Connecting…' : 'Connect'}</Button>
          </>
        )
        : (
          <>
            <Button variant="outline" disabled={adding} onClick={() => { setStep('server'); setError(null) }}>Back</Button>
            <Button variant="primary" disabled={!canDone} onClick={() => { void done() }}>{adding ? 'Adding…' : 'Done'}</Button>
          </>
        )}
    >
      {step === 'server' && (
        <div>
          <div style={S.field}>
            <span style={S.label}>Remote DSH server</span>
            <Input value={url} placeholder="https://robotics-vm.tailbce956.ts.net/dsh/" spellCheck={false} autoCapitalize="off" autoFocus
              onChange={(event) => { setUrl(event.currentTarget.value); setError(null) }}
              onKeyDown={(event) => { if (event.key === 'Enter' && canProbe) void runProbe() }} />
            <span style={S.caption}>The URL its Tailscale remote publishes (keep the trailing slash). Your tailnet login is used to sign in; a token is only needed when it is not on that server&apos;s allowed list.</span>
          </div>
          {showToken
            ? (
              <div style={S.field}>
                <span style={S.label}>Access token (optional)</span>
                <Input value={token} placeholder="token from the remote's QR link" spellCheck={false} autoCapitalize="off"
                  onChange={(event) => { setToken(event.currentTarget.value); setError(null) }}
                  onKeyDown={(event) => { if (event.key === 'Enter' && canProbe) void runProbe() }} />
              </div>
            )
            : <button type="button" style={{ ...S.caption, background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }} onClick={() => { setShowToken(true) }}>Use an access token…</button>}
          {error !== null && <div style={{ ...S.error, padding: '10px 0 0' }}>{error}</div>}
        </div>
      )}
      {step === 'workspace' && probe !== null && (
        <div>
          <div style={{ ...S.caption, marginBottom: 12 }}>
            Connected to <b>{probe.hostname}</b> in {probe.elapsedMs} ms ({probe.mode === 'identity' ? 'tailnet identity' : 'token'}) · {probe.workspaces.length} workspace{probe.workspaces.length === 1 ? '' : 's'}
          </div>
          <div style={S.field}>
            <span style={S.label}>Workspace on the remote</span>
            <div style={S.list} role="radiogroup">
              {probe.workspaces.map(workspace => (
                <div key={workspace.workspaceId} role="radio" aria-checked={pick === workspace.workspaceId} aria-disabled={workspace.mirrored || undefined}
                  title={workspace.mirrored ? 'Already in this sidebar' : workspace.path}
                  style={{
                    ...S.option,
                    background: pick === workspace.workspaceId ? HOVER : 'transparent',
                    ...(workspace.mirrored ? { opacity: 0.45, cursor: 'default' } : {}),
                  }}
                  onClick={() => { if (!workspace.mirrored) setPick(workspace.workspaceId) }}>
                  <RemoteFolderIcon open={false} />
                  <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{workspace.title}</span>
                  {workspace.mirrored
                    ? <span style={{ ...S.muted, fontSize: 11 }}>added</span>
                    : (
                      <>
                        <span style={{ ...S.muted, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '45%' }} title={workspace.path}>{workspace.path}</span>
                        <span style={{ ...S.muted, fontSize: 11 }}>{workspace.sessionCount}</span>
                      </>
                    )}
                </div>
              ))}
              <div role="radio" aria-checked={pick === 'new'} style={{ ...S.option, background: pick === 'new' ? HOVER : 'transparent' }} onClick={() => { setPick('new') }}>
                <IconPlusOutline16 size={16} />
                <span>New workspace from a directory on the remote…</span>
              </div>
            </div>
          </div>
          {pick === 'new' && (
            <div style={S.field}>
              <span style={S.label}>Absolute directory on {probe.hostname}</span>
              <Input value={path} placeholder="/home/tali/projects/thing" spellCheck={false} autoCapitalize="off" autoFocus
                onChange={(event) => { setPath(event.currentTarget.value); setError(null) }} />
              <span style={S.caption}>Must already exist there; it becomes an ordinary workspace on the remote.</span>
            </div>
          )}
          <div style={S.field}>
            <span style={S.label}>Name in this sidebar</span>
            <Input value={name} onChange={(event) => { setName(event.currentTarget.value); setNameTouched(true) }}
              onKeyDown={(event) => { if (event.key === 'Enter' && canDone) void done() }} />
          </div>
          {error !== null && <div style={{ ...S.error, padding: 0 }}>{error}</div>}
        </div>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// main panel host + frame pool

/** Module-level observable of the panel host element (set while our main panel is mounted). */
const hostListeners = new Set<() => void>()
let hostElement: HTMLElement | null = null
function setHost(element: HTMLElement | null): void {
  hostElement = element
  for (const listener of hostListeners) listener()
}

export function RemoteSessionPanel({ useView, useRuntime }: PropsRuntime<'main'> & Face) {
  const ref = useRef<HTMLDivElement | null>(null)
  const selected = useView(state => state.selected)
  const workspace = useRuntime(state => state.snapshot?.workspaces.find(candidate => candidate.id === selected?.workspaceId))
  useLayoutEffect(() => {
    setHost(ref.current)
    return () => { setHost(null) }
  }, [])
  const session = workspace?.cache.sessions.find(candidate => candidate.id === selected?.sessionId)
  return (
    // The center column is a flex column that is not positioned: fill it as a
    // flex child (an absolute inset box would size against the whole frame).
    <div ref={ref} data-remote-session-host style={{ flex: '1 1 auto', minHeight: 0, width: '100%', display: 'grid', placeItems: 'center', color: 'var(--dsw-alias-label-tertiary)', fontSize: 13 }}>
      {selected === undefined ? 'Select a remote session.' : `Loading ${session?.title || 'remote session'} from ${workspace?.server?.label ?? 'remote'}…`}
    </div>
  )
}

export function FramePool({ useRuntime, useView, usePanelInfo, model }: PropsRuntime<'shell.overlay'> & Face) {
  const frames = useRuntime(state => state.frames)
  const selected = useView(state => state.selected)
  const active = usePanelInfo(info => info.activePanelId === PANEL_ID)
  const container = useRef<HTMLDivElement | null>(null)
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null)

  // Follow the panel host's box while our panel is active.
  useEffect(() => {
    let frame: number | null = null
    let observer: ResizeObserver | null = null
    const measure = (): void => {
      const host = hostElement
      const layer = container.current?.parentElement
      if (host === null || layer === null || layer === undefined) { setRect(null); return }
      const box = host.getBoundingClientRect()
      const origin = layer.getBoundingClientRect()
      setRect({ left: box.left - origin.left, top: box.top - origin.top, width: box.width, height: box.height })
    }
    const schedule = (): void => {
      frame ??= requestAnimationFrame(() => { frame = null; measure() })
    }
    const attach = (): void => {
      observer?.disconnect()
      observer = null
      if (hostElement !== null && typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(schedule)
        observer.observe(hostElement)
      }
      schedule()
    }
    hostListeners.add(attach)
    window.addEventListener('resize', schedule)
    attach()
    return () => {
      hostListeners.delete(attach)
      window.removeEventListener('resize', schedule)
      observer?.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [])

  // Hidden/shown bookkeeping follows panel activity transitions (not the
  // initial mount, which happens before the boot-time panel restore); the
  // sweep destroys stale frames.
  const previousActive = useRef<boolean | null>(null)
  useEffect(() => {
    const previous = previousActive.current
    previousActive.current = active
    if (previous === null && !active) return
    if (active) model.showSelected()
    else model.hideAll()
  }, [active, model])
  useEffect(() => {
    const timer = setInterval(() => { model.sweep() }, 30_000)
    return () => { clearInterval(timer) }
  }, [model])

  const visibleKey = active && selected !== undefined ? `${selected.workspaceId}:${selected.sessionId}` : undefined
  const shown = visibleKey !== undefined && rect !== null
  return (
    <div ref={container} data-remote-frames style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {frames.map(frame => {
        const visible = shown && frame.key === visibleKey
        return (
          <iframe
            key={frame.key}
            src={frame.src}
            title={`Remote session ${frame.sessionId}`}
            data-remote-frame={frame.key}
            style={visible && rect !== null
              ? { position: 'absolute', left: rect.left, top: rect.top, width: rect.width, height: rect.height, border: 'none', background: 'var(--dsw-alias-bg-base)', pointerEvents: 'auto' }
              : { position: 'absolute', left: 0, top: 0, width: 1, height: 1, border: 'none', opacity: 0, pointerEvents: 'none', visibility: 'hidden' }}
          />
        )
      })}
    </div>
  )
}


// ---- Move dialog -------------------------------------------------------------

type MoveDestination =
  | { kind: 'local'; workspaceId: string; title: string; path: string }
  | { kind: 'remote'; workspace: RemoteWorkspace }

function destinationKey(destination: MoveDestination): string {
  return destination.kind === 'local' ? `local:${destination.workspaceId}` : `remote:${destination.workspace.id}`
}

/**
 * "Move to…" for a remote session (destinations: other workspaces of the same
 * remote, other remotes, local workspaces) or for a local session heading to
 * a remote (destinations: remotes only — local→local is the shell's own
 * dialog). Same-remote moves use the remote's `session.move`; everything else
 * is a cross-host transfer (export → import → archive the source copy). A
 * `session/move-live` refusal reveals the stop-and-move option.
 */
export function MoveRemoteDialog({ model, localWorkspaces, useRuntime }: Face) {
  const request = useRuntime(state => state.moveRequest)
  const snapshot = useRuntime(state => state.snapshot)
  const [choice, setChoice] = useState<string | undefined>(undefined)
  const [stopLive, setStopLive] = useState(false)
  const [liveRefused, setLiveRefused] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  useEffect(() => {
    setChoice(request?.destinationId)
    setStopLive(false)
    setLiveRefused(false)
    setPending(false)
    setError(null)
    setSummary(null)
  }, [request])

  const destinations = useMemo((): MoveDestination[] => {
    if (request === undefined) return []
    const remotes: MoveDestination[] = (snapshot?.workspaces ?? [])
      .filter(workspace => request.source.local === true || workspace.id !== request.source.workspaceId)
      .map(workspace => ({ kind: 'remote', workspace }))
    if (request.source.local === true) return remotes
    const locals: MoveDestination[] = localWorkspaces().map(view => ({ kind: 'local', workspaceId: view.workspaceId, title: view.title, path: view.path }))
    return [...remotes, ...locals]
  }, [localWorkspaces, request, snapshot])
  const chosen = destinations.find(candidate => destinationKey(candidate) === choice)
  const sourceWorkspace = request === undefined || request.source.local === true ? undefined : model.workspace(request.source.workspaceId)
  const crossHost = chosen !== undefined && (chosen.kind === 'local' || sourceWorkspace === undefined || chosen.workspace.serverId !== sourceWorkspace.serverId)
  const blocked = pending || chosen === undefined || summary !== null || (liveRefused && !stopLive)

  const confirm = async (): Promise<void> => {
    if (request === undefined || chosen === undefined || blocked) return
    setPending(true)
    setError(null)
    try {
      if (!crossHost && chosen.kind === 'remote' && request.source.local !== true) {
        await model.moveSession({ fromWorkspaceId: request.source.workspaceId, sessionId: request.sessionId, toWorkspaceId: chosen.workspace.id, stopLive })
        setSummary(`Moved to ${chosen.workspace.title}.`)
      } else {
        const result = await model.transferSession({
          sessionId: request.sessionId,
          source: request.source.local === true ? { local: true } : { workspaceId: request.source.workspaceId },
          destination: chosen.kind === 'local' ? { local: true, workspaceId: chosen.workspaceId } : { workspaceId: chosen.workspace.id },
          stopLive,
        })
        const where = chosen.kind === 'local' ? `${chosen.title} (this machine)` : `${chosen.workspace.title} on ${chosen.workspace.server?.label ?? chosen.workspace.serverId}`
        const renamed = result.sessionId === request.sessionId ? '' : ` It has a new id there (${result.sessionId.slice(0, 16)}…).`
        setSummary(`Copied to ${where} (${String(Math.round(result.bytes / 1024))} KB); the original is archived here.${renamed}`)
      }
    } catch (failure) {
      const code = (failure as { code?: string }).code
      if (code === 'session/move-live') setLiveRefused(true)
      else setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setPending(false)
    }
  }

  const menuItems: MenuEntry[] = []
  let lastGroup: string | undefined
  for (const destination of destinations) {
    const group = destination.kind === 'local' ? 'This machine' : (destination.workspace.server?.label ?? destination.workspace.serverId)
    if (group !== lastGroup) {
      if (lastGroup !== undefined) menuItems.push({ type: 'separator', id: `sep:${group}` })
      lastGroup = group
    }
    menuItems.push({
      id: destinationKey(destination),
      label: destination.kind === 'local' ? `${destination.title} · ${group}` : `${destination.workspace.title} · ${group}`,
      icon: destination.kind === 'local' ? <IconFolderClose16 /> : <IconGlobeOutline14 />,
    })
  }
  const chosenLabel = chosen === undefined
    ? 'Choose a workspace…'
    : chosen.kind === 'local' ? `${chosen.title} · this machine` : `${chosen.workspace.title} · ${chosen.workspace.server?.label ?? chosen.workspace.serverId}`

  return (
    <Modal
      open={request !== undefined}
      onClose={() => { model.openMove(undefined) }}
      closeLabel="Close"
      title={request?.source.local === true ? 'Move session to a remote' : 'Move remote session'}
      footer={(
        <>
          <Button variant="outline" disabled={pending} onClick={() => { model.openMove(undefined) }}>{summary === null ? 'Cancel' : 'Close'}</Button>
          {summary === null && (
            <Button variant="primary" disabled={blocked} onClick={() => { void confirm() }}>{pending ? 'Moving…' : 'Move'}</Button>
          )}
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 }}>
        <div style={{ color: 'var(--dsw-alias-label-secondary)' }}>{request?.title}</div>
        <div style={S.field}>
          <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>Destination workspace</span>
          <Menu
            open={menuOpen}
            onClose={() => { setMenuOpen(false) }}
            items={menuItems.length === 0 ? [{ id: 'none', label: 'No destinations available', disabled: true }] : menuItems}
            onSelect={(id) => { setMenuOpen(false); if (id !== 'none') setChoice(id) }}
            portal
            anchor={(
              <button
                type="button"
                disabled={pending || summary !== null}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => { setMenuOpen(value => !value) }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, height: 40, padding: '0 14px', borderRadius: 20,
                  border: '0.5px solid var(--dsw-alias-border-l4)', background: 'transparent',
                  color: 'var(--dsw-alias-label-primary)', fontSize: 14, textAlign: 'left', cursor: 'pointer', width: '100%',
                }}
              >
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{chosenLabel}</span>
                <span style={{ display: 'inline-flex', transform: 'rotate(90deg)' }}><IconTriangleRightFill14 /></span>
              </button>
            )}
          />
        </div>
        {crossHost && chosen !== undefined && summary === null && (
          <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', lineHeight: '17px' }}>
            Different machine: the session log and its attachments are copied over and the original is archived here.
            Files the agent worked on are not copied.
          </div>
        )}
        {liveRefused && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
            <input type="checkbox" checked={stopLive} disabled={pending} onChange={(event) => { setStopLive(event.currentTarget.checked) }} style={{ marginTop: 2 }} />
            <span>
              Interrupt the current turn and move it
              <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>The agent is mid-turn; moving aborts that turn (everything finished so far is in the log) and it picks up at the destination.</div>
            </span>
          </label>
        )}
        {summary !== null && <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }} role="status">{summary}</div>}
        {error !== null && <div style={{ ...S.error, padding: 0 }} role="alert">{error}</div>}
      </div>
    </Modal>
  )
}


// ---- server view + flat view ----------------------------------------------

function ServerGroup({ group, server, drag, groupOrder, now, ...face }: {
  group: { serverId: string; label: string; workspaces: RemoteWorkspace[] }
  server: ServerInfo | undefined
  drag: DragState
  groupOrder: readonly string[]
  now: number
} & Face) {
  const { model, useView } = face
  const expanded = useView(state => state.serverExpanded?.[group.serverId] !== false)
  const [hover, setHover] = useState(false)
  const failure = server?.bridge?.lastFailure
  const header = (
    <div
      role="treeitem"
      aria-expanded={expanded}
      style={{ ...S.groupRow, ...NO_SELECT, background: hover ? HOVER : 'transparent' }}
      onMouseEnter={() => { setHover(true) }}
      onMouseLeave={() => { setHover(false) }}
      onClick={() => { model.setServerExpanded(group.serverId, !expanded) }}
    >
      <span style={{ ...S.slot, color: failure === undefined ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-state-warning-primary, var(--dsw-alias-label-caption))' }}>
        {hover
          ? <span style={{ display: 'inline-flex', transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 150ms var(--ds-ease-in-out)', color: 'var(--dsw-alias-label-caption)' }}><IconTriangleRightFill14 /></span>
          : <IconGlobeOutline14 />}
      </span>
      <span style={S.groupTitle}>{group.label}</span>
      <span style={{ ...S.muted, fontSize: 11, flex: 'none' }}>{String(group.workspaces.length)} ws</span>
    </div>
  )
  return (
    <div style={S.group}>
      <ServerHover anchor={header} server={server} workspaces={group.workspaces} now={now} disabled={drag.item !== null} />
      {expanded && (
        <div role="group" style={{ paddingLeft: 12 }}>
          {group.workspaces.map(workspace => <Group key={workspace.id} workspace={workspace} drag={drag} groupOrder={groupOrder} now={now} hideServerInHover {...face} />)}
        </div>
      )}
    </div>
  )
}

function FlatList({ workspaces, drag, now, ...face }: { workspaces: readonly RemoteWorkspace[]; drag: DragState; now: number } & Face) {
  const { model, openRemoteSession, useView, useRuntime } = face
  const orderBy = useView(state => state.orderBy ?? 'manual')
  const selected = useView(state => state.selected)
  const polling = useRuntime(state => state.polling)
  const rows = useMemo(() => flatten(workspaces, orderBy), [workspaces, orderBy])
  if (rows.length === 0) {
    return <div style={{ ...S.hint, padding: '2px 8px' }}>{polling.length > 0 ? 'Reaching remotes…' : 'No remote sessions.'}</div>
  }
  return (
    <div role="group">
      {rows.map(({ session, workspace }) => (
        <SessionRow
          key={`${workspace.id}:${session.id}`}
          workspace={workspace}
          session={session}
          busy={polling.includes(workspace.id)}
          selected={selected?.workspaceId === workspace.id && selected.sessionId === session.id}
          openRemoteSession={openRemoteSession}
          model={model}
          drag={drag}
          order={[]}
          caption={`${workspace.title} · ${workspace.server?.label ?? workspace.serverId}`}
          now={now}
          reorderable={false}
        />
      ))}
    </div>
  )
}

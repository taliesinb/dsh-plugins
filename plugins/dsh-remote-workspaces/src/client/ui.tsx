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
  Button, IconChevronDownOutline14, IconChevronUpOutline14, IconEllipsisOutline16, IconFolderClose16, IconFolderOpen16, IconGlobeOutline14,
  IconLoadingOutline16, IconPlusOutline16, IconProjectAddOutline16, IconRefreshOutline16, IconTriangleRightFill14, Input, Menu, Modal, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import { DIALOG_DEFAULT, useDialogDefaultAction } from './dialog-keys.ts'
import { RemoteApiError } from './api.ts'
import type { PathInfo, ProbeResult, RemoteApi, RemoteWorkspace, ServerInfo } from './api.ts'
import { FLAT_POLL_INTERVAL_MS, frameKey, PANEL_ID, type RemoteSelection, type RemoteWorkspacesModel, type RuntimeState, type ViewState } from './store.ts'
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
  // Mirrors WorkspaceBrowser.module.css .sectionHeader (36px, tertiary label) —
  // the "Workspaces" header this section sits under. No font-size: like the
  // shell's header it inherits the sidebar's 14px (rows are 13px).
  sectionHeader: {
    flex: 'none', display: 'flex', alignItems: 'center', gap: 4, height: 36, paddingLeft: 4, marginBottom: 4,
    boxSizing: 'border-box', color: 'var(--dsw-alias-label-tertiary)',
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
  // .sessionRow: 32px, pad 0 8, a 16px status slot, then a 4px title gap (no
  // extra indent under a group — the local tree's `--dsh-workspace-indent` is
  // 0 for a top-level Workspace too). The 8px leading padding is also where
  // numbered-switching draws its slot number.
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

/**
 * 28px header button. `label` is the accessible name; it is also the hover
 * tooltip unless `tooltip` is false. `clearHoverOnClick` is for a button whose
 * click relayouts it away from the pointer (the fold toggle: the header jumps
 * up or down by the list's height) — no mouseleave fires for an element that
 * moves out from under a still pointer, so the highlight would stick.
 */
function IconButton({ label, onClick, children, disabled, tooltip = true, clearHoverOnClick = false }: {
  label: string; onClick: (event: React.MouseEvent) => void; children: ReactNode; disabled?: boolean; tooltip?: boolean; clearHoverOnClick?: boolean
}) {
  const [hover, setHover] = useState(false)
  const button = (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      style={{ ...S.iconButton, background: hover && !disabled ? HOVER : 'transparent', opacity: disabled ? 0.5 : 1 }}
      onMouseEnter={() => { setHover(true) }}
      onMouseMove={() => { if (!hover) setHover(true) }}
      onMouseLeave={() => { setHover(false) }}
      onClick={(event) => { event.stopPropagation(); if (clearHoverOnClick) setHover(false); onClick(event) }}
    >
      {children}
    </button>
  )
  return tooltip ? <Tooltip label={label} delayMs={500}>{button}</Tooltip> : button
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

/**
 * Folder icon of a remote workspace row — the plain folder, like the local
 * tree's (the "Remotes" section header already says where these live; the
 * globe badge it used to carry went on 2026-09-24).
 */
function RemoteFolderIcon({ open, active }: { open: boolean; active?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', width: 16, height: 16, alignItems: 'center', justifyContent: 'center', color: active ? 'var(--dsw-alias-state-business-primary)' : undefined }}>
      {open ? <IconFolderOpen16 size={16} /> : <IconFolderClose16 size={16} />}
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
// slug preview for a framed blank session

/**
 * The `slug: prompt` naming convention is a local browser plugin
 * (session-title-slug). Its live preview relabels the local New Session row
 * while the draft starts with a slug; for a framed remote session the typing
 * happens in the remote's own document, so the local plugin never sees it.
 * The frame is same-origin, though, so this hook reads the framed composer's
 * text directly and parses it with the convention the local plugin publishes
 * (`globalThis.__DSH_SESSION_TITLE_SLUG__`). No plugin locally → no preview,
 * matching what local rows do. The remote names the session itself on send.
 */
function useFramedSlugPreview(frameKeyOf: string | undefined): string | undefined {
  const [slug, setSlug] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (frameKeyOf === undefined) { setSlug(undefined); return }
    const convention = (globalThis as { __DSH_SESSION_TITLE_SLUG__?: { parseSlug: (text: string) => string | undefined } }).__DSH_SESSION_TITLE_SLUG__
    if (convention === undefined) { setSlug(undefined); return }
    let last: string | undefined
    const read = (): void => {
      const frame = document.querySelector<HTMLIFrameElement>(`iframe[data-remote-frame="${frameKeyOf.replace(/"/gu, '\\"')}"]`)
      let text = ''
      try {
        text = frame?.contentDocument?.querySelector<HTMLElement>('[role="textbox"]')?.innerText ?? ''
      } catch {
        text = '' // cross-origin would throw; ours is same-origin, but stay safe
      }
      const next = convention.parseSlug(text)
      if (next !== last) { last = next; setSlug(next) }
    }
    read()
    const timer = setInterval(read, 300)
    return () => { clearInterval(timer) }
  }, [frameKeyOf])
  return slug
}

// ---------------------------------------------------------------------------
// ghost rows for framed blank sessions with a draft

/** Mirror of ui-conversation's CONVERSATION_STORE_KEY; the framed page namespaces it per embedded session (page-mode.ts). */
const CONVERSATION_STORE_KEY = 'dsh.conversation'

/** The persisted composer draft of a framed remote session, read from this origin's localStorage. */
function framedDraftOf(sessionId: string): string {
  try {
    const raw = localStorage.getItem(`embed:${sessionId}:${CONVERSATION_STORE_KEY}.${sessionId}`)
    if (raw === null) return ''
    const parsed: unknown = JSON.parse(raw)
    const draft = typeof parsed === 'object' && parsed !== null ? (parsed as { draft?: unknown }).draft : undefined
    return typeof draft === 'string' ? draft : ''
  } catch {
    return ''
  }
}

/**
 * Blank remote sessions of one workspace that hold a non-empty persisted
 * draft and are not the current selection: each gets a dimmed row so the
 * typed-into New Session stays reachable after switching away (the
 * session-title-slug plugin does the same for local blank sessions). Drafts
 * live in localStorage, which fires no event for same-document writes, so
 * this polls at a modest cadence while the group is expanded.
 */
function useDraftGhosts(workspace: RemoteWorkspace, selected: RemoteSelection | undefined, expanded: boolean): { id: string; label: string }[] {
  const [ghosts, setGhosts] = useState<{ id: string; label: string }[]>([])
  const blankIds = workspace.cache.blankIds
  useEffect(() => {
    if (!expanded || blankIds === undefined || blankIds.length === 0) { setGhosts([]); return }
    const convention = (globalThis as { __DSH_SESSION_TITLE_SLUG__?: { parseSlug: (text: string) => string | undefined } }).__DSH_SESSION_TITLE_SLUG__
    let last = ''
    const read = (): void => {
      const next: { id: string; label: string }[] = []
      for (const id of blankIds) {
        if (selected?.workspaceId === workspace.id && selected.sessionId === id) continue
        const draft = framedDraftOf(id)
        if (draft.trim() === '') continue
        next.push({ id, label: convention?.parseSlug(draft) ?? 'New session' })
      }
      const key = JSON.stringify(next)
      if (key !== last) { last = key; setGhosts(next) }
    }
    read()
    const timer = setInterval(read, 1000)
    return () => { clearInterval(timer) }
  }, [blankIds, expanded, selected, workspace.id])
  return ghosts
}

// ---------------------------------------------------------------------------
// groups

function shortId(id: string): string {
  return id.replace(/^session-/, '').slice(0, 8)
}

function SessionRow({ workspace, session, selected, busy, openRemoteSession, model, drag, order, caption, now, reorderable = true }: {
  workspace: RemoteWorkspace
  session: RemoteWorkspace['cache']['sessions'][number] & { placeholder?: boolean; ghost?: string }
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
    ...(session.placeholder === true ? [] : [{ id: 'move', label: 'Move to…' }, { id: 'copy', label: 'Copy to…' }]),
    { id: 'archive', label: 'Archive', danger: true },
  ]
  const onSelect = async (id: string): Promise<void> => {
    setMenuOpen(false)
    if (id === 'rename') { setRename(session.title); setRenameError(null); return }
    if (id === 'move') { model.openMove({ sessionId: session.id, title: session.title, source: { workspaceId: workspace.id } }); return }
    if (id === 'copy') { model.openMove({ mode: 'copy', sessionId: session.id, title: session.title, source: { workspaceId: workspace.id } }); return }
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
  const previewSlug = useFramedSlugPreview(session.placeholder === true && session.ghost === undefined ? frameKey({ workspaceId: workspace.id, sessionId: session.id }) : undefined)
  const row = (
      <div
        role="treeitem"
        aria-selected={selected}
        data-remote-session={frameKey({ workspaceId: workspace.id, sessionId: session.id })}
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
            {session.title || (session.ghost !== undefined
              ? <span style={{ opacity: 0.5 }}>{session.ghost}</span>
              : session.placeholder === true && previewSlug !== undefined
                ? previewSlug
                : <span style={S.muted}>{'placeholder' in session && session.placeholder === true ? 'New session' : `Untitled · ${shortId(session.id)}`}</span>)}
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
  // `selected` survives a switch to a local session (the frame is kept warm
  // for a quick return); the row highlight follows what is on screen.
  const selected = useView(state => (state.remoteActive === true ? state.selected : undefined))
  const polling = useRuntime(state => state.polling.includes(workspace.id))
  const starting = useRuntime(state => state.starting.includes(workspace.id))
  const error = useRuntime(state => state.errors[workspace.id])
  const [hover, setHover] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [rename, setRename] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [pending, setPending] = useState(false)
  // Enter = Rename / Remove (the primary button of the open dialog); Escape = close (Modal's own).
  useDialogDefaultAction(rename !== null || confirmRemove, confirmRemove)
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
  const ghosts = useDraftGhosts(workspace, selected, expanded)
  const sessions = useMemo(() => {
    const cached = orderSessions(workspace.cache.sessions, orderBy)
    const head: (RemoteWorkspace['cache']['sessions'][number] & { placeholder?: boolean; ghost?: string })[] = []
    if (selected?.workspaceId === workspace.id && !cached.some(session => session.id === selected.sessionId)) {
      head.push({ id: selected.sessionId, title: '', placeholder: true })
    }
    for (const ghost of ghosts) head.push({ id: ghost.id, title: '', placeholder: true, ghost: ghost.label })
    return [...head, ...cached]
  }, [workspace.cache.sessions, workspace.id, selected, orderBy, ghosts])
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
        {/* Leading slot: the folder, swapped for the expand chevron on hover (local-tree pattern). */}
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
            <Button variant="primary" {...DIALOG_DEFAULT} disabled={pending || (rename ?? '').trim() === ''} onClick={() => {
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
            <Button variant="primary" {...DIALOG_DEFAULT} disabled={pending} onClick={() => {
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

/** Number of mirrored workspaces from which the section offers its fold chevron. */
const COLLAPSIBLE_FROM = 1

/**
 * The "Remotes" section: anchored at the bottom of the list area (the local
 * tree above it flexes), growing upward to at most half the area, with its own
 * scroll. Three shapes:
 *   - no remotes: just the label and the add button, an empty body (no hint,
 *     no refresh / view options — there is nothing for them to act on);
 *   - with entries: label, then a fold chevron (v — the section grows upward),
 *     refresh-all, view options, add; the label toggles too;
 *   - folded: label, chevron (^), add; the list is not rendered.
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
  const collapsedPref = useView(state => state.collapsed === true)
  const count = workspaces?.length ?? 0
  const collapsible = count >= COLLAPSIBLE_FROM
  const collapsed = collapsible && collapsedPref
  const empty = count === 0
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
    if (groupBy === 'workspace' || collapsed || (workspaces?.length ?? 0) === 0) return
    model.pollAll()
    const timer = setInterval(() => { model.pollAll() }, FLAT_POLL_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [collapsed, groupBy, model, workspaces?.length])

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
      {/* Open section: a hairline separates it from the local list scrolling away above it
          (same token as the shell's sidebar/centre seam). It sits in the content box, so it
          stops at the scrollbar gutter — the same 12px inset the sidebar leaves on the left.
          Folded or empty, the bare header needs none. */}
      {!empty && !collapsed && <div style={{ flex: 'none', height: 0, borderTop: '0.5px solid var(--dsw-alias-border-l3)', marginBottom: 2 }} />}
      <div style={{ ...S.sectionHeader, ...NO_SELECT }}>
        <span
          style={{ ...S.sectionLabel, cursor: collapsible ? 'pointer' : 'default' }}
          onClick={collapsible ? () => { model.setCollapsed(!collapsed) } : undefined}
        >
          Remotes
        </span>
        <span style={{ flex: '1 1 auto' }} />
        {collapsible && (
          <IconButton label={collapsed ? 'Show remotes' : 'Hide remotes'} tooltip={false} clearHoverOnClick onClick={() => { model.setCollapsed(!collapsed) }}>
            {/* The section sits at the bottom and grows upward: ^ opens it, v folds it down. */}
            {collapsed ? <IconChevronUpOutline14 size={14} /> : <IconChevronDownOutline14 size={14} />}
          </IconButton>
        )}
        {!empty && !collapsed && (
          <IconButton label="Refresh all remotes" disabled={anyPolling} onClick={() => { model.pollAll() }}>
            {anyPolling ? <Spinner /> : <IconRefreshOutline16 size={16} />}
          </IconButton>
        )}
        {!empty && !collapsed && (
          <ViewOptions groupBy={groupBy} orderBy={orderBy} onGroupBy={mode => { model.setGroupBy(mode) }} onOrderBy={mode => { model.setOrderBy(mode) }} iconButtonStyle={S.iconButton} />
        )}
        <IconButton label="Add remote workspace" onClick={() => { model.setAddOpen(true) }}>
          <IconProjectAddOutline16 size={16} />
        </IconButton>
      </div>
      {!collapsed && (
        <div style={{ minHeight: 0, overflowY: 'auto', paddingBottom: empty ? 0 : 8 }} onDragOver={(event) => { if (item !== null) event.preventDefault() }}>
          {loadError !== undefined && <div style={{ ...S.error, padding: '2px 8px' }}>Remote workspaces: {loadError}</div>}
          {groupBy === 'workspace' && ordered.map(workspace => <Group key={workspace.id} workspace={workspace} drag={drag} groupOrder={groupOrder} now={now} {...props} />)}
          {groupBy === 'server' && byServer(ordered).map(group => (
            <ServerGroup key={group.serverId} group={group} server={servers?.find(server => server.id === group.serverId)} drag={drag} groupOrder={groupOrder} now={now} {...props} />
          ))}
          {groupBy === 'flat' && <FlatList workspaces={ordered} drag={drag} now={now} {...props} />}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// add-remote modal (mounted in shell.overlay so it exists regardless of the sidebar's state)

type Step = 'server' | 'workspace'

/** Result of asking the remote about the typed path, tagged with the text it answers for (stale answers never enable Done). */
interface Inspected { path: string; info: PathInfo }
type PathState = 'checking' | 'ready' | 'unavailable' | 'error'
const INSPECT_DEBOUNCE_MS = 120
const MAX_SUGGESTION_ROWS = 8

/** Longest common prefix of the candidate names (shell Tab on an ambiguous prefix). */
function commonPrefix(names: string[]): string {
  if (names.length === 0) return ''
  let prefix = names[0] ?? ''
  for (const name of names) {
    let i = 0
    while (i < prefix.length && i < name.length && prefix[i]!.toLowerCase() === name[i]!.toLowerCase()) i++
    prefix = prefix.slice(0, i)
  }
  return prefix
}

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
  const [path, setPath] = useState('~/')
  const [inspected, setInspected] = useState<Inspected | null>(null)
  const [pathState, setPathState] = useState<PathState>('checking')
  const [pathError, setPathError] = useState<string | null>(null)
  const [highlight, setHighlight] = useState(-1)
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [adding, setAdding] = useState(false)
  const inspectSeq = useRef(0)

  useEffect(() => {
    if (!open) return
    setStep('server'); setProbe(null); setError(null); setPick('new'); setPath('~/'); setInspected(null); setPathState('checking'); setPathError(null); setHighlight(-1)
    setName(''); setNameTouched(false); setToken(''); setShowToken(false)
    setUrl(lastUrl ?? '')
  }, [open, lastUrl])

  // The answer for the current text, or null while it is still on its way.
  const current = inspected !== null && inspected.path === path ? inspected.info : null

  // Ask the remote about the typed path as it is typed (debounced; late
  // answers for older text are dropped). The remote's own plugin resolves
  // `~`, reports existence and lists completion candidates.
  useEffect(() => {
    if (!open || step !== 'workspace' || pick !== 'new' || probe === null || pathState === 'unavailable') return
    if (inspected !== null && inspected.path === path) return
    const seq = ++inspectSeq.current
    const timer = setTimeout(() => {
      api.inspectPath(probe.url, token.trim() === '' ? undefined : token.trim(), path).then((info) => {
        if (seq !== inspectSeq.current) return
        setInspected({ path, info }); setPathState('ready'); setPathError(null)
      }, (failure: unknown) => {
        if (seq !== inspectSeq.current) return
        // `unknown-endpoint` is this GUI's own host still running a plugin from before `servers.inspectPath` (restart pending).
        if (failure instanceof RemoteApiError && (failure.code === 'remote-workspaces/fs-unavailable' || failure.code === 'remote-workspaces/unknown-endpoint')) { setPathState('unavailable'); return }
        setPathState('error'); setPathError(failure instanceof Error ? failure.message : String(failure))
      })
    }, INSPECT_DEBOUNCE_MS)
    return () => { clearTimeout(timer) }
  }, [open, step, pick, probe, path, token, api, inspected, pathState])

  const suggestedName = useMemo(() => {
    if (probe === null) return ''
    // Same name as on the remote: the picked workspace's title, or the last
    // path segment of a new directory. The server is visible from the group
    // the row sits under, so it is not repeated in the name.
    if (pick !== 'new') return probe.workspaces.find(candidate => candidate.workspaceId === pick)?.title ?? ''
    const resolved = current?.resolved ?? path.trim()
    const existing = current === null ? undefined : probe.workspaces.find(candidate => candidate.path === current.resolved)
    if (existing !== undefined) return existing.title
    const tail = resolved.replace(/\/+$/, '').split('/').pop() ?? ''
    return tail === '~' ? '' : tail
  }, [probe, pick, path, current])
  useEffect(() => { if (!nameTouched) setName(suggestedName) }, [suggestedName, nameTouched])

  const runProbe = useCallback(async () => {
    setProbing(true); setError(null)
    try {
      const result = await api.probeServer(url.trim(), token.trim() === '' ? undefined : token.trim())
      setProbe(result)
      setPick(result.workspaces.find(workspace => !workspace.mirrored)?.workspaceId ?? 'new')
      // A different remote answers for its own filesystem: forget the last one's verdicts.
      setInspected(null); setPathState('checking'); setPathError(null); setHighlight(-1)
      setStep('workspace')
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure)
      setError(message)
      if (/unauthorized|401|accept this host/i.test(message)) setShowToken(true)
    } finally { setProbing(false) }
  }, [api, url, token])

  // --- the "New workspace" path: verdict, completion -------------------------

  /** Show a remote path the way the operator is typing (`~/…` while the field starts with `~`). */
  const display = useCallback((absolute: string): string => {
    const home = current?.home
    if (home !== undefined && path.startsWith('~') && (absolute === home || absolute.startsWith(`${home}/`))) return `~${absolute.slice(home.length)}`
    return absolute
  }, [current, path])
  const suggestions = current?.entries ?? []
  const accept = useCallback((entry: { name: string; path: string }) => {
    setPath(`${display(entry.path)}/`); setHighlight(-1)
  }, [display])
  /** Tab: one candidate (or a highlighted one) completes with a slash; several complete to their common prefix, shell style. */
  const completeTab = useCallback(() => {
    if (current === null || suggestions.length === 0) return
    if (highlight >= 0 || suggestions.length === 1) { accept(suggestions[Math.max(highlight, 0)]!); return }
    const typed = path.endsWith('/') ? '' : (path.split('/').pop() ?? '')
    const prefix = commonPrefix(suggestions.map(entry => entry.name))
    if (prefix.length > typed.length) {
      const dir = path.endsWith('/') ? path : path.slice(0, path.length - typed.length)
      setPath(`${dir}${prefix}`)
    } else {
      setHighlight(0)
    }
  }, [current, suggestions, highlight, path, accept])

  const existingWorkspace = current === null || probe === null ? undefined : probe.workspaces.find(candidate => candidate.path === current.resolved)
  const trivial = current !== null && (current.resolved === current.home || current.resolved === '/')
  /** The verdict line under the field: colour + text; `ok` gates Done. */
  const verdict = useMemo((): { text: string; tone: 'muted' | 'warn' | 'error'; ok: boolean } | null => {
    // Neither the remote's plugin nor DSH's directory picker there can be asked
    // (a DSH from before the browse picker, or this host's own plugin predating
    // `servers.inspectPath`): Done takes an absolute path on trust.
    if (pathState === 'unavailable') return { tone: 'warn', ok: path.trim().startsWith('/'), text: 'Caution: server is running an older version' }
    if (pathState === 'error') return { tone: 'error', ok: false, text: pathError ?? 'cannot check the path' }
    if (current === null) return path.trim() === '' ? { tone: 'muted', ok: false, text: 'Type a directory path' } : null
    if (trivial) return { tone: 'muted', ok: false, text: 'Choose a directory inside it (for example ~/projects/thing)' }
    if (existingWorkspace !== undefined) {
      return existingWorkspace.mirrored
        ? { tone: 'muted', ok: false, text: `Already in this sidebar as “${existingWorkspace.title}”` }
        : { tone: 'muted', ok: true, text: `Already a workspace on the remote (“${existingWorkspace.title}”) — it will be added as is` }
    }
    if (current.kind === 'directory') return { tone: 'muted', ok: true, text: 'Directory exists' }
    if (current.kind === 'file') return { tone: 'error', ok: false, text: 'Not a directory' }
    if (!current.creatable) return { tone: 'error', ok: false, text: `Cannot create it: ${current.blocker ?? 'an ancestor'} is a file` }
    return { tone: 'warn', ok: true, text: 'Directory will be created' }
  }, [pathState, pathError, current, path, trivial, existingWorkspace])

  const done = useCallback(async () => {
    if (probe === null) return
    setAdding(true); setError(null)
    try {
      const workspace = await model.addWorkspace({
        url: probe.url,
        ...(token.trim() === '' ? {} : { token: token.trim() }),
        label: probe.label,
        ...(pick === 'new'
          ? { remotePath: current?.resolved ?? path.trim(), create: current?.kind === 'missing' }
          : { remoteWorkspaceId: pick }),
        title: name.trim(),
      })
      model.setAddOpen(false)
      const first = workspace.cache.sessions[0]
      if (first !== undefined) openRemoteSession({ workspaceId: workspace.id, sessionId: first.id })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally { setAdding(false) }
  }, [probe, token, pick, path, current, name, model, openRemoteSession])

  const canProbe = url.trim() !== '' && !probing
  const pickMirrored = probe?.workspaces.find(workspace => workspace.workspaceId === pick)?.mirrored === true
  const canDone = probe !== null && !adding && !pickMirrored && name.trim() !== '' && (pick !== 'new' || verdict?.ok === true)

  const onPathKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Tab' && !event.shiftKey && suggestions.length > 0) { event.preventDefault(); completeTab(); return }
    if (event.key === 'ArrowDown' && suggestions.length > 0) { event.preventDefault(); setHighlight(index => Math.min(index + 1, Math.min(suggestions.length, MAX_SUGGESTION_ROWS) - 1)); return }
    if (event.key === 'ArrowUp' && suggestions.length > 0) { event.preventDefault(); setHighlight(index => Math.max(index - 1, -1)); return }
    if (event.key === 'Escape' && highlight >= 0) { event.preventDefault(); event.stopPropagation(); setHighlight(-1); return }
    if (event.key === 'Enter') {
      if (highlight >= 0 && suggestions[highlight] !== undefined) { event.preventDefault(); accept(suggestions[highlight]!); return }
      if (canDone) void done()
    }
  }

  const verdictColor = verdict?.tone === 'warn'
    ? 'var(--dsw-alias-state-warn-primary)'
    : verdict?.tone === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-tertiary)'

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
            <Input value={url} placeholder="user@host · host/dsh/user · https://host.example.ts.net/dsh/" spellCheck={false} autoCapitalize="off" autoFocus
              onChange={(event) => { setUrl(event.currentTarget.value); setError(null) }}
              onKeyDown={(event) => { if (event.key === 'Enter' && canProbe) void runProbe() }} />
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
            Connected to <b>{probe.hostname}</b> in {probe.elapsedMs} ms
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
                <span>New workspace</span>
              </div>
            </div>
          </div>
          {pick === 'new' && (
            <div style={S.field}>
              <span style={S.label}>New workspace on remote</span>
              <Input value={path} placeholder="~/projects/thing" spellCheck={false} autoCapitalize="off" autoComplete="off" autoFocus
                aria-autocomplete="list" aria-expanded={suggestions.length > 0}
                onChange={(event) => { setPath(event.currentTarget.value); setHighlight(-1); setError(null) }}
                onKeyDown={onPathKeyDown} />
              {suggestions.length > 0 && (
                <div role="listbox" style={{ ...S.list, maxHeight: 8 * 30 + 8, gap: 0 }}>
                  {suggestions.slice(0, MAX_SUGGESTION_ROWS).map((entry, index) => (
                    <div key={entry.path} role="option" aria-selected={index === highlight}
                      style={{ ...S.option, padding: '4px 8px', fontSize: 12, background: index === highlight ? HOVER : 'transparent' }}
                      onMouseDown={(event) => { event.preventDefault() }}
                      onClick={() => { accept(entry) }}
                      onMouseEnter={() => { setHighlight(index) }}>
                      <IconFolderClose16 size={14} />
                      <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}<span style={S.muted}>/</span></span>
                    </div>
                  ))}
                  {(suggestions.length > MAX_SUGGESTION_ROWS || current?.truncated === true) && (
                    <div style={{ ...S.muted, fontSize: 11, padding: '4px 8px' }}>
                      {suggestions.length > MAX_SUGGESTION_ROWS ? `+${suggestions.length - MAX_SUGGESTION_ROWS}${current?.truncated === true ? '+' : ''} more — keep typing` : 'more — keep typing'}
                    </div>
                  )}
                </div>
              )}
              <span style={{ ...S.caption, color: verdictColor, display: 'flex', alignItems: 'center', gap: 6, minHeight: 17 }}>
                {verdict === null ? <><Spinner size={12} /> Checking…</> : verdict.text}
                {verdict !== null && current !== null && !trivial && verdict.tone !== 'error' && (
                  <span style={{ ...S.muted, marginLeft: 'auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '55%' }} title={current.resolved}>{current.resolved}</span>
                )}
              </span>
            </div>
          )}
          <div style={S.field}>
            <span style={S.label}>Local workspace name</span>
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

/** A path for a menu's trailing detail: the account home (any host's) as `~`. */
function shortPath(path: string): string {
  return path.replace(/^(?:\/Users|\/home)\/[^/]+(?=\/|$)/u, '~')
}

function destinationKey(destination: MoveDestination): string {
  return destination.kind === 'local' ? `local:${destination.workspaceId}` : `remote:${destination.workspace.id}`
}

/**
 * "Move to…" / "Copy to…" for a remote session (destinations: other workspaces
 * of the same remote, other remotes, local workspaces) or for a local session
 * heading to a remote (destinations: remotes only — local→local is the shell's
 * own dialog). Same-remote moves use the remote's `session.move`; everything
 * else is a cross-host transfer (export → import → archive the source copy). A
 * `session/move-live` refusal reveals the stop-and-move option.
 *
 * A copy never disturbs the source: same-remote copies use the remote's
 * `session.copy`, cross-host ones export → import in copy mode (fresh ids, no
 * archiving). The source's own workspace is a valid copy destination. A
 * `session/copy-live` refusal reveals the truncate option (drop the turn in
 * progress, ticked by default) instead of stop-and-move.
 */
export function MoveRemoteDialog({ model, localWorkspaces, useRuntime }: Face) {
  const request = useRuntime(state => state.moveRequest)
  const snapshot = useRuntime(state => state.snapshot)
  const copying = request?.mode === 'copy'
  const [choice, setChoice] = useState<string | undefined>(undefined)
  const [stopLive, setStopLive] = useState(false)
  const [truncate, setTruncate] = useState(true)
  const [title, setTitle] = useState('')
  const [liveRefused, setLiveRefused] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  // Enter = Move / Copy (also from the title input); Escape = close (Modal's own).
  useDialogDefaultAction(request !== undefined)
  useEffect(() => {
    // A copy defaults to the session's own workspace ("duplicate"); a move has no default.
    setChoice(request?.destinationId ?? (request?.mode === 'copy' && request.source.local !== true ? `remote:${request.source.workspaceId}` : undefined))
    setStopLive(false)
    setTruncate(true)
    setTitle(request === undefined ? '' : `${request.title} (copy)`)
    setLiveRefused(false)
    setPending(false)
    setError(null)
    setSummary(null)
  }, [request])

  const destinations = useMemo((): MoveDestination[] => {
    if (request === undefined) return []
    const remotes: MoveDestination[] = (snapshot?.workspaces ?? [])
      .filter(workspace => request.mode === 'copy' || request.source.local === true || workspace.id !== request.source.workspaceId)
      .map(workspace => ({ kind: 'remote', workspace }))
    if (request.source.local === true) return remotes
    // Tree order mirrors the sidebar: this machine first, the remotes last.
    const locals: MoveDestination[] = localWorkspaces().map(view => ({ kind: 'local', workspaceId: view.workspaceId, title: view.title, path: view.path }))
    return [...locals, ...remotes]
  }, [localWorkspaces, request, snapshot])
  const chosen = destinations.find(candidate => destinationKey(candidate) === choice)
  const sourceWorkspace = request === undefined || request.source.local === true ? undefined : model.workspace(request.source.workspaceId)
  const crossHost = chosen !== undefined && (chosen.kind === 'local' || sourceWorkspace === undefined || chosen.workspace.serverId !== sourceWorkspace.serverId)
  const blocked = pending || chosen === undefined || summary !== null || (!copying && liveRefused && !stopLive)

  const confirm = async (): Promise<void> => {
    if (request === undefined || chosen === undefined || blocked) return
    setPending(true)
    setError(null)
    try {
      if (copying) {
        const trimmed = title.trim()
        const options = {
          ...(liveRefused ? { truncate } : {}),
          ...(trimmed === '' || trimmed === request.title ? {} : { title: trimmed }),
        }
        let where: string
        let truncated: boolean
        if (!crossHost && chosen.kind === 'remote' && request.source.local !== true) {
          const result = await model.copySession({ fromWorkspaceId: request.source.workspaceId, sessionId: request.sessionId, toWorkspaceId: chosen.workspace.id, ...options })
          where = chosen.workspace.title
          truncated = result.truncated
        } else {
          const result = await model.copyAcross({
            sessionId: request.sessionId,
            source: request.source.local === true ? { local: true } : { workspaceId: request.source.workspaceId },
            destination: chosen.kind === 'local' ? { local: true, workspaceId: chosen.workspaceId } : { workspaceId: chosen.workspace.id },
            ...options,
          })
          where = chosen.kind === 'local' ? `${chosen.title} (this machine)` : `${chosen.workspace.title} on ${chosen.workspace.server?.label ?? chosen.workspace.serverId}`
          where += ` (${String(Math.round(result.bytes / 1024))} KB)`
          truncated = result.truncated
        }
        setSummary(`Copied to ${where}; the original is untouched.${truncated ? ' The turn in progress was left out of the copy.' : ''}`)
      } else if (!crossHost && chosen.kind === 'remote' && request.source.local !== true) {
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
      if (code === (copying ? 'session/copy-live' : 'session/move-live')) setLiveRefused(true)
      else setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setPending(false)
    }
  }

  // A two-level tree: one heading per machine ("This machine", then each
  // remote by its label), its workspaces indented beneath with their paths.
  const menuItems: MenuEntry[] = []
  let lastGroup: string | undefined
  for (const destination of destinations) {
    const group = destination.kind === 'local' ? 'This machine' : (destination.workspace.server?.label ?? destination.workspace.serverId)
    if (group !== lastGroup) {
      if (lastGroup !== undefined) menuItems.push({ type: 'separator', id: `sep:${group}` })
      menuItems.push({ type: 'label', id: `group:${group}`, text: group })
      lastGroup = group
    }
    const title = destination.kind === 'local' ? destination.title : destination.workspace.title
    const path = destination.kind === 'local' ? destination.path : destination.workspace.remotePath
    menuItems.push({
      id: destinationKey(destination),
      label: (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, paddingLeft: 12 }}>
          {destination.kind === 'local' ? <IconFolderClose16 /> : <IconGlobeOutline14 />}
          <span>{title}</span>
        </span>
      ),
      ...(path === undefined ? {} : { detail: shortPath(path) }),
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
      width={520}
      title={copying
        ? (request?.source.local === true ? 'Copy session to a remote' : 'Copy remote session')
        : (request?.source.local === true ? 'Move session to a remote' : 'Move remote session')}
      footer={(
        <>
          <Button variant="outline" disabled={pending} onClick={() => { model.openMove(undefined) }}>{summary === null ? 'Cancel' : 'Close'}</Button>
          {summary === null && (
            <Button variant="primary" {...DIALOG_DEFAULT} disabled={blocked} onClick={() => { void confirm() }}>
              {copying ? (pending ? 'Copying…' : 'Copy') : (pending ? 'Moving…' : 'Move')}
            </Button>
          )}
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 }}>
        <div style={{ color: 'var(--dsw-alias-label-secondary)' }}>
          {copying
            ? `Copies “${request?.title ?? ''}” (with its subagent sessions) as a new session; the original is left as it is.`
            : request?.title}
        </div>
        <div style={S.field}>
          <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>Destination workspace</span>
          <Menu
            open={menuOpen}
            onClose={() => { setMenuOpen(false) }}
            items={menuItems.length === 0 ? [{ id: 'none', label: 'No destinations available', disabled: true }] : menuItems}
            onSelect={(id) => { setMenuOpen(false); if (id !== 'none') setChoice(id) }}
            selectedId={choice}
            matchAnchorWidth
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
        {copying && (
          <label style={S.field}>
            <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>Title of the copy</span>
            <Input value={title} disabled={pending || summary !== null} onChange={(event) => { setTitle(event.currentTarget.value) }} />
          </label>
        )}
        {crossHost && chosen !== undefined && summary === null && (
          <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', lineHeight: '17px' }}>
            {copying
              ? 'Different machine: the session log and its attachments are copied over. Files the agent worked on are not copied.'
              : 'Different machine: the session log and its attachments are copied over and the original is archived here. Files the agent worked on are not copied.'}
          </div>
        )}
        {liveRefused && copying && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
            <input type="checkbox" checked={truncate} disabled={pending} onChange={(event) => { setTruncate(event.currentTarget.checked) }} style={{ marginTop: 2 }} />
            <span>
              Copy only up to the last completed turn
              <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>The session is running. The turn in progress (and the prompt that started it) is left out of the copy. Unticked, the copy includes everything recorded so far and marks that turn as interrupted.</div>
            </span>
          </label>
        )}
        {liveRefused && !copying && (
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
  const selected = useView(state => (state.remoteActive === true ? state.selected : undefined))
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

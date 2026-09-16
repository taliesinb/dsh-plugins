/**
 * Browser components of dsh-remote-workspaces. English only, inline styles on
 * the shell's alias tokens (house pattern of the other plugins).
 *
 *  - AddRemoteButton   header seat beside "Add workspace": opens the modal.
 *  - RemoteGroups      extra seat below the local tree: one collapsible group
 *                      per mirrored workspace, cached sessions with spinners
 *                      while a poll runs, ↻ / + / … actions, session … menus.
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
import type { ProbeResult, RemoteApi, RemoteWorkspace } from './api.ts'
import { PANEL_ID, type RemoteSelection, type RemoteWorkspacesModel, type RuntimeState, type ViewState } from './store.ts'

/** Inject face every component of this plugin receives. */
export interface RemoteInjected {
  model: RemoteWorkspacesModel
  api: RemoteApi
  /** Select a remote session and bring our main panel forward. */
  openRemoteSession: (selection: RemoteSelection) => void
  hooks: {
    view: RemoteWorkspacesModel['view']
    runtime: RemoteWorkspacesModel['runtime']
  }
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
  group: { marginTop: 4 } as CSSProperties,
  groupRow: {
    display: 'flex', alignItems: 'center', gap: 4, height: 32, padding: '0 4px 0 6px', borderRadius: 8, cursor: 'pointer',
    userSelect: 'none', color: 'var(--dsw-alias-label-primary)', fontSize: 13,
  } as CSSProperties,
  groupTitle: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 } as CSSProperties,
  sessionRow: {
    display: 'flex', alignItems: 'center', gap: 6, height: 32, padding: '0 4px 0 30px', borderRadius: 8, cursor: 'pointer',
    userSelect: 'none', color: 'var(--dsw-alias-label-primary)', fontSize: 13,
  } as CSSProperties,
  sessionTitle: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as CSSProperties,
  muted: { color: 'var(--dsw-alias-label-tertiary)' } as CSSProperties,
  error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, padding: '2px 8px 4px 30px' } as CSSProperties,
  hint: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, padding: '2px 8px 4px 30px' } as CSSProperties,
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

/** Folder icon with the small "remote" globe badge — the row and button decoration. */
function RemoteFolderIcon({ open }: { open: boolean }) {
  return (
    <span style={{ position: 'relative', display: 'inline-flex', width: 18, height: 18, alignItems: 'center', justifyContent: 'center' }}>
      {open ? <IconFolderOpen16 size={16} /> : <IconFolderClose16 size={16} />}
      <span style={{ ...S.badge, right: -4, bottom: -3, width: 11, height: 11 }}><IconGlobeOutline14 size={9} /></span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// header seat

export function AddRemoteButton({ wide, model }: PropsRuntime<'sidebar.workspaces.headerAction'> & Face) {
  return (
    <IconButton label="Add remote workspace" onClick={() => { model.setAddOpen(true) }}>
      <IconProjectAddOutline16 size={wide ? 16 : 18} />
      <span style={S.badge}><IconGlobeOutline14 size={9} /></span>
    </IconButton>
  )
}

// ---------------------------------------------------------------------------
// groups

function shortId(id: string): string {
  return id.replace(/^session-/, '').slice(0, 8)
}

function SessionRow({ workspace, session, selected, busy, openRemoteSession, model }: {
  workspace: RemoteWorkspace
  session: RemoteWorkspace['cache']['sessions'][number] & { placeholder?: boolean }
  selected: boolean
  busy: boolean
} & Pick<Face, 'openRemoteSession' | 'model'>) {
  const [hover, setHover] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [rename, setRename] = useState<string | null>(null)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const items: MenuEntry[] = [
    { id: 'rename', label: 'Rename' },
    { id: 'archive', label: 'Archive', danger: true },
  ]
  const onSelect = async (id: string): Promise<void> => {
    setMenuOpen(false)
    if (id === 'rename') { setRename(session.title); setRenameError(null); return }
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
  return (
    <>
      <div
        role="treeitem"
        aria-selected={selected}
        style={{ ...S.sessionRow, background: selected || hover ? HOVER : 'transparent', opacity: pending ? 0.6 : 1 }}
        onMouseEnter={() => { setHover(true) }}
        onMouseLeave={() => { setHover(false) }}
        onClick={() => { openRemoteSession({ workspaceId: workspace.id, sessionId: session.id }) }}
      >
        {busy ? <Spinner /> : <span style={{ width: 14, display: 'inline-block' }} />}
        <span style={S.sessionTitle} title={session.title || session.id}>
          {session.title || <span style={S.muted}>{'placeholder' in session && session.placeholder === true ? 'New session' : `Untitled · ${shortId(session.id)}`}</span>}
        </span>
        {session.running === true && <span style={{ ...S.muted, fontSize: 11 }}>running</span>}
        <span style={{ display: 'inline-flex', visibility: hover || menuOpen ? 'visible' : 'hidden' }} onClick={(event) => { event.stopPropagation() }}>
          <Menu
            open={menuOpen}
            items={items}
            onSelect={(id) => { void onSelect(id) }}
            onClose={() => { setMenuOpen(false) }}
            portal
            align="end"
            anchor={(
              <button
                type="button"
                aria-label="Session actions"
                style={{ ...S.iconButton, width: 24, height: 24 }}
                onClick={(event) => { event.stopPropagation(); setMenuOpen(open => !open) }}
              >
                <IconEllipsisOutline16 size={16} />
              </button>
            )}
          />
        </span>
      </div>
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

function Group({ workspace, model, openRemoteSession, useView, useRuntime }: { workspace: RemoteWorkspace } & Face) {
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
    const cached = workspace.cache.sessions
    if (selected?.workspaceId === workspace.id && !cached.some(session => session.id === selected.sessionId)) {
      return [{ id: selected.sessionId, title: '', placeholder: true }, ...cached]
    }
    return cached
  }, [workspace.cache.sessions, workspace.id, selected])
  return (
    <div style={S.group}>
      <div
        role="treeitem"
        aria-expanded={expanded}
        style={{ ...S.groupRow, background: hover || menuOpen ? HOVER : 'transparent' }}
        title={`${serverLabel} · ${workspace.remotePath}`}
        onMouseEnter={() => { setHover(true) }}
        onMouseLeave={() => { setHover(false) }}
        onClick={() => { model.setExpanded(workspace.id, !expanded) }}
      >
        <span style={{ display: 'inline-flex', transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 120ms', color: 'var(--dsw-alias-label-tertiary)' }}>
          <IconTriangleRightFill14 size={14} />
        </span>
        <RemoteFolderIcon open={expanded} />
        <span style={S.groupTitle}>{workspace.title}</span>
        {workspace.cache.gone === true && <span style={{ ...S.muted, fontSize: 11 }}>gone</span>}
        {(hover || menuOpen) && (
          <>
            <IconButton label="Refresh from remote" disabled={polling} onClick={() => { void model.poll(workspace.id) }}>
              {polling ? <Spinner /> : <IconRefreshOutline16 size={16} />}
            </IconButton>
            <IconButton label="New remote session" disabled={starting || !expanded || workspace.cache.polledAt === undefined} onClick={() => { void start() }}>
              {starting ? <Spinner /> : <IconPlusOutline16 size={16} />}
            </IconButton>
            <span style={{ display: 'inline-flex' }} onClick={(event) => { event.stopPropagation() }}>
              <Menu
                open={menuOpen}
                items={items}
                onSelect={onMenu}
                onClose={() => { setMenuOpen(false) }}
                portal
                align="end"
                anchor={(
                  <button type="button" aria-label="Remote workspace actions" style={{ ...S.iconButton, width: 24, height: 24 }}
                    onClick={(event) => { event.stopPropagation(); setMenuOpen(open => !open) }}>
                    <IconEllipsisOutline16 size={16} />
                  </button>
                )}
              />
            </span>
          </>
        )}
      </div>
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

export function RemoteGroups(props: PropsRuntime<'sidebar.workspaces.extra'> & Face) {
  const { useRuntime, model } = props
  const workspaces = useRuntime(state => state.snapshot?.workspaces)
  const loaded = useRuntime(state => state.loaded)
  const loadError = useRuntime(state => state.loadError)
  useEffect(() => { if (!loaded) void model.refresh() }, [loaded, model])
  if (loadError !== undefined) return <div style={S.error}>Remote workspaces: {loadError}</div>
  if (workspaces === undefined || workspaces.length === 0) return null
  return (
    <div data-remote-workspaces>
      {workspaces.map(workspace => <Group key={workspace.id} workspace={workspace} {...props} />)}
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
    return workspaceName === '' ? '' : `${probe.label}-${workspaceName}`
  }, [probe, pick, path])
  useEffect(() => { if (!nameTouched) setName(suggestedName) }, [suggestedName, nameTouched])

  const runProbe = useCallback(async () => {
    setProbing(true); setError(null)
    try {
      const result = await api.probeServer(url.trim(), token.trim() === '' ? undefined : token.trim())
      setProbe(result)
      setPick(result.workspaces[0]?.workspaceId ?? 'new')
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
  const canDone = probe !== null && !adding && name.trim() !== '' && (pick !== 'new' || path.trim().startsWith('/'))

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
                <div key={workspace.workspaceId} role="radio" aria-checked={pick === workspace.workspaceId}
                  style={{ ...S.option, background: pick === workspace.workspaceId ? HOVER : 'transparent' }}
                  onClick={() => { setPick(workspace.workspaceId) }}>
                  <RemoteFolderIcon open={false} />
                  <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{workspace.title}</span>
                  <span style={{ ...S.muted, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '45%' }} title={workspace.path}>{workspace.path}</span>
                  <span style={{ ...S.muted, fontSize: 11 }}>{workspace.sessionCount}</span>
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

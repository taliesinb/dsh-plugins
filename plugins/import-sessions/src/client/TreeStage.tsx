/**
 * Decide stage, bulk shape — the scan tree: workspace rows (tri-state
 * checkbox over their selectable leaves, decoded dir, destination lozenge)
 * and flat session rows (checkbox, title, date range, size, turns, ~tokens).
 * Imported / duplicate rows are grayed out and hidden unless asked for.
 */
import { Input, Menu, Tag, Tooltip, fileSizeText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ImportDestination, ScanDestination, ScanSession, ScanWorkspace, SourcesResult } from './protocol.ts'
import { basename, borderColor, codeChip, dateRangeText, hoverBg, mono, plural, small, tildify, tokenText, warningColor } from './format.ts'

/** `<select>` value encoding for the per-workspace destination override. */
export type DestinationValue = `existing:${string}` | 'new' | 'ungrouped'

/** A session leaf can be imported when nothing already stands for it. */
export function isSelectable(session: ScanSession): boolean {
  return !session.imported && session.duplicateOf === undefined
}

/** The scan's computed default, encoded as the select value. */
export function defaultDestinationValue(destination: ScanDestination): DestinationValue {
  switch (destination.kind) {
    case 'existing': return `existing:${destination.workspaceId}`
    case 'new': return 'new'
    case 'ungrouped': return 'ungrouped'
  }
}

/** The value a workspace starts with: the scan's default. */
export function initialDestinationValue(workspace: ScanWorkspace): DestinationValue {
  return defaultDestinationValue(workspace.destination)
}

/** Default base directory (on the server) under which new workspaces are created. */
export const DEFAULT_NEW_BASE = '~/'

/** `~/` + `foo` → `~/foo`; the server expands `~`. */
export function newWorkspacePath(base: string, workspace: ScanWorkspace): string {
  const trimmed = base.trim() === '' ? DEFAULT_NEW_BASE : base.trim()
  return `${trimmed.replace(/\/+$/, '')}/${basename(workspace.dir)}`
}

interface DestinationOption { value: DestinationValue, tone: 'success' | 'outline' | 'none', label: string, path: string | undefined }

/**
 * Choices for a workspace's destination: the new workspace first (green,
 * placed under `newBase`), then every existing DSH workspace (gray, at its
 * path), then Ungrouped.
 */
export function destinationOptions(workspace: ScanWorkspace, existing: SourcesResult['workspaces'], newBase: string): DestinationOption[] {
  const scanExisting = workspace.destination.kind === 'existing' ? workspace.destination : undefined
  const knownIds = new Set(existing.map(w => w.id))
  return [
    { value: 'new', tone: 'success', label: basename(workspace.dir), path: newWorkspacePath(newBase, workspace) },
    ...existing.map(w => ({ value: `existing:${w.id}` as const, tone: 'outline' as const, label: w.title, path: tildify(w.path) })),
    ...scanExisting !== undefined && !knownIds.has(scanExisting.workspaceId)
      ? [{ value: `existing:${scanExisting.workspaceId}` as const, tone: 'outline' as const, label: scanExisting.title, path: undefined }]
      : [],
    { value: 'ungrouped', tone: 'none', label: 'ungrouped', path: undefined },
  ]
}

/** Resolve a value to the protocol's per-session destination. */
export function resolveDestination(value: DestinationValue, workspace: ScanWorkspace, newBase: string): ImportDestination {
  if (value.startsWith('existing:')) return { kind: 'existing', workspaceId: value.slice('existing:'.length) }
  if (value === 'new') return { kind: 'new', dir: newWorkspacePath(newBase, workspace) }
  return { kind: 'ungrouped' }
}

/** Why a row is grayed out (imported / duplicate), for its tooltip. */
export function unselectableReason(session: ScanSession): string | undefined {
  if (session.imported) return 'Already imported into DSH'
  if (session.duplicateOf !== undefined) return `Same source session as ${session.duplicateOf} (already listed)`
  return undefined
}

/** N subagents — the one badge a row keeps (imported/duplicate gray the row, large tints the token count). */
export function SessionBadges({ session }: { session: ScanSession }): ReactNode {
  if (session.subagents === undefined || session.subagents === 0) return null
  return <Tag tone="info"><span title="Subagent transcripts imported as child sessions">{plural(session.subagents, 'subagent')}</span></Tag>
}

/** A destination's visual: green / hairline lozenge, or plain muted text for "ungrouped". */
function LozengeText({ tone, label, clamp = false }: { tone: 'success' | 'outline' | 'none', label: string, clamp?: boolean }) {
  const text = <span style={clamp ? { display: 'inline-block', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' } : undefined}>{label}</span>
  if (tone === 'none') return <span style={{ ...small, opacity: 0.8, fontStyle: 'italic' }}>{text}</span>
  return <Tag tone={tone}>{text}</Tag>
}

/**
 * The destination as a lozenge (green = new workspace, hairline = existing,
 * plain lowercase text = ungrouped). Clicking it opens a menu whose rows read
 * "(lozenge) at ~/path": the new workspace first, then the existing ones.
 */
export function DestinationLozenge({ value, workspace, existing, newBase, onChange }: { value: DestinationValue, workspace: ScanWorkspace, existing: SourcesResult['workspaces'], newBase: string, onChange: (value: DestinationValue) => void }) {
  const [open, setOpen] = useState(false)
  // Escape must close the menu only: the Modal closes itself on any document
  // Escape, so swallow it in the capture phase on window while the menu is open.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopImmediatePropagation()
      event.preventDefault()
      setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  }, [open])
  const options = destinationOptions(workspace, existing, newBase)
  const current = options.find(option => option.value === value) ?? options[0]
  // One row = [check column] lozenge …≥20px… path chip (right-aligned). The
  // Menu is in `fill` selection mode so it draws no trailing check of its own.
  const items: MenuEntry[] = options.map(option => ({
    id: option.value,
    label: (
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', minWidth: 0 }}>
        <span aria-hidden="true" style={{ flex: 'none', width: 14, textAlign: 'center', fontSize: 13, lineHeight: 1 }}>{option.value === current.value ? '✓' : ''}</span>
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20, flex: 1, minWidth: 0 }}>
          <LozengeText tone={option.tone} label={option.label} />
          {option.path !== undefined && <code style={{ ...codeChip, flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }} title={option.path}>{option.path}</code>}
        </span>
      </span>
    ),
  }))
  return (
    <Menu
      open={open}
      portal
      dense
      anchor={(
        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); setOpen(next => !next) }}
          title={current.path !== undefined ? `${current.label} at ${current.path} — click to change` : `${current.label} — click to change`}
          style={{ display: 'inline-flex', alignItems: 'center', maxWidth: 220, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit' }}
        >
          <LozengeText tone={current.tone} label={current.label} clamp />
        </button>
      )}
      items={items}
      selectedId={current.value}
      selection="fill"
      onSelect={(id) => { onChange(id as DestinationValue); setOpen(false) }}
      onClose={() => { setOpen(false) }}
    />
  )
}

/** Native checkbox with `indeterminate` support (the primitive has none). */
function TriCheckbox({ state, disabled, title, onChange }: { state: 'none' | 'some' | 'all', disabled: boolean, title: string, onChange: (next: boolean) => void }) {
  const ref = useRef<HTMLInputElement | null>(null)
  useEffect(() => { if (ref.current !== null) ref.current.indeterminate = state === 'some' }, [state])
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={title}
      title={title}
      checked={state === 'all'}
      disabled={disabled}
      onChange={(event) => { onChange(event.target.checked) }}
      style={{ width: 16, height: 16, margin: 0, accentColor: 'var(--dsw-alias-brand-primary)', cursor: disabled ? 'default' : 'pointer' }}
    />
  )
}

function WorkspaceRow({ workspace, selected, existing, destination, newBase, remoteDirs, onToggleAll, onDestination }: {
  workspace: ScanWorkspace
  selected: ReadonlySet<string>
  existing: SourcesResult['workspaces']
  destination: DestinationValue
  newBase: string
  remoteDirs: boolean
  onToggleAll: (files: string[], next: boolean) => void
  onDestination: (value: DestinationValue) => void
}) {
  const selectable = workspace.sessions.filter(isSelectable)
  const picked = selectable.filter(session => selected.has(session.file)).length
  const state: 'none' | 'some' | 'all' = picked === 0 ? 'none' : picked === selectable.length ? 'all' : 'some'
  const files = selectable.map(session => session.file)
  const dir = tildify(workspace.dir)
  const ungroupedReason = workspace.destination.kind === 'ungrouped' ? workspace.destination.reason : undefined
  return (
    <tr style={{ background: hoverBg, height: 32 }}>
      <td style={{ padding: '6px 8px', verticalAlign: 'middle', width: 24 }}>
        <TriCheckbox
          state={state}
          disabled={selectable.length === 0}
          title={selectable.length === 0 ? 'Nothing left to import in this workspace' : state === 'all' ? 'Deselect all sessions in this workspace' : 'Select all sessions in this workspace'}
          onChange={(next) => { onToggleAll(files, next) }}
        />
      </td>
      <td colSpan={5} style={{ padding: '6px 8px', verticalAlign: 'middle', minWidth: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {!workspace.dirExists && !remoteDirs && (
            <Tooltip label={`Directory no longer exists: ${workspace.dir}${ungroupedReason !== undefined ? ` (${ungroupedReason})` : ''}`} side="bottom">
              <span aria-label="Directory missing" style={{ color: warningColor, fontWeight: 700, cursor: 'help' }}>⚠</span>
            </Tooltip>
          )}
          <span style={{ ...mono, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '0 1 auto', minWidth: 0 }} title={workspace.dir}>{dir}</span>
          <span style={{ opacity: 0.6, flex: 'none' }} aria-hidden="true">→</span>
          <span style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', height: 20 }}>
            <DestinationLozenge value={destination} workspace={workspace} existing={existing} newBase={newBase} onChange={onDestination} />
          </span>
        </div>
      </td>
    </tr>
  )
}

function SessionRow({ session, checked, parentTicked, onToggle }: { session: ScanSession, checked: boolean, parentTicked: boolean, onToggle: (next: boolean) => void }) {
  const selectable = isSelectable(session)
  const reason = unselectableReason(session)
  return (
    <tr className="tali-import-leaf" style={{ opacity: selectable ? 1 : 0.4, height: 28 }} title={reason}>
      <td style={{ padding: '4px 8px', verticalAlign: 'middle' }}>
        <input
          type="checkbox"
          checked={checked}
          disabled={!selectable}
          aria-label={session.title}
          onChange={(event) => { onToggle(event.target.checked) }}
          // Hidden while the workspace is unticked (the row hover and the title click still reach it).
          style={{ width: 16, height: 16, margin: 0, accentColor: 'var(--dsw-alias-brand-primary)', cursor: selectable ? 'pointer' : 'default', visibility: parentTicked || checked ? 'visible' : 'hidden' }}
        />
      </td>
      <td style={{ padding: '4px 8px', verticalAlign: 'middle', minWidth: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span
            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: selectable ? 'pointer' : 'default' }}
            title={reason ?? session.file}
            onClick={() => { if (selectable) onToggle(!checked) }}
          >
            {session.title}
          </span>
          <SessionBadges session={session} />
        </div>
      </td>
      <td style={{ padding: '4px 8px', verticalAlign: 'middle', whiteSpace: 'nowrap', ...small }}>{dateRangeText(session.startedAt, session.endedAt)}</td>
      <td style={{ padding: '4px 8px', verticalAlign: 'middle', whiteSpace: 'nowrap', textAlign: 'right', ...small }}>
        {fileSizeText(session.bytes)}
      </td>
      <td style={{ padding: '4px 8px', verticalAlign: 'middle', whiteSpace: 'nowrap', textAlign: 'right', ...small }}>
        {plural(session.turns, 'turn')}
      </td>
      <td style={{ padding: '4px 8px', verticalAlign: 'middle', whiteSpace: 'nowrap', textAlign: 'right', ...small, ...session.large ? { color: warningColor, opacity: 1 } : {} }} title={`${String(session.estimatedTokens)} estimated model-visible tokens`}>
        {tokenText(session.estimatedTokens)}
      </td>
    </tr>
  )
}

/**
 * The tree table.
 * @param props.workspaces - scan rows.
 * @param props.existing - existing DSH workspaces for the destination select.
 * @param props.selected - selected transcript paths.
 * @param props.destinations - current select value per workspace key.
 */
export function TreeStage({ workspaces, existing, selected, destinations, showHidden, newBase, remoteDirs = false, onNewBase, onToggle, onDestination }: {
  /** The transcripts came from another machine: the server's `dirExists` is not about the recording directories, so no ⚠. */
  remoteDirs?: boolean
  workspaces: ScanWorkspace[]
  existing: SourcesResult['workspaces']
  selected: ReadonlySet<string>
  destinations: Readonly<Record<string, DestinationValue>>
  /** Also list imported / duplicate sessions (grayed out); default hides them and any workspace left empty. */
  showHidden: boolean
  /** Base directory for new workspaces (`~/`). */
  newBase: string
  onNewBase: (base: string) => void
  onToggle: (files: string[], next: boolean) => void
  onDestination: (key: string, value: DestinationValue) => void
}) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  // Lock the list box to the height it had before any filtering, so typing in
  // the filter (fewer rows) does not resize — and re-centre — the whole modal.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [lockedHeight, setLockedHeight] = useState<number | undefined>(undefined)
  useLayoutEffect(() => {
    if (lockedHeight !== undefined || needle !== '') return
    const node = scrollRef.current
    if (node !== null && node.offsetHeight > 0) setLockedHeight(node.offsetHeight)
  }, [lockedHeight, needle, showHidden])
  const matches = (workspace: ScanWorkspace, session: ScanSession): boolean =>
    needle === '' || session.title.toLowerCase().includes(needle) || tildify(workspace.dir).toLowerCase().includes(needle) || workspace.dir.toLowerCase().includes(needle)
  // The placement field matters only while a selected session heads for a NEW workspace.
  const anyNewSelected = workspaces.some(workspace =>
    (destinations[workspace.key] ?? defaultDestinationValue(workspace.destination)) === 'new'
    && workspace.sessions.some(session => selected.has(session.file)))
  const visible = workspaces
    .map(workspace => ({ ...workspace, sessions: workspace.sessions.filter(session => (showHidden || isSelectable(session)) && matches(workspace, session)) }))
    .filter(workspace => workspace.sessions.length > 0)
  if (workspaces.length === 0) {
    return <div style={{ ...small, padding: '12px 0' }}>Nothing importable was found under that path.</div>
  }
  const total = workspaces.reduce((sum, workspace) => sum + workspace.sessions.length, 0)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    {total > 1 && (
      <Input
        value={query}
        onChange={(event) => { setQuery(event.target.value) }}
        placeholder="Filter by title or path…"
        aria-label="Filter sessions by title or path"
        spellCheck={false}
        style={{ fontSize: 13 }}
      />
    )}
    {visible.length === 0
      ? <div style={{ ...small, padding: '12px 12px', border: `1px solid ${borderColor}`, borderRadius: 8, ...lockedHeight !== undefined ? { height: lockedHeight, boxSizing: 'border-box' } : {} }}>{needle !== '' ? 'No session matches that filter.' : 'Everything under that path is already imported.'}</div>
      : (
    <div ref={scrollRef} className="tali-import-scroll" style={{ maxHeight: '50vh', overflowY: 'auto', overflowX: 'hidden', border: `1px solid ${borderColor}`, borderRadius: 8, ...lockedHeight !== undefined ? { height: lockedHeight, boxSizing: 'border-box' } : {} }}>
      {/* A thin scrollbar that floats over the rows: the table is one gutter wider than the box, so row fills run under the thumb. */}
      <style>{`.tali-import-scroll { scrollbar-width: thin; scrollbar-color: var(--dsw-alias-label-tertiary, rgba(127,127,127,0.6)) transparent; } .tali-import-scroll::-webkit-scrollbar { width: 8px; } .tali-import-scroll::-webkit-scrollbar-track { background: transparent; } .tali-import-scroll::-webkit-scrollbar-thumb { background: var(--dsw-alias-label-tertiary, rgba(127,127,127,0.6)); border-radius: 4px; border: 2px solid transparent; background-clip: padding-box; } .tali-import-tree tr[title] { cursor: default; } .tali-import-tree tr.tali-import-leaf:hover input[type=checkbox]:not(:disabled) { visibility: visible !important; } .tali-import-tree td:last-child { padding-right: 16px !important; }`}</style>
      <table className="tali-import-tree" style={{ width: 'calc(100% + 8px)', borderCollapse: 'collapse', fontSize: 13, tableLayout: 'fixed' }}>
        <colgroup>
          <col style={{ width: 28 }} />
          <col />
          <col style={{ width: 108 }} />
          <col style={{ width: 60 }} />
          <col style={{ width: 70 }} />
          <col style={{ width: 82 }} />
        </colgroup>
        <tbody>
          {visible.map(workspace => (
            <WorkspaceGroup
              key={workspace.key}
              workspace={workspace}
              existing={existing}
              selected={selected}
              destination={destinations[workspace.key] ?? defaultDestinationValue(workspace.destination)}
              newBase={newBase}
              remoteDirs={remoteDirs}
              onToggle={onToggle}
              onDestination={(value) => { onDestination(workspace.key, value) }}
            />
          ))}
        </tbody>
      </table>
    </div>
      )}
    <NewBaseField value={newBase} enabled={anyNewSelected} onChange={onNewBase} />
    </div>
  )
}

/** "Place (new) workspaces in: [ ~/ ]" — grayed (but still editable) until a selected session heads for a new workspace. */
export function NewBaseField({ value, enabled, onChange }: { value: string, enabled: boolean, onChange: (base: string) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, opacity: enabled ? 1 : 0.45, transition: 'opacity 120ms' }} title={enabled ? 'Server directory under which new workspaces are created (one folder per workspace, named after the original)' : 'No selected session goes to a new workspace'}>
      <span style={{ whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 6 }}>Place <Tag tone="success">new</Tag> workspaces in:</span>
      <Input value={value} spellCheck={false} onChange={(event) => { onChange(event.target.value) }} style={{ ...mono, width: 220 }} aria-label="Base directory for new workspaces" />
    </label>
  )
}

function WorkspaceGroup({ workspace, existing, selected, destination, newBase, remoteDirs, onToggle, onDestination }: {
  workspace: ScanWorkspace
  existing: SourcesResult['workspaces']
  selected: ReadonlySet<string>
  destination: DestinationValue
  newBase: string
  remoteDirs: boolean
  onToggle: (files: string[], next: boolean) => void
  onDestination: (value: DestinationValue) => void
}) {
  const parentTicked = workspace.sessions.some(session => selected.has(session.file))
  return (
    <>
      <WorkspaceRow
        workspace={workspace}
        selected={selected}
        existing={existing}
        destination={destination}
        newBase={newBase}
        remoteDirs={remoteDirs}
        onToggleAll={onToggle}
        onDestination={onDestination}
      />
      {workspace.sessions.map(session => (
        <SessionRow
          key={session.file}
          session={session}
          checked={selected.has(session.file)}
          parentTicked={parentTicked}
          onToggle={(next) => { onToggle([session.file], next) }}
        />
      ))}
    </>
  )
}

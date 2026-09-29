/**
 * tali-message-stash — browser half.
 *
 * A git-stash for composer messages:
 *
 *   Ctrl+S      push the composer text onto the stash (composer clears)
 *   Ctrl+S, S   open the stash view (list, restore, delete, clear)
 *   Ctrl+R      cycle: the top stashed message replaces the composer text;
 *               what was in the composer goes to the bottom of the stash
 *
 * A message brought in by Ctrl+R is only POPPED when it is sent. Editing it
 * and pressing Ctrl+R again writes the edits back and moves on to the next
 * one; Ctrl+S puts it (edited) back on top; clearing the composer by hand
 * leaves it in the stash untouched.
 *
 * Pieces:
 *   - `StashWatcher` (`conversation.input.dock`, one per mounted session):
 *     renders only a hidden marker; registers the session's `inputActions`
 *     with the controller and reports the live draft, the input phase and
 *     every local submission echo (`pendingSubmissions`) — the echo is how a
 *     send is detected, since an ordinary send clears the draft synchronously.
 *   - `StashButton` (`conversation.input.right`): the stash count beside the
 *     model picker; click opens the view. Nothing while the stash is empty.
 *   - `StashView` (`shell.overlay`): the Ctrl+S,S dialog.
 *   - `StashSettingsRow` (`settings.general.item`): the double-tap window.
 *   - One capture-phase `keydown` listener on `window` for the chords.
 *
 * The stash and the settings live in localStorage (one per browser profile,
 * all sessions).
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Modal, Tooltip, relativeTime } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { StashController, type ViewState } from './controller.ts'
import { chordOf, DOUBLE_TAP_MS, DoubleTap, focusAllows } from './keys.ts'
import { StashSettingsRow, type SettingsRowInjected, type StashSettings } from './settings.tsx'
import type { StashEntry, StashState } from './stash.ts'

export { chordOf, DoubleTap, focusAllows } from './keys.ts'
export * from './stash.ts'

const MARKER_ATTR = 'data-tali-stash-session'
/** Persisted settings store name (localStorage, via the client store's own persistence). */
const SETTINGS_STORE = 'tali.message-stash.settings'
/** Persisted drafts seed asynchronously after mount; reconcile a checkout after this. */
const RECONCILE_MS = 500

interface Injected {
  controller: StashController
}

// ---- hooks over the controller (plain subscribe; no framework store needed) ----

function useStashState(controller: StashController): StashState {
  const [state, setState] = useState(() => controller.getState())
  useEffect(() => controller.subscribe(() => { setState(controller.getState()) }), [controller])
  return state
}

function useViewState(controller: StashController): ViewState {
  const [view, setView] = useState(() => controller.getView())
  useEffect(() => controller.subscribe(() => { setView(controller.getView()) }), [controller])
  return view
}

// ---- watcher --------------------------------------------------------------------

type WatcherProps = PropsRuntime<'conversation.input.dock'> & InjectFace<Injected>

/** Registers this session's composer with the controller; renders a hidden marker. */
function StashWatcher({ sessionId, useInput, useSession, useSessions, inputActions, controller }: WatcherProps): ReactNode {
  const draft = useInput(state => state.draft)
  const phase = useInput(state => state.phase)
  const pending = useSession(snapshot => snapshot.pendingSubmissions)
  const title = useSessions(list => list.byId[sessionId]?.displayTitle)
  const marker = useRef<HTMLSpanElement>(null)
  const titleRef = useRef(title)
  titleRef.current = title

  useEffect(() => controller.register({
    sessionId,
    sessionTitle: () => titleRef.current,
    setDraft: text => { inputActions.setDraft(text) },
    marker: () => marker.current,
  }), [controller, sessionId, inputActions])

  useEffect(() => { controller.onDraft(sessionId, draft) }, [controller, sessionId, draft])
  useEffect(() => { controller.onPhase(sessionId, phase === 'plain') }, [controller, sessionId, phase])

  const seen = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const echo of pending) {
      if (seen.current.has(echo.requestId)) continue
      seen.current.add(echo.requestId)
      controller.onSent(sessionId, echo.text)
    }
  }, [controller, sessionId, pending])

  useEffect(() => {
    const timer = setTimeout(() => { controller.reconcile(sessionId) }, RECONCILE_MS)
    return () => { clearTimeout(timer) }
  }, [controller, sessionId])

  return <span ref={marker} {...{ [MARKER_ATTR]: sessionId }} hidden />
}

// ---- tool-row button ---------------------------------------------------------

type ButtonProps = PropsRuntime<'conversation.input.right'> & InjectFace<Injected>

const stashButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  height: 28,
  padding: '0 8px',
  border: 'none',
  borderRadius: 999,
  background: 'var(--dsw-specific-selector)',
  color: 'var(--dsw-alias-label-secondary)',
  font: 'inherit',
  fontSize: 12,
  fontWeight: 500,
  lineHeight: '20px',
  cursor: 'pointer',
}

function StashGlyph({ size = 14 }: { size?: number }): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
    </svg>
  )
}

function StashButton({ sessionId, controller }: ButtonProps): ReactNode {
  const state = useStashState(controller)
  const count = state.entries.length
  if (count === 0) return null
  const label = `Stash (${String(count)})`
  return (
    <Tooltip label={label} side="top" delayMs={500}>
      <button
        type="button"
        style={stashButtonStyle}
        aria-label={label}
        onMouseDown={event => { event.preventDefault() }}
        onClick={() => { controller.openView(sessionId) }}
      >
        <StashGlyph />
        <span>{count}</span>
      </button>
    </Tooltip>
  )
}

// ---- the view ---------------------------------------------------------------------

type ViewProps = InjectFace<Injected>

const rowStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25))',
  cursor: 'pointer',
  outline: 'none',
}
const rowSelectedStyle: CSSProperties = {
  ...rowStyle,
  borderColor: 'var(--dsw-alias-state-business-primary, #3b82f6)',
  background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08))',
}
const previewStyle: CSSProperties = {
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 4,
  overflow: 'hidden',
  fontSize: 13,
  lineHeight: 1.45,
  color: 'var(--dsw-alias-label-primary)',
}
const metaStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 11,
  color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
}
const deleteStyle: CSSProperties = {
  marginLeft: 'auto',
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  padding: '0 4px',
  font: 'inherit',
}

function ago(at: number, now: number): string {
  const rel = relativeTime(at, now)
  switch (rel.unit) {
    case 'now': return 'now'
    case 'minutes': return `${String(rel.n)}min`
    case 'hours': return `${String(rel.n)}h`
    case 'days': return `${String(rel.n)}d`
    case 'months': return `${String(rel.n)}mo`
    case 'years': return `${String(rel.n)}y`
  }
}

function StashRow({ entry, selected, inComposer, now, onSelect, onRestore, onDelete }: {
  entry: StashEntry
  selected: boolean
  inComposer: boolean
  now: number
  onSelect: () => void
  onRestore: () => void
  onDelete: () => void
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])
  return (
    <div
      ref={ref}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      style={selected ? rowSelectedStyle : rowStyle}
      onMouseEnter={onSelect}
      onClick={onRestore}
    >
      <div style={previewStyle}>{entry.text}</div>
      <div style={metaStyle}>
        <span>{ago(entry.updatedAt, now)}</span>
        {entry.sessionTitle !== undefined && <span>· {entry.sessionTitle}</span>}
        {inComposer && <span>· in composer</span>}
        <button
          type="button"
          style={deleteStyle}
          aria-label="Delete"
          onClick={event => { event.stopPropagation(); onDelete() }}
        >
          ×
        </button>
      </div>
    </div>
  )
}

function StashView({ controller }: ViewProps): ReactNode {
  const view = useViewState(controller)
  const state = useStashState(controller)
  const [selected, setSelected] = useState(0)
  const [confirmClear, setConfirmClear] = useState(false)
  const now = useMemo(() => Date.now(), [view.open, state])
  const restore = useRef<Element | null>(null)

  const entries = state.entries
  const clamped = Math.min(selected, Math.max(0, entries.length - 1))

  // Focus: the list on open, back to where it was on close.
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!view.open) return
    restore.current = document.activeElement
    setSelected(0)
    setConfirmClear(false)
    const timers = [0, 50, 200].map(ms => setTimeout(() => { list.current?.focus({ preventScroll: true }) }, ms))
    return () => {
      for (const timer of timers) clearTimeout(timer)
      const before = restore.current
      restore.current = null
      if (before instanceof HTMLElement && before.isConnected) before.focus({ preventScroll: true })
    }
  }, [view.open])

  useEffect(() => {
    if (!view.open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return
      const count = controller.getState().entries.length
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault()
          setSelected(index => Math.min(index + 1, Math.max(0, count - 1)))
          return
        case 'ArrowUp':
          event.preventDefault()
          setSelected(index => Math.max(index - 1, 0))
          return
        case 'Enter': {
          const entry = controller.getState().entries[clamped]
          if (entry === undefined) return
          event.preventDefault()
          controller.restore(entry.id)
          controller.closeView()
          return
        }
        case 'Backspace':
        case 'Delete': {
          const entry = controller.getState().entries[clamped]
          if (entry === undefined) return
          event.preventDefault()
          controller.drop(entry.id)
          return
        }
        default:
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [view.open, clamped, controller])

  if (!view.open) return null
  const close = (): void => { controller.closeView() }
  const inComposer = state.checkout?.entryId

  return (
    <Modal
      open
      title="Stash"
      closeLabel="Close"
      onClose={close}
      width={560}
      footer={<>
        {entries.length > 0 && (
          <Button
            variant="outline"
            onClick={() => {
              if (!confirmClear) { setConfirmClear(true); return }
              controller.clearAll()
              setConfirmClear(false)
            }}
          >
            {confirmClear ? 'Clear all?' : 'Clear'}
          </Button>
        )}
        <Button variant="primary" onClick={close}>Close</Button>
      </>}
    >
      <div
        ref={list}
        role="listbox"
        aria-label="Stash"
        tabIndex={-1}
        style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: '60vh', overflowY: 'auto', outline: 'none' }}
      >
        {entries.length === 0 && (
          <div style={{ fontSize: 13, opacity: 0.7, padding: '8px 2px' }}>Empty</div>
        )}
        {entries.map((entry, index) => (
          <StashRow
            key={entry.id}
            entry={entry}
            selected={index === clamped}
            inComposer={entry.id === inComposer}
            now={now}
            onSelect={() => { setSelected(index) }}
            onRestore={() => { controller.restore(entry.id); controller.closeView() }}
            onDelete={() => { controller.drop(entry.id) }}
          />
        ))}
      </div>
    </Modal>
  )
}

// ---- plugin -------------------------------------------------------------------------

export const name = 'message-stash-client'
export const inject = ['slots']

export function apply(ctx: Context): void {
  const storage = typeof localStorage === 'undefined' ? undefined : localStorage
  const controller = new StashController(storage)
  const settings = createSnapshotStore<StashSettings>({ doubleTapMs: DOUBLE_TAP_MS }, { persist: { name: SETTINGS_STORE } })
  const doubleTap = new DoubleTap(settings.getSnapshot().doubleTapMs)
  ctx.effect(() => settings.subscribe(() => { doubleTap.setWindow(settings.getSnapshot().doubleTapMs) }), 'message-stash: settings → double tap')
  const injected = (): Injected => ({ controller })

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return
    const chord = chordOf(event)
    if (chord === undefined) {
      // Any other key (modifiers excepted) breaks a Ctrl+S double tap.
      if (!['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) doubleTap.interrupt()
      return
    }
    if (controller.getView().open) {
      // Inside the view the chords only close it (Ctrl+S,S toggles).
      event.preventDefault()
      event.stopPropagation()
      if (chord === 'stash') controller.closeView()
      return
    }
    if (!focusAllows(document.activeElement)) return
    event.preventDefault()
    event.stopPropagation()
    if (chord === 'stash') {
      if (doubleTap.tap(event.timeStamp)) {
        controller.openView()
        return
      }
      const outcome = controller.stash()
      if (outcome === 'no-session' || outcome === 'busy') console.info(`[message-stash] Ctrl+S: ${outcome}`)
      return
    }
    doubleTap.interrupt()
    const outcome = controller.cycle()
    if (outcome === 'no-session' || outcome === 'busy') console.info(`[message-stash] Ctrl+R: ${outcome}`)
  }

  ctx.effect(() => {
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  }, 'message-stash: keydown capture')

  ctx.effect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.storageArea === storage) controller.reloadFromStorage()
    }
    window.addEventListener('storage', onStorage)
    return () => { window.removeEventListener('storage', onStorage) }
  }, 'message-stash: cross-tab sync')

  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      { name: 'conversation.input.dock', id: 'tali-message-stash', order: 1010, inject: injected },
      StashWatcher,
    ))

  ctx.slots.inject('conversation.input.right', () =>
    ctx.slots.register(
      { name: 'conversation.input.right', id: 'tali-message-stash', order: 50, inject: injected },
      StashButton,
    ))

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'tali-message-stash', inject: injected },
      StashView,
    ))

  ctx.slots.inject('settings.general.item', () =>
    ctx.slots.register(
      {
        name: 'settings.general.item',
        id: 'tali-message-stash-double-tap',
        order: 60,
        inject: (): SettingsRowInjected => ({
          hooks: { settings },
          setDoubleTapMs: (ms) => { settings.set({ doubleTapMs: ms }) },
        }),
      },
      StashSettingsRow,
    ))

  console.info('[message-stash] Ctrl+S stash · Ctrl+S,S view · Ctrl+R cycle')
}

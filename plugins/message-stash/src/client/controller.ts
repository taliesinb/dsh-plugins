/**
 * The runtime around the pure model (stash.ts): persistence in localStorage,
 * the per-session composer registrations the chords act on, the "was it
 * sent?" observation that decides when a checked-out entry is really popped,
 * and the open/closed state of the stash view.
 *
 * Sessions register from the input-dock watcher component (index.tsx): each
 * registration carries the session's `InputActions` and reports the live
 * draft and every local submission echo. The chords address the session
 * whose composer has focus, else the most recently registered one.
 */
import {
  EMPTY, checkedOut, clear, cycle, decode, encode, isBlank, pop, push, release, restore,
  type StashEntry, type StashState,
} from './stash.ts'

/** localStorage key (one stash per browser profile, shared by every session). */
export const STORAGE_KEY = 'tali.message-stash.v1'

/** How long after the composer emptied a submission echo still counts as that entry being sent. */
const RELEASE_GRACE_MS = 2000

/** The composer face a session registers. */
export interface ComposerHandle {
  readonly sessionId: string
  readonly sessionTitle: () => string | undefined
  readonly setDraft: (text: string) => void
  /** Root element of the session's input dock (locates the focused composer). */
  readonly marker: () => Element | null
}

export interface ViewState {
  readonly open: boolean
  /** Session a "Restore" from the view targets. */
  readonly sessionId: string | undefined
}

type Listener = () => void

/** Result vocabulary for the callers' console traces. */
export type ChordOutcome = 'pushed' | 'blank' | 'checkout' | 'nothing' | 'no-session' | 'busy'

export class StashController {
  private state: StashState = EMPTY
  private view: ViewState = { open: false, sessionId: undefined }
  private readonly listeners = new Set<Listener>()
  private readonly handles = new Map<string, ComposerHandle>()
  /** Registration order; the last one is the default target. */
  private order: string[] = []
  private readonly drafts = new Map<string, string>()
  private readonly busy = new Map<string, boolean>()
  /** Checkout has been seen with text in the composer (so a later blank means "cleared by hand"). */
  private seenText = false
  /** A checkout ended by the composer emptying; a send echo inside the grace window still pops it. */
  private released: { entryId: string; sessionId: string; at: number } | undefined

  private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | undefined
  private readonly now: () => number

  constructor(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined, now: () => number = Date.now) {
    this.storage = storage
    this.now = now
    this.state = decode(storage?.getItem(STORAGE_KEY) ?? null)
  }

  // ---- observation ----

  getState(): StashState { return this.state }
  getView(): ViewState { return this.view }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Another tab wrote the stash: adopt it. */
  reloadFromStorage(): void {
    this.state = decode(this.storage?.getItem(STORAGE_KEY) ?? null)
    this.notify()
  }

  private set(state: StashState): void {
    if (state === this.state) return
    this.state = state
    if (state.checkout === undefined) this.seenText = false
    try {
      this.storage?.setItem(STORAGE_KEY, encode(state))
    } catch (error) {
      // Quota or a disabled storage: the stash still works for this page.
      console.warn('[message-stash] could not persist:', error)
    }
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  // ---- sessions ----

  register(handle: ComposerHandle): () => void {
    this.handles.set(handle.sessionId, handle)
    this.order = [...this.order.filter(id => id !== handle.sessionId), handle.sessionId]
    return () => {
      if (this.handles.get(handle.sessionId) === handle) this.handles.delete(handle.sessionId)
      this.order = this.order.filter(id => id !== handle.sessionId)
      this.drafts.delete(handle.sessionId)
      this.busy.delete(handle.sessionId)
    }
  }

  /** The composer's live clipboard projection. */
  onDraft(sessionId: string, draft: string): void {
    this.drafts.set(sessionId, draft)
    const current = checkedOut(this.state, sessionId)
    if (current === undefined) return
    if (!isBlank(draft)) {
      this.seenText = true
      return
    }
    if (!this.seenText) return
    // Cleared by hand (or sent — the echo arrives within the grace window).
    this.released = { entryId: current.id, sessionId, at: this.now() }
    this.set(release(this.state, sessionId))
  }

  /** The input machine's phase: only `plain` accepts programmatic draft writes safely. */
  onPhase(sessionId: string, plain: boolean): void {
    this.busy.set(sessionId, !plain)
  }

  /**
   * A session began a local submission. The checked-out entry of that
   * session (or the one whose checkout just ended by the composer emptying)
   * was sent: pop it.
   */
  onSent(sessionId: string, text: string): void {
    if (isBlank(text)) return
    const current = checkedOut(this.state, sessionId)
    if (current !== undefined) {
      this.released = undefined
      this.set(pop(this.state, current.id))
      return
    }
    const released = this.released
    if (released !== undefined && released.sessionId === sessionId && this.now() - released.at <= RELEASE_GRACE_MS) {
      this.released = undefined
      this.set(pop(this.state, released.entryId))
    }
  }

  /**
   * A watcher mounted with the checkout's session: after the persisted draft
   * had time to seed, an empty composer means the checkout is stale (cleared
   * before a reload) — end it so the next send does not pop the wrong entry.
   */
  reconcile(sessionId: string): void {
    const current = checkedOut(this.state, sessionId)
    if (current === undefined) return
    const draft = this.drafts.get(sessionId) ?? ''
    if (isBlank(draft)) this.set(release(this.state, sessionId))
    else this.seenText = true
  }

  /** The session a chord addresses: the focused composer's, else the last registered. */
  targetSession(active: Element | null = document.activeElement): ComposerHandle | undefined {
    const composer = active?.closest('[data-composer-input]') ?? null
    if (composer !== null && this.handles.size > 1) {
      // The dock marker and the composer share the session's conversation
      // subtree: the handle whose marker's nearest common ancestor with the
      // composer is deepest wins.
      let best: ComposerHandle | undefined
      let bestDepth = -1
      for (const handle of this.handles.values()) {
        const marker = handle.marker()
        if (marker === null) continue
        let node: Element | null = marker
        let depth = 0
        while (node !== null && !node.contains(composer)) { node = node.parentElement; depth += 1 }
        if (node === null) continue
        const ancestorDepth = depthOf(node)
        if (ancestorDepth > bestDepth) { bestDepth = ancestorDepth; best = handle }
      }
      if (best !== undefined) return best
    }
    const last = this.order[this.order.length - 1]
    return last === undefined ? undefined : this.handles.get(last)
  }

  private origin(handle: ComposerHandle) {
    return { sessionId: handle.sessionId, sessionTitle: handle.sessionTitle() }
  }

  // ---- chords ----

  /** Ctrl+S. */
  stash(handle: ComposerHandle | undefined = this.targetSession()): ChordOutcome {
    if (handle === undefined) return 'no-session'
    if (this.busy.get(handle.sessionId) === true) return 'busy'
    const draft = this.drafts.get(handle.sessionId) ?? ''
    const result = push(this.state, draft, this.origin(handle), this.now())
    if (result.kind === 'blank') return 'blank'
    this.released = undefined
    this.set(result.state)
    handle.setDraft('')
    return 'pushed'
  }

  /** Ctrl+R. */
  cycle(handle: ComposerHandle | undefined = this.targetSession()): ChordOutcome {
    if (handle === undefined) return 'no-session'
    if (this.busy.get(handle.sessionId) === true) return 'busy'
    const draft = this.drafts.get(handle.sessionId) ?? ''
    const result = cycle(this.state, draft, this.origin(handle), this.now())
    this.set(result.state)
    if (result.kind === 'nothing') return 'nothing'
    this.applyCheckout(handle, result.entry)
    return 'checkout'
  }

  /** "Restore" from the stash view. */
  restore(entryId: string, sessionId: string | undefined = this.view.sessionId): ChordOutcome {
    const handle = sessionId === undefined ? this.targetSession() : (this.handles.get(sessionId) ?? this.targetSession())
    if (handle === undefined) return 'no-session'
    if (this.busy.get(handle.sessionId) === true) return 'busy'
    const draft = this.drafts.get(handle.sessionId) ?? ''
    const result = restore(this.state, entryId, draft, this.origin(handle), this.now())
    this.set(result.state)
    if (result.kind === 'nothing') return 'nothing'
    this.applyCheckout(handle, result.entry)
    return 'checkout'
  }

  private applyCheckout(handle: ComposerHandle, entry: StashEntry): void {
    this.released = undefined
    // The draft we are about to write is the checkout's text: a blank seen
    // before the editor adopted it must not count as "cleared by hand".
    this.seenText = false
    handle.setDraft(entry.text)
  }

  /** Delete from the stash view (never a send). */
  drop(entryId: string): void {
    this.set(pop(this.state, entryId))
  }

  clearAll(): void {
    this.set(clear())
  }

  // ---- view ----

  openView(sessionId: string | undefined = this.targetSession()?.sessionId): void {
    this.view = { open: true, sessionId }
    this.notify()
  }

  closeView(): void {
    if (!this.view.open) return
    this.view = { open: false, sessionId: undefined }
    this.notify()
  }
}

function depthOf(node: Element): number {
  let depth = 0
  for (let current: Element | null = node; current !== null; current = current.parentElement) depth += 1
  return depth
}

/**
 * The stash model: a pure, ordered list of stashed messages plus one optional
 * CHECKOUT — the entry currently sitting in a session's composer.
 *
 * Ordering: index 0 is the TOP (the most recently pushed entry). Ctrl+S pushes
 * to the top; Ctrl+R takes the top into the composer and sends whatever was
 * there to the BOTTOM, so repeated Ctrl+R walks the whole stash as a ring and
 * comes back around.
 *
 * A checked-out entry stays in the list until it is actually SENT (the caller
 * observes the send and calls `pop`). Ctrl+R / Ctrl+S on a checked-out entry
 * write the composer's current text back into it first, so edits made while
 * cycling are kept. Clearing the composer by hand ends the checkout and leaves
 * the entry as it was (see `release`).
 *
 * Every operation returns a new state; nothing here touches the DOM or storage.
 */

export interface StashEntry {
  readonly id: string
  /** Message text as it will be put back into the composer. */
  readonly text: string
  readonly createdAt: number
  readonly updatedAt: number
  /** Session the text was stashed from (for the list view; may be gone). */
  readonly sessionId?: string
  readonly sessionTitle?: string
}

export interface Checkout {
  readonly entryId: string
  readonly sessionId: string
}

export interface StashState {
  readonly entries: readonly StashEntry[]
  readonly checkout?: Checkout
}

/** Where a stashed text came from. */
export interface Origin {
  readonly sessionId: string
  readonly sessionTitle?: string
}

export const EMPTY: StashState = { entries: [] }

/** Normalize composer text for storage: the editor's trailing paragraph "\n" goes, blank means nothing. */
export function normalizeText(text: string): string {
  return text.replace(/\n$/u, '')
}

/** True when there is nothing worth stashing. */
export function isBlank(text: string): boolean {
  return text.trim() === ''
}

let counter = 0
/** A locally unique id (time-based; ids never leave the browser). */
export function newId(now = Date.now()): string {
  counter = (counter + 1) % 10_000
  return `${now.toString(36)}-${counter.toString(36)}`
}

/** The checked-out entry of one session, if any. */
export function checkedOut(state: StashState, sessionId: string): StashEntry | undefined {
  if (state.checkout === undefined || state.checkout.sessionId !== sessionId) return undefined
  return state.entries.find(entry => entry.id === state.checkout!.entryId)
}

function without(entries: readonly StashEntry[], id: string): StashEntry[] {
  return entries.filter(entry => entry.id !== id)
}

/**
 * Write the composer's current text into the checked-out entry of `sessionId`
 * (no-op when the session has no checkout or the text is blank — a blank
 * composer never overwrites a stashed message).
 */
function writeBack(state: StashState, sessionId: string, text: string, now: number): StashState {
  const current = checkedOut(state, sessionId)
  if (current === undefined || isBlank(text)) return state
  const clean = normalizeText(text)
  if (clean === current.text) return state
  return {
    ...state,
    entries: state.entries.map(entry => entry.id === current.id ? { ...entry, text: clean, updatedAt: now } : entry),
  }
}

export type PushResult =
  | { readonly kind: 'pushed'; readonly state: StashState; readonly entry: StashEntry }
  | { readonly kind: 'blank' }

/**
 * Ctrl+S: put the composer text on top of the stash. A checked-out entry is
 * updated in place (with the current text) and moved to the top instead of
 * being duplicated; either way the checkout ends because the composer is
 * about to be cleared.
 */
export function push(state: StashState, text: string, origin: Origin, now = Date.now()): PushResult {
  if (isBlank(text)) return { kind: 'blank' }
  const clean = normalizeText(text)
  const current = checkedOut(state, origin.sessionId)
  if (current !== undefined) {
    const updated: StashEntry = { ...current, text: clean, updatedAt: now }
    return {
      kind: 'pushed',
      entry: updated,
      state: { entries: [updated, ...without(state.entries, current.id)] },
    }
  }
  const entry: StashEntry = {
    id: newId(now),
    text: clean,
    createdAt: now,
    updatedAt: now,
    sessionId: origin.sessionId,
    sessionTitle: origin.sessionTitle,
  }
  return {
    kind: 'pushed',
    entry,
    state: { entries: [entry, ...state.entries], checkout: state.checkout },
  }
}

export type CycleResult =
  /** Put `entry.text` into the composer; the entry is now checked out. */
  | { readonly kind: 'checkout'; readonly state: StashState; readonly entry: StashEntry }
  /** Nothing to cycle to (empty stash, or the only entry is already in the composer). */
  | { readonly kind: 'nothing'; readonly state: StashState }

/**
 * Ctrl+R: bring the next stashed message into the composer.
 *
 * - Composer holds a checked-out entry: write the edits back, move that entry
 *   to the bottom, check out the new top.
 * - Composer holds unstashed text: that text becomes a new entry at the
 *   bottom (nothing is lost), then the top is checked out.
 * - Composer empty: the top is checked out.
 */
export function cycle(state: StashState, text: string, origin: Origin, now = Date.now()): CycleResult {
  const current = checkedOut(state, origin.sessionId)
  let entries: StashEntry[]
  if (current !== undefined) {
    const written = writeBack(state, origin.sessionId, text, now)
    const updated = written.entries.find(entry => entry.id === current.id)!
    entries = [...without(written.entries, current.id), updated]
    if (entries.length === 1) {
      return { kind: 'nothing', state: { entries, checkout: state.checkout } }
    }
  } else if (!isBlank(text)) {
    if (state.entries.length === 0) return { kind: 'nothing', state }
    const parked: StashEntry = {
      id: newId(now),
      text: normalizeText(text),
      createdAt: now,
      updatedAt: now,
      sessionId: origin.sessionId,
      sessionTitle: origin.sessionTitle,
    }
    entries = [...state.entries, parked]
  } else {
    if (state.entries.length === 0) return { kind: 'nothing', state }
    entries = [...state.entries]
  }
  const top = entries[0]!
  return {
    kind: 'checkout',
    entry: top,
    state: { entries, checkout: { entryId: top.id, sessionId: origin.sessionId } },
  }
}

/**
 * Restore one chosen entry (from the list view) into a session's composer.
 * The composer's current content is preserved the same way `cycle` does it:
 * a checked-out entry gets the edits written back, unstashed text is pushed
 * to the top.
 */
export function restore(state: StashState, entryId: string, text: string, origin: Origin, now = Date.now()): CycleResult {
  const target = state.entries.find(entry => entry.id === entryId)
  if (target === undefined) return { kind: 'nothing', state }
  let next = state
  const current = checkedOut(state, origin.sessionId)
  if (current !== undefined) {
    next = writeBack(state, origin.sessionId, text, now)
    if (current.id === entryId) {
      return { kind: 'nothing', state: next }
    }
  } else if (!isBlank(text)) {
    const pushed = push(state, text, origin, now)
    if (pushed.kind === 'pushed') next = pushed.state
  }
  const entry = next.entries.find(candidate => candidate.id === entryId)!
  return {
    kind: 'checkout',
    entry,
    state: { entries: next.entries, checkout: { entryId, sessionId: origin.sessionId } },
  }
}

/** Remove an entry (sent, or deleted from the list view). */
export function pop(state: StashState, entryId: string): StashState {
  const entries = without(state.entries, entryId)
  if (entries.length === state.entries.length) return state
  const checkout = state.checkout?.entryId === entryId ? undefined : state.checkout
  return checkout === undefined ? { entries } : { entries, checkout }
}

/** End a session's checkout without touching the entry (the composer was cleared by hand). */
export function release(state: StashState, sessionId: string): StashState {
  if (state.checkout === undefined || state.checkout.sessionId !== sessionId) return state
  return { entries: state.entries }
}

/** Drop everything. */
export function clear(): StashState {
  return EMPTY
}

// ---- persistence codec -------------------------------------------------------

const VERSION = 1

interface Stored {
  readonly version: number
  readonly entries: readonly StashEntry[]
  readonly checkout?: Checkout
}

/** Serialize for localStorage. */
export function encode(state: StashState): string {
  const stored: Stored = { version: VERSION, entries: state.entries, checkout: state.checkout }
  return JSON.stringify(stored)
}

function isEntry(value: unknown): value is StashEntry {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.id === 'string' && typeof v.text === 'string'
    && typeof v.createdAt === 'number' && typeof v.updatedAt === 'number'
}

/** Parse what `encode` wrote; anything unreadable yields the empty stash. */
export function decode(raw: string | null): StashState {
  if (raw === null || raw === '') return EMPTY
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return EMPTY
    const stored = parsed as Partial<Stored>
    if (stored.version !== VERSION || !Array.isArray(stored.entries)) return EMPTY
    const entries = stored.entries.filter(isEntry)
    const checkout = stored.checkout
    if (checkout !== undefined && typeof checkout === 'object' && checkout !== null
      && typeof checkout.entryId === 'string' && typeof checkout.sessionId === 'string'
      && entries.some(entry => entry.id === checkout.entryId)) {
      return { entries, checkout: { entryId: checkout.entryId, sessionId: checkout.sessionId } }
    }
    return { entries }
  } catch {
    // Corrupt JSON in localStorage: start over rather than fail the plugin.
    return EMPTY
  }
}

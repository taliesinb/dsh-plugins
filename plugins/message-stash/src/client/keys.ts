/**
 * Chord recognition for the stash keys. Literal Ctrl on every platform (the
 * user asked for Ctrl; on macOS ⌘S / ⌘R stay the browser's), no other
 * modifiers, no auto-repeat.
 *
 *   Ctrl+S        push the composer text onto the stash
 *   Ctrl+S, S     a second Ctrl+S within the double-tap window opens the stash view
 *   Ctrl+R        cycle: next stashed message into the composer
 */

/** Default double-tap window; Settings → General overrides it (0 = off). */
export const DOUBLE_TAP_MS = 1000

/** The choices offered in Settings, in ms; 0 disables the double tap. */
export const DOUBLE_TAP_CHOICES = [300, 500, 750, 1000, 1500, 2000, 0] as const

export type Chord = 'stash' | 'cycle'

function ctrlOnly(event: KeyboardEvent): boolean {
  return event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !event.repeat
}

/** Which stash chord `event` is, if any. `code` covers non-Latin layouts. */
export function chordOf(event: KeyboardEvent): Chord | undefined {
  if (!ctrlOnly(event)) return undefined
  const key = event.key.toLowerCase()
  if (key === 's' || event.code === 'KeyS') return 'stash'
  if (key === 'r' || event.code === 'KeyR') return 'cycle'
  return undefined
}

/**
 * Double-tap detector for Ctrl+S: `tap(now)` returns true on the second of
 * two taps within the window (and resets, so a third tap starts over).
 * `interrupt()` is called for any other key so "Ctrl+S, type, Ctrl+S" is two
 * single taps. The window can change at any time (Settings); 0 or less
 * disables the double tap.
 */
export class DoubleTap {
  private last: number | undefined
  private windowMs: number

  constructor(windowMs = DOUBLE_TAP_MS) {
    this.windowMs = windowMs
  }

  setWindow(ms: number): void {
    this.windowMs = ms
    this.last = undefined
  }

  tap(now: number): boolean {
    if (this.windowMs <= 0) return false
    const double = this.last !== undefined && now - this.last <= this.windowMs
    this.last = double ? undefined : now
    return double
  }

  interrupt(): void {
    this.last = undefined
  }
}

/**
 * Whether a stash chord may act given what has keyboard focus. The chords
 * act from the composer (`[data-composer-input]`) and from anywhere that is
 * not a text field; another input, textarea or editable region keeps its own
 * Ctrl+S / Ctrl+R.
 */
export function focusAllows(active: Element | null): boolean {
  if (active === null || active === document.body) return true
  if (active.closest('[data-composer-input]') !== null) return true
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return false
  if (active instanceof HTMLElement && active.isContentEditable) return false
  return true
}

/**
 * Keyboard for a confirm dialog built on the shipped `Modal`: **Enter fires
 * the default action** — the primary `Button` marked `{...DIALOG_DEFAULT}` —
 * and Escape the Modal already turns into `onClose`.
 *
 * Why: the shipped Modal neither moves focus into the dialog nor handles
 * Enter, so Enter went to whatever had focus before it opened (the composer,
 * after a slash command) and visibly did nothing. On open this hook moves
 * focus to the default button — or, while that is disabled, to the dialog
 * card itself — and puts focus back where it was when the dialog closes.
 *
 * Tab / Shift+Tab stay inside the dialog (the shipped Modal has no focus
 * trap: Tab used to walk the sidebar's session rows behind the mask). The
 * default button gets the house focus ring (`2px solid
 * --dsw-alias-state-business-primary`, as the shipped toolbars draw it)
 * instead of the browser's `outline: auto`, which WebKit clipped at the bottom
 * of the capsule.
 *
 * Enter is left alone where it already means something: a focused button or
 * link (the browser clicks it — no double fire), a textarea / contenteditable
 * inside the dialog (newline), a menu / listbox row, an open shipped `Menu`
 * popup, an IME composition, and any handler that already called
 * `preventDefault` (inputs with their own Enter → confirm). Shift/Alt/Ctrl
 * opt out; plain Enter and ⌘Enter confirm. A disabled default button means
 * Enter does nothing, exactly like a click.
 *
 * Identical copies live in every plugin with such a dialog (each bundles its
 * own client half, cross-plugin runtime imports are forbidden) — keep them in
 * sync: reboot-command, import-api-keys, import-sessions, dsh-remote-workspaces.
 */
import { useEffect, useRef } from 'react'

/** Spread onto the ONE primary `Button` of the dialog: `<Button variant="primary" {...DIALOG_DEFAULT}>`. */
export const DIALOG_DEFAULT = { 'data-dialog-default': '' } as const

const DIALOG = '[role="dialog"][aria-modal="true"]'
const DEFAULT_BUTTON = 'button[data-dialog-default]'
/** What Tab may land on inside the dialog (visibility is checked at use). */
const FOCUSABLE = 'button, a[href], input, select, textarea, summary, [tabindex]'
const STYLE_ID = 'dsh-dialog-keys-style'
/** Own ring for the default button: the UA `outline: auto` ring was clipped on the capsule in WebKit. */
const STYLE = `${DEFAULT_BUTTON}:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #3b82f6); outline-offset: 2px; }\n`
  + `${DIALOG}:focus { outline: none; }`
/** Focus here owns Enter natively or semantically; the hook stays out of the way. */
const OWNS_ENTER = 'button, a[href], textarea, select, summary, [role="button"], [role="menuitem"], [role="option"], [role="menu"], [role="listbox"], [role="combobox"]'

/** The topmost modal dialog in the document (portaled last = on top). */
function topDialog(): HTMLElement | undefined {
  const all = document.querySelectorAll<HTMLElement>(DIALOG)
  return all[all.length - 1]
}

/** Inject the ring style once per document (every plugin copy shares the id). */
function ensureStyle(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLE
  document.head.appendChild(style)
}

/** Tab stops inside the dialog, in DOM order: enabled, rendered, not opted out. */
function tabStops(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el =>
    !el.hasAttribute('disabled') && el.tabIndex >= 0 && el.getAttribute('aria-hidden') !== 'true' && el.offsetParent !== null)
}

/**
 * Wire Enter → default action and focus management for the dialog this
 * component renders while `open`. `stage` re-runs the focus pull when the
 * dialog's content changes underneath (multi-step flows, a swapped Modal).
 */
export function useDialogDefaultAction(open: boolean, stage?: unknown): void {
  const restore = useRef<Element | null>(null)

  // Remember what had focus before the dialog and give it back on close/unmount.
  useEffect(() => {
    if (!open) return
    restore.current = document.activeElement
    return () => {
      const before = restore.current
      restore.current = null
      const active = document.activeElement
      if (before instanceof HTMLElement && before.isConnected && (active === null || active === document.body)) {
        before.focus({ preventScroll: true })
      }
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const dialog = topDialog()
    if (dialog === undefined) return
    ensureStyle()

    // Pull focus into the dialog unless something inside it already has it.
    // Retried over the next ~200 ms: a dialog opened from a slash command races
    // the command popup's settle path, whose Lexical `editor.focus()` lands
    // asynchronously AFTER this effect and would otherwise take the keyboard
    // back to the composer behind the mask.
    const pull = (): void => {
      const active = document.activeElement
      if (active !== null && active !== document.body && dialog.contains(active) && active !== dialog) return
      const button = dialog.querySelector<HTMLButtonElement>(DEFAULT_BUTTON)
      if (button !== null && !button.disabled) {
        button.focus({ preventScroll: true })
      } else if (active !== dialog) {
        if (!dialog.hasAttribute('tabindex')) dialog.tabIndex = -1
        dialog.focus({ preventScroll: true })
      }
    }
    pull()
    const timers = [0, 50, 200].map(ms => setTimeout(pull, ms))

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return
      if (!dialog.isConnected || topDialog() !== dialog) return
      // A shipped Menu popup (portaled, transient) is open: its keys are its own.
      if (document.querySelector('[role="menu"]') !== null) return

      if (event.key === 'Tab') {
        // Focus trap, owning the step entirely: native Tab would leave the
        // dialog (and Safari without Full Keyboard Access skips buttons, so it
        // even jumps from the last input straight out to the composer).
        event.preventDefault()
        const stops = tabStops(dialog)
        if (stops.length === 0) return
        const index = stops.indexOf(document.activeElement as HTMLElement)
        const next = index < 0
          ? (event.shiftKey ? stops.length - 1 : 0)
          : (index + (event.shiftKey ? -1 : 1) + stops.length) % stops.length
        stops[next]!.focus()
        return
      }

      if (event.key !== 'Enter') return
      if (event.altKey || event.ctrlKey || event.shiftKey) return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target !== null) {
        if (target.closest(OWNS_ENTER) !== null) return
        if (dialog.contains(target) && target.isContentEditable) return
      }
      const action = dialog.querySelector<HTMLButtonElement>(DEFAULT_BUTTON)
      if (action === null || action.disabled) return
      event.preventDefault()
      action.click()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      for (const timer of timers) clearTimeout(timer)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, stage])
}

/**
 * Live sidebar preview: while a blank New Session's draft starts with a slug,
 * the selected "New Session" row shows the slug instead.
 *
 * WHY DOM PATCHING — the Workspace browser (ui-workspace Rows.tsx) renders a
 * blank row as `node.blank ? t('session.new') : node.title`, and the host
 * keeps `blank` true until the first `turn/start`. So neither renaming the
 * blank session nor any store write can change that label: the label is a
 * locale constant while blank. The browser fills `sidebar.workspaces`, a
 * `single` slot (replacing the whole browser for one label is out of
 * proportion), and locale namespaces have exactly one owner (re-registering
 * `workspace.session.new` throws). The remaining seam is the row's DOM.
 *
 * WHAT IS PATCHED — the selected session row (`[role="treeitem"]
 * [aria-selected="true"]`) whose direct `_title` span has no sibling `_time`
 * span: blank rows omit the time cell and the row actions (Rows.tsx: "both
 * trailing cells stay off until the first prompt"), and only the CURRENT
 * blank session is ever listed (tree.ts). CSS-module classes are built as
 * `[hash]_[local]`, so `[class$="_title"]` is stable across rebuilds.
 *
 * SAFETY — the original label is kept in `data-tdsnOrig`; the written slug in
 * `data-tdsnSlug`. Restore only happens when the span still shows exactly the
 * slug we wrote: once the prompt is accepted the row re-renders with the real
 * title (React sets textContent because the string prop changed), and a
 * blind restore would clobber it. A MutationObserver re-applies after the
 * row remounts (folding a workspace, sidebar re-open).
 */

const ROW_SELECTOR = '[role="treeitem"][aria-selected="true"]'
const TITLE_SELECTOR = ':scope > span[class$="_title"]'
const TIME_SELECTOR = ':scope > span[class$="_time"]'

interface PreviewState {
  slug: string | undefined
}

function blankRowTitleSpans(): HTMLElement[] {
  const out: HTMLElement[] = []
  for (const row of document.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    if (row.querySelector(TIME_SELECTOR) !== null) continue
    const title = row.querySelector<HTMLElement>(TITLE_SELECTOR)
    if (title !== null) out.push(title)
  }
  return out
}

function applyTo(span: HTMLElement, slug: string): void {
  if (span.dataset.tdsnSlug === slug && span.textContent === slug) return
  if (span.dataset.tdsnOrig === undefined) span.dataset.tdsnOrig = span.textContent ?? ''
  span.dataset.tdsnSlug = slug
  span.textContent = slug
}

function restore(span: HTMLElement): void {
  const written = span.dataset.tdsnSlug
  if (written === undefined) return
  if (span.textContent === written) span.textContent = span.dataset.tdsnOrig ?? ''
  delete span.dataset.tdsnSlug
  delete span.dataset.tdsnOrig
}

/**
 * Install the preview patcher.
 * @returns setter + disposer. `set(undefined)` restores every patched label.
 */
export function installPreview(): { set: (slug: string | undefined) => void; dispose: () => void } {
  const state: PreviewState = { slug: undefined }
  let frame: number | undefined

  const sync = (): void => {
    frame = undefined
    // Restore anything we patched that is no longer a blank selected row or
    // whose slug changed, then apply to the current blank row.
    for (const span of document.querySelectorAll<HTMLElement>('span[data-tdsn-slug]')) {
      if (state.slug === undefined || span.dataset.tdsnSlug !== state.slug) restore(span)
    }
    if (state.slug === undefined) return
    for (const span of blankRowTitleSpans()) applyTo(span, state.slug)
  }
  const schedule = (): void => {
    if (frame !== undefined) return
    frame = window.requestAnimationFrame(sync)
  }

  // Re-apply after React remounts the row (fold/unfold, sidebar toggles).
  // Our own writes also fire the observer; `applyTo` is idempotent, so the
  // second pass is a no-op.
  const observer = new MutationObserver(() => {
    if (state.slug !== undefined || document.querySelector('span[data-tdsn-slug]') !== null) schedule()
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })

  return {
    set: (slug) => {
      if (slug === state.slug) return
      state.slug = slug
      schedule()
    },
    dispose: () => {
      observer.disconnect()
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      state.slug = undefined
      for (const span of document.querySelectorAll<HTMLElement>('span[data-tdsn-slug]')) restore(span)
    },
  }
}

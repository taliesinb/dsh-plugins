/**
 * Ghost rows: keep a typed-into New Session reachable after switching away.
 *
 * WHY — the Workspace browser lists a blank session only while it is the
 * CURRENT one (tree.ts: `!session.blank || session.id === current`). Select
 * another session and the "New Session" row vanishes, although the blank
 * session still exists on the host (New Session reuses it) and its draft is
 * persisted per session (ui-conversation's conversation store,
 * `persist: 'dsh.conversation'` → localStorage key `dsh.conversation.<id>`,
 * value `{ draft, view, viewRequest }`). So the only thing missing is a row.
 *
 * WHAT — for every session in the Sessions list that is blank, not current
 * and whose persisted draft is non-empty, insert a dimmed row right under its
 * Workspace header (where the real blank row sorts), labelled with the
 * draft's slug or the localized New Session label. Click/Enter opens it via
 * `sessions.open(id)`; the real blank row then takes over and the ghost is
 * removed. A blank session with an empty draft never gets a ghost — there is
 * nothing to return to.
 *
 * HOW (DOM, same seam as preview.ts) — the browser fills the `single`
 * `sidebar.workspaces` slot and offers no per-row slot. Each ghost is a
 * cloneNode of a real session row (so it inherits the CSS-module classes for
 * geometry/hover) with the selection/drag/menu artefacts stripped, marked
 * `data-tdsn-ghost="<sessionId>"`. React never touches foreign siblings it
 * did not create; when it remounts the group section the ghost goes with it
 * and the MutationObserver re-inserts. Reconciliation is idempotent so the
 * observer's echo of our own writes settles in one pass.
 *
 * Workspace headers are matched by title text (WorkspaceView.title); rows
 * carry no ids in the DOM. Only the grouped (per-Workspace) list is
 * supported; the flat list variant shows no ghosts.
 */

import { parseSlug } from './slug.ts'

/** Mirror of ui-conversation's CONVERSATION_STORE_KEY (stores.ts). */
const CONVERSATION_STORE_KEY = 'dsh.conversation'

const GHOST_ATTR = 'data-tdsn-ghost'
const GHOST_OPACITY = '0.5'

/** One session the browser knows about (subset of SessionSummary). */
export interface GhostSessionRow {
  id: string
  blank: boolean
  cwd?: string | undefined
}

/** One Workspace (subset of WorkspaceView). */
export interface GhostWorkspace {
  workspaceId: string
  title: string
  path: string
  sessionIds: readonly string[]
}

/** Inputs the reconciler needs from the data layer. */
export interface GhostInputs {
  sessions: readonly GhostSessionRow[]
  current: string | undefined
  workspaces: readonly GhostWorkspace[]
}

/** One row to render. */
interface Ghost {
  sessionId: string
  workspaceTitle: string
  label: string
}

/**
 * Read the persisted composer draft of any session (current or not).
 * @param sessionId - session whose conversation store to read.
 * @returns the draft text, or '' when nothing usable is stored.
 */
export function readPersistedDraft(sessionId: string): string {
  if (typeof localStorage === 'undefined') return ''
  try {
    const raw = localStorage.getItem(`${CONVERSATION_STORE_KEY}.${sessionId}`)
    if (raw === null) return ''
    const stored: unknown = JSON.parse(raw)
    if (typeof stored !== 'object' || stored === null || !('draft' in stored)) return ''
    return typeof stored.draft === 'string' ? stored.draft : ''
  } catch {
    return ''
  }
}

/** The localized "New Session" label, read off the sidebar's own button; English fallback. */
function newSessionLabel(): string {
  const label = document.querySelector('[class$="_newSessionLabel"]')?.textContent?.trim()
  return label !== undefined && label !== '' ? label : 'New Session'
}

/**
 * Decide which ghosts should exist. Pure apart from localStorage reads.
 * @param inputs - list, current selection, Workspaces.
 * @param drafts - draft reader (injectable for tests).
 * @returns ghosts in list order.
 */
export function deriveGhosts(
  inputs: GhostInputs,
  drafts: (sessionId: string) => string = readPersistedDraft,
  fallbackLabel = 'New Session',
): Ghost[] {
  const out: Ghost[] = []
  for (const session of inputs.sessions) {
    if (!session.blank || session.id === inputs.current) continue
    const draft = drafts(session.id)
    if (draft.trim() === '') continue
    const workspace = inputs.workspaces.find(w => w.sessionIds.includes(session.id))
      ?? (session.cwd === undefined ? undefined : inputs.workspaces.find(w => w.path === session.cwd))
    if (workspace === undefined) continue
    out.push({ sessionId: session.id, workspaceTitle: workspace.title, label: parseSlug(draft) ?? fallbackLabel })
  }
  return out
}

/**
 * A row's HoverCard wrapper: rows (header and session alike) are rendered
 * inside HoverCard's block wrapper div, which is what the group section
 * actually lays out (inter-row spacing lives between wrappers). Detected
 * structurally — the wrapper holds exactly that one row (plus any ghost we
 * parked there earlier) — because ui-primitives hashes its CSS-module classes
 * differently (`_root_<hash>_<n>`) from the `[hash]_[local]` shell pattern.
 */
function wrapperOf(row: HTMLElement): HTMLElement | undefined {
  const parent = row.parentElement
  if (parent === null || parent.getAttribute('role') === 'tree') return undefined
  const ownRows = [...parent.children].filter(child => !child.hasAttribute(GHOST_ATTR))
  return ownRows.length === 1 && ownRows[0] === row ? parent : undefined
}

/**
 * Expanded Workspace header ANCHORS keyed by visible title: the element the
 * ghost is inserted after (the header's wrapper when it has one).
 */
function headersByTitle(): Map<string, HTMLElement> {
  const map = new Map<string, HTMLElement>()
  for (const header of document.querySelectorAll<HTMLElement>('[role="tree"] [role="treeitem"][aria-expanded="true"]')) {
    const title = header.querySelector('span[class$="_title"]')?.textContent?.trim()
    if (title === undefined || map.has(title)) continue
    map.set(title, wrapperOf(header) ?? header)
  }
  return map
}

/** A real session row to clone for classes/geometry (never one of ours). */
function templateRow(): HTMLElement | undefined {
  for (const row of document.querySelectorAll<HTMLElement>('[role="treeitem"][aria-selected]')) {
    if (row.closest(`[${GHOST_ATTR}]`) === null) return row
  }
  return undefined
}

/** Class tokens that encode transient row state and must not survive the clone. */
const STRIP_CLASS_SUFFIXES = ['_selected', '_menuOpen', '_dropBefore', '_dropAfter']

function buildGhost(template: HTMLElement, ghost: Ghost, open: (sessionId: string) => void): HTMLElement {
  const el = template.cloneNode(true) as HTMLElement
  for (const token of [...el.classList]) {
    if (STRIP_CLASS_SUFFIXES.some(suffix => token.endsWith(suffix))) el.classList.remove(token)
  }
  el.setAttribute('aria-selected', 'false')
  el.removeAttribute('draggable')
  el.removeAttribute('id')
  el.tabIndex = 0
  el.style.opacity = GHOST_OPACITY
  el.title = ghost.label
  // Keep the leading status slot (title alignment) but empty it; keep the
  // title span; drop time, actions and anything else.
  let keptSlot = false
  for (const child of [...el.children]) {
    const cls = child.className
    if (!keptSlot && typeof cls === 'string' && /_slot(\s|$)/u.test(cls)) {
      child.replaceChildren()
      keptSlot = true
      continue
    }
    if (typeof cls === 'string' && cls.endsWith('_title')) {
      child.textContent = ghost.label
      continue
    }
    child.remove()
  }
  const activate = (event: Event): void => {
    event.preventDefault()
    event.stopPropagation()
    open(ghost.sessionId)
  }
  el.addEventListener('click', activate)
  el.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') activate(event)
  })
  // Real rows sit inside HoverCard's block wrapper, and the group section
  // spaces WRAPPERS; a bare row would lose that spacing and shift the rows
  // below it. Clone the template's wrapper (shallow) so the ghost is laid
  // out exactly like its neighbours.
  const templateWrapper = wrapperOf(template)
  const outer = templateWrapper === undefined ? el : (templateWrapper.cloneNode(false) as HTMLElement)
  if (outer !== el) {
    outer.removeAttribute('id')
    outer.replaceChildren(el)
  }
  outer.setAttribute(GHOST_ATTR, ghost.sessionId)
  return outer
}

/**
 * Install the ghost-row reconciler.
 * @param open - select a session as current (`sessions.open`).
 * @returns `update(inputs)` to feed fresh data and `dispose()`.
 */
export function installGhosts(open: (sessionId: string) => void): {
  update: (inputs: GhostInputs) => void
  dispose: () => void
} {
  let inputs: GhostInputs = { sessions: [], current: undefined, workspaces: [] }
  let frame: number | undefined

  const sync = (): void => {
    frame = undefined
    const wanted = deriveGhosts(inputs, readPersistedDraft, newSessionLabel())
    const wantedById = new Map(wanted.map(g => [g.sessionId, g]))
    const headers = headersByTitle()

    // Remove ghosts that are no longer wanted, mislabelled or misplaced.
    for (const el of document.querySelectorAll<HTMLElement>(`[${GHOST_ATTR}]`)) {
      const id = el.getAttribute(GHOST_ATTR) ?? ''
      const ghost = wantedById.get(id)
      const header = ghost === undefined ? undefined : headers.get(ghost.workspaceTitle)
      const titleEl = el.querySelector('span[class$="_title"]')
      const placed = header !== undefined && el.previousElementSibling === header
      if (ghost === undefined || !placed || titleEl?.textContent !== ghost.label) el.remove()
    }
    // Insert the missing ones.
    let template: HTMLElement | undefined
    for (const ghost of wanted) {
      if (document.querySelector(`[${GHOST_ATTR}="${ghost.sessionId}"]`) !== null) continue
      const header = headers.get(ghost.workspaceTitle)
      if (header === undefined) continue
      template ??= templateRow()
      if (template === undefined) return
      header.insertAdjacentElement('afterend', buildGhost(template, ghost, open))
    }
  }
  const schedule = (): void => {
    if (frame !== undefined) return
    frame = window.requestAnimationFrame(sync)
  }

  const observer = new MutationObserver(schedule)
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-expanded', 'aria-selected'],
  })
  // Same-tab localStorage writes fire no `storage` event; drafts are re-read
  // on every sync, and the list snapshot changes whenever selection moves.
  window.addEventListener('storage', schedule)

  return {
    update: (next) => {
      inputs = next
      schedule()
    },
    dispose: () => {
      observer.disconnect()
      window.removeEventListener('storage', schedule)
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      for (const el of document.querySelectorAll(`[${GHOST_ATTR}]`)) el.remove()
    },
  }
}

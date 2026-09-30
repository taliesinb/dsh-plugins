/**
 * The tree navigator: one component drawing a family as an indented tree
 * (root first, every branch under its source, labelled by the turn it left
 * at and the first line of its edited prompt), mounted twice — behind a
 * branch-icon button in the Session header (popover) and as the body of the
 * `branches` right-sidebar tab.
 */
import { useEffect, useRef, useState } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconBranchOutline16, Tooltip, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { treeRows, type Family } from '../../shared/branches.mjs'
import type { FamilyState } from './families.ts'

export interface BranchTreeInjected {
  hooks: { family: ObservableSnapshot<FamilyState> }
  ensureFamily(): void
  refreshFamily(): void
  switchTo(sessionId: string): void
  /** Open the tree in the right sidebar; absent when the sidebar is not mounted (embed page). */
  openSidebarTab?: (() => void) | undefined
}

/** Titles of the sessions the tree names, from the session list. */
type Titles = Readonly<Record<string, string | undefined>>

export function BranchTreeView({ family, state, currentId, titles, onOpen }: {
  family: Family | undefined
  state: FamilyState
  currentId: string
  titles: Titles
  onOpen: (sessionId: string) => void
}) {
  if (family === undefined) {
    if (state.error !== undefined) return <div className="mb-treeError">{state.error}</div>
    return <div className="mb-treeEmpty">{state.loading ? 'Loading…' : 'No branches'}</div>
  }
  const rows = treeRows(family)
  if (rows.length <= 1) return <div className="mb-treeEmpty">No branches yet</div>
  return (
    <div className="mb-tree" role="tree">
      {rows.map(({ member, depth }) => {
        const current = member.id === currentId
        const title = titles[member.id] ?? member.id
        const preview = member.parent === null ? undefined : member.previews[String(member.firstOwnTurn)]
        return (
          <button key={member.id} type="button" role="treeitem" aria-selected={current} aria-level={depth + 1}
            className="mb-treeRow" data-current={current || undefined} style={{ '--mb-depth': depth } as never}
            onClick={() => { if (!current) onOpen(member.id) }}>
            <span className="mb-treeIndent" />
            {depth > 0 && <span className="mb-treeGuide" aria-hidden="true">└</span>}
            <span className="mb-currentDot" data-off={current ? undefined : ''} />
            <span className="mb-treeMain">
              <span className="mb-treeTitle">{title}</span>
              {member.parent !== null && (
                <span className="mb-treeMeta">
                  <b>#{member.firstOwnTurn}</b>{preview === undefined || preview === '' ? '' : ` · ${preview}`}
                </span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function useTitles(useSessions: PropsRuntime<'conversation.session.header.utilities'>['useSessions'], family: Family | undefined): Titles {
  return useSessions((list) => {
    const out: Record<string, string | undefined> = {}
    if (family === undefined) return out
    for (const id of Object.keys(family.members)) out[id] = list.byId[id as keyof typeof list.byId]?.displayTitle
    return out
  }, (a, b) => {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    return ka.length === kb.length && ka.every(k => a[k] === b[k])
  })
}

type HeaderProps = PropsRuntime<'conversation.session.header.utilities'> & InjectFace<BranchTreeInjected>

/** Header utility: branch icon (with the member count when > 1) opening the tree popover. */
export function BranchHeaderAction({ sessionId, useSessions, useFamily, ensureFamily, refreshFamily, switchTo, openSidebarTab }: HeaderProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement | null>(null)
  useDismissOnOutsidePointer(root, open, setOpen)
  useEffect(() => { ensureFamily() }, [ensureFamily])
  useEffect(() => { if (open) refreshFamily() }, [open, refreshFamily])
  const state = useFamily(s => s)
  const family = state.family
  const titles = useTitles(useSessions, family)
  const count = family === undefined ? 0 : Object.keys(family.members).length
  return (
    <div ref={root} className="mb-headerRoot" data-mb-header>
      <Tooltip label="Branches of this conversation" side="bottom" delayMs={500} disabled={open}>
        <button type="button" className="mb-headerButton" aria-label="Branches" aria-expanded={open} aria-haspopup="dialog"
          onClick={() => { setOpen(!open) }}>
          <IconBranchOutline16 />
          {count > 1 && <span className="mb-headerBadge">{count}</span>}
        </button>
      </Tooltip>
      {open && (
        <div className="mb-popover mb-headerPopover" role="dialog" aria-label="Branches">
          <div className="mb-popoverTitle">Branches</div>
          <BranchTreeView family={family} state={state} currentId={sessionId} titles={titles}
            onOpen={(id) => { setOpen(false); switchTo(id) }} />
          {openSidebarTab !== undefined && (
            <div className="mb-popoverFooter">
              <button type="button" className="mb-linkButton" onClick={() => { setOpen(false); openSidebarTab() }}>Open in sidebar</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

type TabProps = PropsRuntime<'sidebar.right.pane.tab'> & InjectFace<BranchTreeInjected>

/** Body of the `branches` right-sidebar tab. */
export function BranchTabBody({ sessionId, useSessions, useFamily, ensureFamily, refreshFamily, switchTo }: TabProps) {
  useEffect(() => { ensureFamily(); refreshFamily() }, [ensureFamily, refreshFamily])
  const state = useFamily(s => s)
  const family = state.family
  const titles = useTitles(useSessions as HeaderProps['useSessions'], family)
  return (
    <div className="mb-treePane" data-mb-tab>
      <BranchTreeView family={family} state={state} currentId={sessionId} titles={titles} onOpen={switchTo} />
    </div>
  )
}

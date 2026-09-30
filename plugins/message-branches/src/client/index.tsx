/**
 * tali-message-branches — browser half.
 *
 * Registrations:
 *   • `conversation.chat.node` key `user` (priority −10, shadowing the shipped
 *     bubble): the same bubble plus Edit, the ‹ i/n › version switcher and the
 *     versions list — src/client/UserMessage.tsx.
 *   • `conversation.session.header.utilities`: the branch icon + tree popover.
 *   • right-sidebar tab kind `branches` (id `tali-message-branches`) with the
 *     same tree as its body — when the sidebar is mounted.
 *
 * Choreography of one edit (submitEdit): POST the edit to the host (fork +
 * prompt, index.js) → adopt the child in this client's session list
 * (`sessions.create({ sessionId })`, the same synchronous-addressability the
 * shipped fork relies on) → rename it "<parent title> (n)" → open it → refetch
 * the family so every member's switcher shows the new version.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-file-upload/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { branchTitle } from '../../shared/branches.mjs'
import { postEdit, type ApiResult, type EditRequest } from './api.ts'
import { FamilyCache } from './families.ts'
import { BranchHeaderAction, BranchTabBody, type BranchTreeInjected } from './BranchTree.tsx'
import { UserMessageView, type UserMessageInjected } from './UserMessage.tsx'
import { CSS, STYLE_ID } from './styles.ts'

export const inject = ['slots', 'sessions', 'uiWorkspace']

const TAB_ID = 'tali-message-branches'
const TAB_KIND = 'branches'

/**
 * Mount the plugin's browser contributions.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    document.getElementById(STYLE_ID)?.remove()
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    document.head.append(style)
    return () => { style.remove() }
  }, 'message-branches: stylesheet')

  const families = new FamilyCache()

  // A sibling created in another tab, or a session removed, changes the list's
  // membership: re-read the families on screen.
  ctx.effect(() => {
    const keyOf = () => {
      const list = ctx.sessions.list.getSnapshot()
      return `${list.ids.length}:${Object.keys(list.byId).length}`
    }
    let last = keyOf()
    return ctx.sessions.list.subscribe(() => {
      const next = keyOf()
      if (next === last) return
      last = next
      families.refreshAll()
    })
  }, 'message-branches: list membership watch')

  const switchTo = (sessionId: string): void => { ctx.uiWorkspace.openSession(sessionId as SessionId) }

  /** Sidebar opener, set while the sidebar sub-fiber is alive. */
  const sidebar: { open?: () => void } = {}

  async function submitEdit(sessionId: string, input: Omit<EditRequest, 'sessionId'>): Promise<ApiResult<string>> {
    const result = await postEdit({ sessionId, ...input })
    if (!result.ok) return result
    const childId = result.value as SessionId
    families.invalidate()
    const list = ctx.sessions.list.getSnapshot()
    const parent = list.byId[sessionId as SessionId]
    try {
      await ctx.sessions.create({ sessionId: childId, ...(parent?.cwd === undefined ? {} : { cwd: parent.cwd }) })
    } catch (error) {
      // The host already resumed the child; the list frame brings it in regardless.
      console.warn('[message-branches] adopting the branch locally failed:', error)
    }
    const parentTitle = parent?.title
    if (parentTitle !== undefined && parentTitle !== '') {
      const siblingTitles = Object.values(list.byId)
        .filter(summary => summary.parentId === sessionId && summary.title !== undefined)
        .map(summary => summary.title as string)
      const title = branchTitle(parentTitle, siblingTitles)
      const reference = ctx.sessions.retain(childId, { source: 'controllerOperation' })
      try {
        await reference.ready
        const renamed = await reference.binding.session.rename(title)
        if (!renamed.ok) console.warn('[message-branches] branch rename failed:', renamed.error)
      } catch (error) {
        console.warn('[message-branches] branch rename failed:', error)
      } finally {
        reference.release()
      }
    }
    switchTo(childId)
    void families.ensure(childId, true)
    return { ok: true, value: childId }
  }

  async function uploadFile(sessionId: string, file: File): Promise<ApiResult<{ receiptId: string }>> {
    const service = ctx.get('fileUpload')
    if (service === undefined) return { ok: false, error: 'file upload service unavailable' }
    const result = await service.upload(sessionId as SessionId, file, file.name)
    if (!result.ok) return { ok: false, error: `${result.error.code}: ${result.error.message}` }
    return { ok: true, value: { receiptId: String(result.value.receiptId) } }
  }

  const userInject = (sessionId: SessionId): UserMessageInjected => ({
    hooks: { family: families.source(sessionId) },
    ensureFamily: () => { void families.ensure(sessionId) },
    switchTo,
    submitEdit: input => submitEdit(sessionId, input),
    uploadFile: file => uploadFile(sessionId, file),
  })

  const treeInject = (sessionId: SessionId): BranchTreeInjected => ({
    hooks: { family: families.source(sessionId) },
    ensureFamily: () => { void families.ensure(sessionId) },
    refreshFamily: () => { void families.ensure(sessionId, true) },
    switchTo,
    openSidebarTab: () => { sidebar.open?.() },
  })

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'user',
    priority: -10,
    inject: userInject,
  }, UserMessageView))

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'message-branches-tree',
    order: 40,
    inject: treeInject,
  }, BranchHeaderAction))

  ctx.inject(['sidebarRightTabs', 'sidebarRight'], (ctx) => {
    ctx.effect(() => ctx.sidebarRightTabs.register({
      id: TAB_ID,
      kind: TAB_KIND,
      title: () => 'Branches',
      guide: [{ id: 'branches', order: 60, title: () => 'Branches' }],
    }), 'message-branches: sidebar tab type')
    ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: TAB_ID,
      inject: treeInject,
    }, BranchTabBody))
    ctx.effect(() => {
      sidebar.open = () => { ctx.sidebarRight.openTab(TAB_KIND) }
      return () => { delete sidebar.open }
    }, 'message-branches: sidebar opener')
  })
}

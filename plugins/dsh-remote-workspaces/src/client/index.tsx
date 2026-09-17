/**
 * Browser half of dsh-remote-workspaces. Registers:
 *   - `sidebar.workspaces.extra`         the "Remotes" section (fork seat)
 *   - `main` key `remote-session`        the host box the visible frame covers
 *   - `shell.overlay`                    the iframe pool + the add-remote modal
 *
 * Selecting a remote session selects our main panel; the local shell's own
 * `openSession` resets the panel to the Conversation, which hides the pool
 * without destroying it (frames die after 10 minutes hidden, see store.ts).
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only merges: ctx.slots / ctx.layout / the fork's ui-workspace seats.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { createApi } from './api.ts'
import { PANEL_ID, RemoteWorkspacesModel, type RemoteSelection } from './store.ts'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { IconGlobeOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { AddRemoteModal, FramePool, MoveRemoteDialog, RemoteSessionPanel, RemotesSection, type RemoteInjected } from './ui.tsx'

export const inject = ['slots', 'connection', 'layout']

export function apply(ctx: Context): void {
  const rpc = (ctx as unknown as { connection: { rpc: ClientConnectionRpc } }).connection.rpc
  const api = createApi(rpc)
  const model = new RemoteWorkspacesModel(api)

  const openRemoteSession = (selection: RemoteSelection): void => {
    model.select(selection)
    try {
      ctx.layout.selectPanel(PANEL_ID as MainPanelId)
    } catch (error) {
      console.warn('[remote-workspaces] main panel not registered yet', error)
    }
  }

  const localWorkspaces = (): readonly { workspaceId: string; title: string; path: string }[] => {
    const workspaces = ctx.get('workspaces') as IWorkspaces | undefined
    return workspaces?.list.getSnapshot().items.map(item => ({ workspaceId: item.workspaceId, title: item.title, path: item.path })) ?? []
  }

  const injected = (): RemoteInjected => ({
    model,
    api,
    openRemoteSession,
    localWorkspaces,
    hooks: { view: model.view, runtime: model.runtime },
  })

  // "Move to remote…" on every local session row (the shell's own "Move to…"
  // covers local destinations); the shared dialog then lists the remotes.
  ctx.inject(['uiWorkspace'], (scoped) => {
    scoped.effect(() => scoped.uiWorkspace.contributeSessionMenu({
      id: 'remote-workspaces.move-to-remote',
      label: 'Move to remote…',
      icon: <IconGlobeOutline14 />,
      order: 10,
      when: () => (model.runtime.getSnapshot().snapshot?.workspaces.length ?? 0) > 0,
      run: (target) => { model.openMove({ sessionId: target.sessionId, title: target.title, source: { local: true } }) },
    }), 'remote-workspaces: local session menu contribution')
  })

  // The "Remotes" section (its own header carries add + refresh-all; nothing
  // is added to the Workspaces header).
  ctx.effect(() => ctx.slots.inject('sidebar.workspaces.extra', () => ctx.slots.register({
    name: 'sidebar.workspaces.extra', id: 'remote-workspaces.section', order: 10, inject: injected,
  }, RemotesSection)), 'remote-workspaces: section')

  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PANEL_ID, inject: injected,
  }, RemoteSessionPanel)), 'remote-workspaces: main panel')

  ctx.effect(() => ctx.slots.inject('shell.overlay', function* () {
    yield ctx.slots.register({ name: 'shell.overlay', id: 'remote-workspaces.frames', order: 5, inject: injected }, FramePool)
    yield ctx.slots.register({ name: 'shell.overlay', id: 'remote-workspaces.add-modal', order: 50, inject: injected }, AddRemoteModal)
    yield ctx.slots.register({ name: 'shell.overlay', id: 'remote-workspaces.move-dialog', order: 51, inject: injected }, MoveRemoteDialog)
  }), 'remote-workspaces: overlay')

  void model.refresh().then(() => {
    // Reload parity with the local shell, which restores its current Session:
    // if the remote panel was what the operator last looked at, bring it back.
    const view = model.view.getSnapshot()
    if (view.remoteActive === true && view.selected !== undefined && model.workspace(view.selected.workspaceId) !== undefined) {
      openRemoteSession(view.selected)
    }
  })
}

/**
 * Browser state of the remote-workspaces UI: the host snapshot (servers +
 * mirrored workspaces with cached sessions), per-workspace poll state, which
 * remote session is selected, and the iframe pool.
 *
 * Two stores: the persisted view (expansion + selection survive reloads, like
 * the local sidebar's) and the transient runtime state.
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteApi, RemoteWorkspace, StatusSnapshot } from './api.ts'

export interface RemoteSelection {
  workspaceId: string
  sessionId: string
}

/** How the Remotes section arranges rows (mirrors the local tree's View options). */
export type RemoteGroupBy = 'workspace' | 'server' | 'flat'
export type RemoteOrderBy = 'manual' | 'updated' | 'created'

/** Poll cadence for every mirrored workspace while a view needs them all current. */
export const FLAT_POLL_INTERVAL_MS = 60_000

export interface ViewState {
  /** Expanded remote workspaces; absent = collapsed (no network until opened). */
  expanded: Record<string, boolean>
  /** Expanded server groups (server view); absent = expanded. */
  serverExpanded?: Record<string, boolean>
  groupBy?: RemoteGroupBy
  orderBy?: RemoteOrderBy
  selected?: RemoteSelection
  /** Whether the remote panel (not a local Conversation) was the last thing shown; restored on reload. */
  remoteActive?: boolean
}

export interface FrameEntry {
  key: string
  workspaceId: string
  sessionId: string
  /** `/remote/<server>/?embed=<session>` */
  src: string
  /** Epoch ms when the frame stopped being the visible one; null while shown. */
  hiddenSince: number | null
  lastShownAt: number
}

export interface RuntimeState {
  /** Open "Move to…" request (remote session, or a local session heading to a remote). */
  moveRequest?: MoveRequest | undefined
  snapshot: StatusSnapshot | undefined
  loaded: boolean
  loadError?: string
  /** Workspace ids with a poll in flight. */
  polling: string[]
  /** Workspace ids with a start-session in flight. */
  starting: string[]
  errors: Record<string, string>
  frames: FrameEntry[]
  addOpen: boolean
}

/** Frames hidden longer than this are destroyed. */
export const FRAME_HIDDEN_TTL_MS = 10 * 60 * 1000
/** Live frames at most; each owns a WebSocket to its remote. */
export const FRAME_CAP = 4
/** Keyed main panel this plugin registers for the visible frame. */
export const PANEL_ID = 'remote-session'

export function frameKey(selection: RemoteSelection): string {
  return `${selection.workspaceId}:${selection.sessionId}`
}

/** What the move dialog is deciding about. */
export interface MoveRequest {
  sessionId: string
  title: string
  /** Where the session lives now. */
  source: { local: true } | { local?: false; workspaceId: string }
  /** Preselected destination, when the request came from a drop. */
  destinationId?: string | undefined
}

export class RemoteWorkspacesModel {
  readonly view: SnapshotStore<ViewState>
  readonly runtime: SnapshotStore<RuntimeState>

  constructor(private readonly api: RemoteApi) {
    this.view = createSnapshotStore<ViewState>({ expanded: {} }, { persist: { name: 'dsh.remote-workspaces.view' } })
    this.runtime = createSnapshotStore<RuntimeState>({
      snapshot: undefined, loaded: false, polling: [], starting: [], errors: {}, frames: [], addOpen: false,
    })
  }

  // ---- host snapshot -------------------------------------------------------

  async refresh(): Promise<void> {
    try {
      const snapshot = await this.api.status()
      const first = !this.runtime.getSnapshot().loaded
      this.runtime.update((d) => { d.snapshot = snapshot; d.loaded = true; delete d.loadError })
      // First load: the groups the operator left open show their cached
      // sessions with spinners while each is re-polled (collapsed ones stay quiet).
      if (first) {
        const expanded = this.view.getSnapshot().expanded
        for (const workspace of snapshot.workspaces) if (expanded[workspace.id] === true) void this.poll(workspace.id)
      }
    } catch (error) {
      this.runtime.update((d) => { d.loaded = true; d.loadError = error instanceof Error ? error.message : String(error) })
    }
  }

  private putWorkspace(workspace: RemoteWorkspace): void {
    this.runtime.update((d) => {
      if (d.snapshot === undefined) return
      const index = d.snapshot.workspaces.findIndex(candidate => candidate.id === workspace.id)
      if (index === -1) d.snapshot.workspaces.push(workspace)
      else d.snapshot.workspaces[index] = workspace
      delete d.errors[workspace.id]
    })
  }

  workspace(id: string): RemoteWorkspace | undefined {
    return this.runtime.getSnapshot().snapshot?.workspaces.find(candidate => candidate.id === id)
  }

  // ---- polling -------------------------------------------------------------

  async poll(id: string): Promise<void> {
    if (this.runtime.getSnapshot().polling.includes(id)) return
    this.runtime.update((d) => { d.polling.push(id); delete d.errors[id] })
    try {
      this.putWorkspace(await this.api.pollWorkspace(id))
    } catch (error) {
      this.runtime.update((d) => { d.errors[id] = error instanceof Error ? error.message : String(error) })
    } finally {
      this.runtime.update((d) => { d.polling = d.polling.filter(candidate => candidate !== id) })
    }
  }

  setExpanded(id: string, expanded: boolean): void {
    this.view.update((d) => { d.expanded[id] = expanded })
    if (expanded) void this.poll(id)
  }

  isExpanded(id: string): boolean {
    return this.view.getSnapshot().expanded[id] === true
  }

  // ---- selection + frames --------------------------------------------------

  /**
   * Follow-up polls for the selected remote workspace. The framed page is a
   * separate document with no channel back to us, so the sidebar learns about
   * a session's first turn (title, activity) only by asking the remote: a few
   * quick polls right after a selection catch the typical "open, type, send"
   * sequence, then a slow cadence while the remote panel stays active.
   */
  private followUp: ReturnType<typeof setTimeout>[] = []
  private followUpInterval: ReturnType<typeof setInterval> | undefined
  private scheduleFollowUp(workspaceId: string): void {
    this.cancelFollowUp()
    for (const delay of [12_000, 40_000, 90_000]) {
      this.followUp.push(setTimeout(() => { void this.poll(workspaceId) }, delay))
    }
    this.followUpInterval = setInterval(() => {
      if (this.view.getSnapshot().remoteActive !== true) return
      void this.poll(workspaceId)
    }, 120_000)
  }
  private cancelFollowUp(): void {
    for (const timer of this.followUp.splice(0)) clearTimeout(timer)
    if (this.followUpInterval !== undefined) { clearInterval(this.followUpInterval); this.followUpInterval = undefined }
  }

  /** Select a remote session: ensure its frame exists and mark it shown. */
  select(selection: RemoteSelection): void {
    const workspace = this.workspace(selection.workspaceId)
    const base = workspace?.server?.localBase
    if (base === undefined) return
    this.scheduleFollowUp(selection.workspaceId)
    const key = frameKey(selection)
    const now = Date.now()
    this.view.update((d) => { d.selected = selection; d.remoteActive = true })
    this.runtime.update((d) => {
      const existing = d.frames.find(frame => frame.key === key)
      if (existing === undefined) {
        d.frames.push({
          key, workspaceId: selection.workspaceId, sessionId: selection.sessionId,
          src: `${base}?embed=${encodeURIComponent(selection.sessionId)}`, hiddenSince: null, lastShownAt: now,
        })
      } else {
        existing.hiddenSince = null
        existing.lastShownAt = now
      }
      for (const frame of d.frames) if (frame.key !== key && frame.hiddenSince === null) frame.hiddenSince = now
      // Cap: evict the least recently shown hidden frames.
      while (d.frames.length > FRAME_CAP) {
        const victims = d.frames.filter(frame => frame.key !== key).sort((a, b) => a.lastShownAt - b.lastShownAt)
        const victim = victims[0]
        if (victim === undefined) break
        d.frames = d.frames.filter(frame => frame.key !== victim.key)
      }
    })
  }

  /** The visible frame left the screen (another panel or a local session took over). */
  hideAll(): void {
    const now = Date.now()
    this.runtime.update((d) => {
      for (const frame of d.frames) if (frame.hiddenSince === null) frame.hiddenSince = now
    })
    if (this.view.getSnapshot().remoteActive === true) this.view.update((d) => { d.remoteActive = false })
  }

  /** The selected frame is on screen again. */
  showSelected(): void {
    const selected = this.view.getSnapshot().selected
    if (selected !== undefined) this.select(selected)
  }

  /** Destroy frames hidden past the TTL and frames whose session left the cache. */
  sweep(now = Date.now()): void {
    this.runtime.update((d) => {
      d.frames = d.frames.filter(frame => frame.hiddenSince === null || now - frame.hiddenSince < FRAME_HIDDEN_TTL_MS)
    })
  }

  dropFrame(key: string): void {
    this.runtime.update((d) => { d.frames = d.frames.filter(frame => frame.key !== key) })
  }

  clearSelection(): void {
    this.cancelFollowUp()
    this.view.update((d) => { delete d.selected; d.remoteActive = false })
  }

  // ---- mutations -----------------------------------------------------------

  async startSession(workspaceId: string): Promise<RemoteSelection | undefined> {
    if (this.runtime.getSnapshot().starting.includes(workspaceId)) return undefined
    this.runtime.update((d) => { d.starting.push(workspaceId); delete d.errors[workspaceId] })
    try {
      const { sessionId } = await this.api.startSession(workspaceId)
      return { workspaceId, sessionId }
    } catch (error) {
      this.runtime.update((d) => { d.errors[workspaceId] = error instanceof Error ? error.message : String(error) })
      return undefined
    } finally {
      this.runtime.update((d) => { d.starting = d.starting.filter(candidate => candidate !== workspaceId) })
    }
  }

  async renameSession(workspaceId: string, sessionId: string, title: string): Promise<void> {
    this.putWorkspace(await this.api.renameSession(workspaceId, sessionId, title))
  }

  async archiveSession(workspaceId: string, sessionId: string): Promise<void> {
    this.putWorkspace(await this.api.archiveSession(workspaceId, sessionId))
    const key = frameKey({ workspaceId, sessionId })
    this.dropFrame(key)
    if (this.view.getSnapshot().selected?.sessionId === sessionId) this.clearSelection()
  }

  /** Refresh every mirrored workspace (the section's refresh-all). */
  pollAll(): void {
    for (const workspace of this.runtime.getSnapshot().snapshot?.workspaces ?? []) void this.poll(workspace.id)
  }

  /** Optimistic local reorder of the groups, then persist. */
  async reorderWorkspaces(ids: string[]): Promise<void> {
    this.runtime.update((d) => {
      if (d.snapshot === undefined) return
      const byId = new Map(d.snapshot.workspaces.map(workspace => [workspace.id, workspace]))
      const ordered = ids.flatMap(id => (byId.has(id) ? [byId.get(id)!] : []))
      const rest = d.snapshot.workspaces.filter(workspace => !ids.includes(workspace.id))
      d.snapshot.workspaces = [...ordered, ...rest].map((workspace, order) => ({ ...workspace, order }))
    })
    const snapshot = await this.api.reorderWorkspaces(ids)
    this.runtime.update((d) => { d.snapshot = snapshot })
  }

  /** Optimistic local reorder of one group's sessions, then persist. */
  async reorderSessions(workspaceId: string, ids: string[]): Promise<void> {
    this.runtime.update((d) => {
      const workspace = d.snapshot?.workspaces.find(candidate => candidate.id === workspaceId)
      if (workspace === undefined) return
      const byId = new Map(workspace.cache.sessions.map(session => [session.id, session]))
      workspace.cache.sessions = [
        ...ids.flatMap(id => (byId.has(id) ? [byId.get(id)!] : [])),
        ...workspace.cache.sessions.filter(session => !ids.includes(session.id)),
      ]
    })
    this.putWorkspace(await this.api.reorderSessions(workspaceId, ids))
  }

  async renameWorkspace(id: string, title: string): Promise<void> {
    const snapshot = await this.api.renameWorkspace(id, title)
    this.runtime.update((d) => { d.snapshot = snapshot })
  }

  async removeWorkspace(id: string): Promise<void> {
    const snapshot = await this.api.removeWorkspace(id)
    this.runtime.update((d) => {
      d.snapshot = snapshot
      d.frames = d.frames.filter(frame => frame.workspaceId !== id)
    })
    if (this.view.getSnapshot().selected?.workspaceId === id) this.clearSelection()
  }

  async addWorkspace(input: Parameters<RemoteApi['addWorkspace']>[0]): Promise<RemoteWorkspace> {
    const workspace = await this.api.addWorkspace(input)
    await this.refresh()
    this.putWorkspace(workspace)
    this.view.update((d) => { d.expanded[workspace.id] = true })
    return workspace
  }

  setGroupBy(groupBy: RemoteGroupBy): void {
    this.view.update((d) => { d.groupBy = groupBy })
  }

  setOrderBy(orderBy: RemoteOrderBy): void {
    this.view.update((d) => { d.orderBy = orderBy })
  }

  setServerExpanded(serverId: string, expanded: boolean): void {
    this.view.update((d) => { d.serverExpanded = { ...d.serverExpanded, [serverId]: expanded } })
  }

  openMove(request: MoveRequest | undefined): void {
    this.runtime.update((d) => { d.moveRequest = request })
  }

  async moveSession(input: Parameters<RemoteApi['moveSession']>[0]): Promise<void> {
    this.putWorkspace(await this.api.moveSession(input))
    const from = this.workspace(input.fromWorkspaceId)
    if (from !== undefined) await this.poll(from.id)
    this.dropFrame(frameKey({ workspaceId: input.fromWorkspaceId, sessionId: input.sessionId }))
    if (this.view.getSnapshot().selected?.sessionId === input.sessionId) this.clearSelection()
  }

  async transferSession(input: Parameters<RemoteApi['transferSession']>[0]): Promise<Awaited<ReturnType<RemoteApi['transferSession']>>> {
    const result = await this.api.transferSession(input)
    if (input.source.local !== true) {
      this.dropFrame(frameKey({ workspaceId: input.source.workspaceId, sessionId: input.sessionId }))
      if (this.view.getSnapshot().selected?.sessionId === input.sessionId) this.clearSelection()
      await this.poll(input.source.workspaceId)
    }
    if (input.destination.local !== true) await this.poll(input.destination.workspaceId)
    return result
  }

  setAddOpen(open: boolean): void {
    this.runtime.update((d) => { d.addOpen = open })
  }
}

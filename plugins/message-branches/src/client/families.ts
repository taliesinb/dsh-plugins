/**
 * Client-side cache of family trees, one observable snapshot per session.
 *
 * Every session maps to the family it belongs to (root + fork descendants).
 * The host answer is cached by root; a session's snapshot is the family
 * object itself (stable reference until a refetch replaces it), so components
 * bound through the inject `hooks` compartment re-render only on change.
 * Refetch triggers: first use of a session, an explicit invalidation (after an
 * edit), and the session list changing shape (a sibling created in another
 * tab, a session deleted).
 */
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { Family } from '../../shared/branches.mjs'
import { fetchFamily } from './api.ts'

export interface FamilyState {
  /** The family, or undefined until the first answer (or after a failure with no earlier answer). */
  readonly family: Family | undefined
  readonly loading: boolean
  readonly error: string | undefined
}

interface CacheState {
  readonly byRoot: Readonly<Record<string, Family>>
  readonly rootOf: Readonly<Record<string, string>>
  readonly loading: Readonly<Record<string, boolean>>
  readonly error: Readonly<Record<string, string>>
}

const EMPTY: FamilyState = { family: undefined, loading: false, error: undefined }

/** How long an answer stays fresh before a new `ensure` re-reads it. */
const FRESH_MS = 15_000

export class FamilyCache {
  private readonly store = createSnapshotStore<CacheState>({ byRoot: {}, rootOf: {}, loading: {}, error: {} })
  private readonly fetchedAt = new Map<string, number>()
  private readonly inflight = new Map<string, Promise<void>>()
  private readonly sources = new Map<string, ObservableSnapshot<FamilyState>>()
  private readonly snapshots = new Map<string, FamilyState>()
  private readonly settleAttempts = new Map<string, number>()

  /** Observable family state of one session (identity-stable per session id). */
  source(sessionId: string): ObservableSnapshot<FamilyState> {
    let source = this.sources.get(sessionId)
    if (source === undefined) {
      source = {
        getSnapshot: () => this.snapshotOf(sessionId),
        subscribe: listener => this.store.subscribe(listener),
      }
      this.sources.set(sessionId, source)
    }
    return source
  }

  /** The current family of one session, when known. */
  familyOf(sessionId: string): Family | undefined {
    const state = this.store.getSnapshot()
    const root = state.rootOf[sessionId]
    return root === undefined ? undefined : state.byRoot[root]
  }

  /** Fetch the session's family unless a fresh answer exists; concurrent calls share one request. */
  ensure(sessionId: string, force = false): Promise<void> {
    const at = this.fetchedAt.get(sessionId)
    if (!force && at !== undefined && Date.now() - at < FRESH_MS) return Promise.resolve()
    const running = this.inflight.get(sessionId)
    if (running !== undefined) return running
    const task = this.load(sessionId).finally(() => { this.inflight.delete(sessionId) })
    this.inflight.set(sessionId, task)
    return task
  }

  /** Forget freshness for every session: the next `ensure` re-reads. Known families stay visible meanwhile. */
  invalidate(): void {
    this.fetchedAt.clear()
    this.settleAttempts.clear()
  }

  /** Re-read every family currently displayed (after the session list changed). */
  refreshAll(): void {
    this.invalidate()
    for (const sessionId of Object.keys(this.store.getSnapshot().rootOf)) void this.ensure(sessionId, true)
  }

  private async load(sessionId: string): Promise<void> {
    this.store.update((draft) => {
      (draft.loading as Record<string, boolean>)[sessionId] = true
    })
    const result = await fetchFamily(sessionId)
    this.store.update((draft) => {
      const loading = draft.loading as Record<string, boolean>
      const error = draft.error as Record<string, string>
      const rootOf = draft.rootOf as Record<string, string>
      const byRoot = draft.byRoot as Record<string, Family>
      delete loading[sessionId]
      if (!result.ok) {
        error[sessionId] = result.error
        return
      }
      delete error[sessionId]
      const family = result.value
      byRoot[family.root] = family
      for (const id of Object.keys(family.members)) rootOf[id] = family.root
      // A session that left the family (moved/deleted) keeps pointing at the
      // old root until its own next ensure; harmless.
    })
    const now = Date.now()
    if (!result.ok) {
      this.fetchedAt.set(sessionId, now)
      return
    }
    for (const id of Object.keys(result.value.members)) this.fetchedAt.set(id, now)
    // A branch whose own prompt has not landed yet (the edit's turn opens a
    // moment after the fork) has no preview: poll a few times until it does.
    const family = result.value
    const unsettled = Object.values(family.members)
      .some(member => member.parent !== null && member.previews[String(member.firstOwnTurn)] === undefined)
    const attempts = this.settleAttempts.get(family.root) ?? 0
    if (unsettled && attempts < 6) {
      this.settleAttempts.set(family.root, attempts + 1)
      window.setTimeout(() => { void this.ensure(sessionId, true) }, 1500)
    } else if (!unsettled) {
      this.settleAttempts.delete(family.root)
    }
  }

  private snapshotOf(sessionId: string): FamilyState {
    const state = this.store.getSnapshot()
    const root = state.rootOf[sessionId]
    const family = root === undefined ? undefined : state.byRoot[root]
    const loading = state.loading[sessionId] === true
    const error = state.error[sessionId]
    const previous = this.snapshots.get(sessionId)
    if (previous !== undefined && previous.family === family && previous.loading === loading && previous.error === error) return previous
    const next: FamilyState = family === undefined && !loading && error === undefined ? EMPTY : { family, loading, error }
    this.snapshots.set(sessionId, next)
    return next
  }
}

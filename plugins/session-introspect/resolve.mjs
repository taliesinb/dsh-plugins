/**
 * resolve.mjs — session addressing and corpus access over `ctx.sessionQuery`.
 *
 * Accepted `session` spellings (one resolver for every tool):
 *   tensatory/interval-slider-proto   <workspace basename>/<title>   (exact → prefix → substring, case-insensitive)
 *   interval-slider                   bare title, all workspaces
 *   session-2b81 | 2b810855           id or id prefix
 *   @[label](dsh-session:…) | dsh-session:…   canonical mention (base64url id)
 *   latest:tensatory                  newest session of a workspace
 *   self | (omitted)                  the calling agent's own session
 *
 * Titles are read the cheap way first — the live projection registry for an
 * attached session, the persisted projection cache (storages/session_projcache)
 * for a cold one — and folded from the full log (`readTitleSnapshots`) only for
 * sessions no projection can answer. Nothing here touches ~/.dsh paths.
 */

import { buildModel, workspaceOf } from './model.mjs'
import { IntrospectError } from './output.mjs'

const TITLE_TTL_LIVE_MS = 15_000
const TITLE_TTL_COLD_MS = 10 * 60_000
const SNAPSHOT_TTL_LIVE_MS = 10_000
const SNAPSHOT_TTL_COLD_MS = 5 * 60_000

/**
 * @param {any} ctx - plugin Context with `sessionQuery`
 * @param {{ scope: 'all' | 'workspace', trace?: (line: object) => void }} options
 */
export function createResolver(ctx, options) {
  const trace = options.trace ?? (() => {})
  const titles = new Map() // id → { title, at, live }
  const snapshots = new Map() // id → { snapshot, at, live }

  /** Cheap title: live projection → persisted projection cache → predecessor checkpoint. */
  function cheapTitle(record) {
    const id = record.header.id
    try {
      const sessions = ctx.get('sessions')
      const projections = ctx.get('sessionProjections')
      const attached = sessions?.get(id)
      if (attached !== undefined && projections !== undefined) {
        const t = projections.snapshot(attached, ['title'])?.values?.title
        if (t) return t.title ?? (typeof t === 'string' ? t : undefined)
      }
      const cache = ctx.get('sessionProjectionCache')
      if (cache !== undefined && record.header.isSeeded !== true) {
        const snap = cache.cachedSnapshot(record.header, 0, ['title']) ?? cache.cachedPredecessorTitle?.(record.header, 0)
        const t = snap?.values?.title
        if (t) return t.title ?? (typeof t === 'string' ? t : undefined)
      }
    } catch (error) {
      trace({ event: 'cheap-title-failed', id, error: String(error) })
    }
    return undefined
  }

  /** Titles for records, folding from the log only where needed. */
  async function titlesFor(records, signal) {
    const now = Date.now()
    const out = new Map()
    const missing = []
    for (const record of records) {
      const id = record.header.id
      const cached = titles.get(id)
      if (cached && now - cached.at < (cached.live ? TITLE_TTL_LIVE_MS : TITLE_TTL_COLD_MS)) { out.set(id, cached.title); continue }
      const cheap = cheapTitle(record)
      if (cheap !== undefined) { titles.set(id, { title: cheap, at: now, live: record.live }); out.set(id, cheap); continue }
      missing.push(record)
    }
    if (missing.length > 0) {
      trace({ event: 'title-fold', count: missing.length })
      const results = await ctx.sessionQuery.readTitleSnapshots(missing.map(r => r.header.id), signal)
      for (const result of results) {
        const record = missing.find(r => r.header.id === result.sessionId)
        const title = result.status === 'fulfilled' ? (result.value.title?.title ?? null) : null
        titles.set(result.sessionId, { title, at: now, live: record?.live ?? false })
        out.set(result.sessionId, title)
      }
    }
    return out
  }

  /**
   * Every visible session as `{ record, id, cwd, workspace, title, createdAt, live }`, newest first.
   * @param {{ callerCwd?: string }} [opts]
   */
  async function listAll(opts = {}, signal) {
    let records = await ctx.sessionQuery.listSessions(signal)
    if (options.scope === 'workspace') {
      records = records.filter(r => r.header.cwd !== undefined && r.header.cwd === opts.callerCwd)
    }
    const titleMap = await titlesFor(records, signal)
    return records.map(record => ({
      record,
      id: record.header.id,
      cwd: record.header.cwd,
      workspace: workspaceOf(record.header.cwd),
      title: titleMap.get(record.header.id) ?? null,
      createdAt: record.header.createdAt,
      live: record.live === true,
      parent: record.header.parentSession ?? null,
      depth: record.header.delegationDepth ?? 0,
    })).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  }

  function callerId(exec) { return exec?.agent?.session?.id ?? exec?.agent?.id }
  function callerCwd(exec) { return exec?.agent?.session?.header?.cwd }

  /**
   * Resolve one `session` spec to a listing entry.
   * @returns {Promise<Awaited<ReturnType<typeof listAll>>[number]>}
   */
  async function resolve(spec, exec, signal) {
    const raw = spec === undefined || spec === null ? '' : String(spec).trim()
    const all = await listAll({ callerCwd: callerCwd(exec) }, signal)
    const byId = (id) => all.find(e => e.id === id)

    if (raw === '' || raw === 'self' || raw === 'me') {
      const id = callerId(exec)
      const me = id ? byId(id) : undefined
      if (!me) throw new IntrospectError('No calling session to inspect; pass session explicitly.')
      return me
    }

    // canonical mention / URI
    const mention = /dsh-session:([A-Za-z0-9_-]+)/.exec(raw)
    if (mention) {
      const id = Buffer.from(mention[1], 'base64url').toString('utf8')
      const hit = byId(id)
      if (!hit) throw new IntrospectError(`Mention refers to session "${id}", which is not visible.`)
      return hit
    }

    // latest:<workspace>
    const latest = /^latest(?::(.*))?$/i.exec(raw)
    if (latest) {
      const ws = (latest[1] ?? '').trim().toLowerCase()
      const pool = ws === '' ? all : all.filter(e => e.workspace.toLowerCase() === ws)
      const me = callerId(exec)
      const pick = pool.find(e => e.id !== me) ?? pool[0]
      if (!pick) throw new IntrospectError(`No sessions in workspace "${ws}".`, { hint: `Known workspaces: ${workspaces(all).join(', ')}.` })
      return pick
    }

    // id or id prefix
    const exact = byId(raw)
    if (exact) return exact
    const idPrefix = raw.toLowerCase()
    const prefixHits = all.filter(e => e.id.toLowerCase().startsWith(idPrefix) || e.id.toLowerCase().replace(/^session-/, '').startsWith(idPrefix.replace(/^session-/, '')))
    if (prefixHits.length === 1 && /^(session-)?[0-9a-f]{4,}/i.test(raw)) return prefixHits[0]
    if (prefixHits.length > 1 && /^(session-)?[0-9a-f]{4,}/i.test(raw)) throw ambiguous(raw, prefixHits)

    // workspace/title or bare title
    let ws = null
    let titleQ = raw
    const slash = raw.indexOf('/')
    if (slash > 0) { ws = raw.slice(0, slash).trim().toLowerCase(); titleQ = raw.slice(slash + 1).trim() }
    const pool = ws === null ? all : all.filter(e => e.workspace.toLowerCase() === ws)
    if (ws !== null && pool.length === 0) throw new IntrospectError(`No workspace named "${ws}".`, { hint: `Known workspaces: ${workspaces(all).join(', ')}.` })
    const q = titleQ.toLowerCase()
    const titled = pool.filter(e => e.title)
    const tiers = [
      titled.filter(e => e.title.toLowerCase() === q),
      titled.filter(e => e.title.toLowerCase().startsWith(q)),
      titled.filter(e => e.title.toLowerCase().includes(q)),
      titled.filter(e => slugify(e.title).includes(slugify(titleQ))),
    ]
    for (const tier of tiers) {
      if (tier.length === 1) return tier[0]
      if (tier.length > 1) throw ambiguous(raw, tier)
    }
    throw new IntrospectError(`No session matched "${raw}".`, { hint: `Use transcript_find to list sessions (workspaces: ${workspaces(pool.length ? pool : all).join(', ')}).` })
  }

  /**
   * Resolve a `sessions` selector for corpus-wide tools: `"*"`, `"<ws>/*"`,
   * one spec, or an array of specs. `since` filters by createdAt.
   */
  async function select(selector, exec, { since } = {}, signal) {
    const all = await listAll({ callerCwd: callerCwd(exec) }, signal)
    const sinceMs = parseSince(since)
    const inWindow = (e) => sinceMs === null || (e.createdAt ?? 0) >= sinceMs
    if (selector === undefined || selector === null || selector === '') selector = 'self'
    const specs = Array.isArray(selector) ? selector : [selector]
    const out = new Map()
    for (const spec of specs) {
      const s = String(spec).trim()
      if (s === '*' || s === 'all') { for (const e of all) if (inWindow(e)) out.set(e.id, e); continue }
      const wsGlob = /^([^/]+)\/\*$/.exec(s)
      if (wsGlob) {
        const ws = wsGlob[1].toLowerCase()
        const hits = all.filter(e => e.workspace.toLowerCase() === ws && inWindow(e))
        if (hits.length === 0 && !all.some(e => e.workspace.toLowerCase() === ws)) throw new IntrospectError(`No workspace named "${ws}".`, { hint: `Known workspaces: ${workspaces(all).join(', ')}.` })
        for (const e of hits) out.set(e.id, e)
        continue
      }
      const one = await resolve(s, exec, signal)
      out.set(one.id, one)
    }
    return [...out.values()]
  }

  /** Read (and normalize) one session, cached briefly. */
  async function model(entry, signal) {
    const now = Date.now()
    const cached = snapshots.get(entry.id)
    if (cached && now - cached.at < (cached.live ? SNAPSHOT_TTL_LIVE_MS : SNAPSHOT_TTL_COLD_MS) && cached.live === entry.live) {
      return cached.model
    }
    signal?.throwIfAborted()
    const t0 = Date.now()
    const snapshot = await ctx.sessionQuery.readSession(entry.id)
    const m = buildModel(snapshot, { live: entry.live, title: entry.title ?? undefined })
    if (m.title && m.title !== entry.title) titles.set(entry.id, { title: m.title, at: now, live: entry.live })
    trace({ event: 'read', id: entry.id, events: snapshot.events?.length ?? 0, ms: Date.now() - t0 })
    snapshots.set(entry.id, { model: m, at: now, live: entry.live })
    return m
  }

  /**
   * Read many sessions for a corpus-wide tool: one unreadable log (a refused
   * historical artifact, a torn frame) is reported, not fatal.
   * @returns {Promise<{ models: any[], skipped: { id: string, workspace: string, title: string | null, error: string }[] }>}
   */
  async function models(entries, signal) {
    const out = { models: [], skipped: [] }
    for (const entry of entries) {
      try {
        out.models.push(await model(entry, signal))
      } catch (error) {
        if (entries.length === 1 || signal?.aborted) throw error
        const message = error instanceof Error ? error.message : String(error)
        trace({ event: 'read-failed', id: entry.id, error: message })
        out.skipped.push({ id: entry.id, workspace: entry.workspace, title: entry.title, error: message.split('\n')[0].slice(0, 300) })
      }
    }
    return out
  }

  return { listAll, resolve, select, model, models, callerId, callerCwd }
}

function workspaces(entries) {
  return [...new Set(entries.map(e => e.workspace))].sort()
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function ambiguous(raw, hits) {
  const list = hits.slice(0, 8).map(e => `  ${e.id}  ${e.workspace}/${e.title ?? '(untitled)'}  (${e.cwd ?? 'no cwd'})`).join('\n')
  return new IntrospectError(`"${raw}" matches ${hits.length} sessions; be more specific (workspace/title or id):\n${list}`)
}

/**
 * `since`: ISO date/time, or a relative `7d` / `12h` / `30m`.
 * @returns {number | null} epoch ms
 */
export function parseSince(since) {
  if (since === undefined || since === null || since === '') return null
  const s = String(since).trim()
  const rel = /^(\d+)\s*([mhdw])$/i.exec(s)
  if (rel) {
    const n = Number(rel[1])
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }[rel[2].toLowerCase()]
    return Date.now() - n * unit
  }
  const t = Date.parse(s)
  if (Number.isNaN(t)) throw new IntrospectError(`since "${s}" is not an ISO date or a relative duration like 7d, 12h, 30m.`)
  return t
}

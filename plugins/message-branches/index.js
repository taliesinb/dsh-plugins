/**
 * tali-message-branches — host half.
 *
 * Editing a sent user message forks the conversation: the child session
 * inherits every event before the edited message's turn (DSH's own fork cut)
 * and is prompted with the edited text and attachments. Sessions linked by
 * `header.parentSession` + their inherited-prefix cut form a tree, and the
 * shipped assistant-side Branch button lands in the same tree, because it is
 * the same fork. The browser half (src/client) draws the edit box, the
 * ‹ n/m › version switcher under branched messages, and the tree navigator.
 *
 * Routes (behind the normal browser auth; document-relative on the client):
 *
 *   GET  /api/message-branches/tree?sessionId=…
 *        → { root, members: { [id]: { id, parent, firstOwnTurn, createdAt, previews } } }
 *        The whole family of the session: root, every fork descendant, the
 *        turn each descendant's own history starts at, and a one-line
 *        preview of the human prompt at every turn that is a branch point.
 *
 *   POST /api/message-branches/edit
 *        { sessionId, turn, text, keep: [attachmentId…], images: [{ mediaType, data, name? }…], files: [{ receiptId }…] }
 *        → { sessionId: <child> } | 4xx { error }
 *        Forks `sessionId` before `turn` (any turn, the first included — DSH's
 *        `session.fork` refuses a cut before the first completed turn), stores
 *        the child cold through session persistence exactly as a fork child
 *        (seeded header, inherited prefix, `session/end-seed {inherited}`),
 *        attaches it to the source's workspace, resumes it through the
 *        Session Controller (so the model selection, preset and retirement are
 *        the controller's), and queues the edited prompt: the kept original
 *        attachment blocks (durable refs, in their original order), the newly
 *        uploaded images (admitted here) and files (receipts staged against
 *        the SOURCE session by the shipped upload service), then the text.
 *
 * Why cold-store + resume instead of `ctx.agents.create` like the gateway's
 * fork: the controller only installs the per-session model selection and
 * retains the handle for sessions it resumed itself; a child it merely
 * discovers would run on the default model until its first gateway prompt.
 */

import { randomUUID } from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { cutForTurn, firstOwnTurnOf, keptAttachmentBlocks, previewsFor, userMessageOfTurn } from './tree.mjs'

export const name = 'message-branches'

export const inject = [
  'connection', 'sessionQuery', 'sessionPersistence', 'sessionController',
  'workspaceRegistry', 'attachments', 'fileUploads',
]

export const Config = Schema.object({
  /** Seconds a computed family tree is served from memory before the corpus is re-read. */
  treeCacheSeconds: Schema.number().min(0).default(3),
  /** Longest preview kept per branch point, in characters. */
  previewChars: Schema.number().min(20).default(160),
})

export const TREE_PATH = '/api/message-branches/tree'
export const EDIT_PATH = '/api/message-branches/edit'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<typeof Config>} config
 */
export function apply(ctx, config) {
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
  const failure = (message, status = 400) => json({ error: message }, status)

  /** Immutable per-session facts of a fork child: inherited cut and first own turn. */
  const cutCache = new Map()
  /** Whole-family answers, keyed by root id, with an expiry. */
  const familyCache = new Map()

  /** Fork lineage edge of one header, or undefined for roots and subagent children. */
  const forkParentOf = header => (header.isSeeded && header.origin !== 'subagent' && typeof header.parentSession === 'string')
    ? header.parentSession
    : undefined

  /** Run `fn` over one immutable observation of the session and release it. */
  async function withObservation(sessionId, fn) {
    const observation = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none' })
    try {
      return await fn(observation)
    } finally {
      observation[Symbol.dispose]()
    }
  }

  /** Family tree of the session: walks headers up to the root and down to every fork descendant. */
  async function familyOf(sessionId) {
    const records = await ctx.sessionQuery.listSessions()
    const headers = new Map(records.map(r => [r.header.id, r.header]))
    if (!headers.has(sessionId)) return undefined
    let root = sessionId
    const seen = new Set()
    while (true) {
      seen.add(root)
      const parent = forkParentOf(headers.get(root))
      if (parent === undefined || !headers.has(parent) || seen.has(parent)) break
      root = parent
    }
    const cached = familyCache.get(root)
    if (cached !== undefined && cached.expires > Date.now() && cached.sessionCount === headers.size) return cached.family

    const childrenOf = new Map()
    for (const header of headers.values()) {
      const parent = forkParentOf(header)
      if (parent === undefined || !headers.has(parent)) continue
      const list = childrenOf.get(parent) ?? []
      list.push(header)
      childrenOf.set(parent, list)
    }
    const members = {}
    const order = [root]
    for (let i = 0; i < order.length; i += 1) {
      const id = order[i]
      const header = headers.get(id)
      members[id] = { id, parent: i === 0 ? null : header.parentSession, firstOwnTurn: 1, createdAt: header.createdAt, previews: {} }
      for (const child of childrenOf.get(id) ?? []) if (!(child.id in members) && !order.includes(child.id)) order.push(child.id)
    }
    // Each descendant's cut → its first own turn (immutable, cached forever).
    const branchTurns = new Set()
    for (const id of order.slice(1)) {
      let facts = cutCache.get(id)
      if (facts === undefined) {
        facts = await withObservation(id, (observation) => {
          const cut = observation.inheritedEventCount
          return { cut, firstOwnTurn: firstOwnTurnOf(observation.events, cut) }
        })
        cutCache.set(id, facts)
      }
      members[id].firstOwnTurn = facts.firstOwnTurn
      branchTurns.add(facts.firstOwnTurn)
    }
    // Previews of every member's own prompt at the family's branch turns.
    if (branchTurns.size > 0) {
      for (const id of order) {
        members[id].previews = await withObservation(id, observation =>
          previewsFor(observation.events, branchTurns, members[id].firstOwnTurn, config.previewChars))
      }
    }
    const family = { root, members }
    // A just-forked child has no own prompt yet (its turn opens moments after
    // the edit): keep re-reading such a family until every branch has its line.
    const settled = order.slice(1).every(id => members[id].previews[String(members[id].firstOwnTurn)] !== undefined)
    if (settled) familyCache.set(root, { family, expires: Date.now() + config.treeCacheSeconds * 1000, sessionCount: headers.size })
    return family
  }

  const route = (definition, label) => ctx.effect(() => {
    const dispose = ctx.connection.fetch.register(definition)
    return () => { void dispose() }
  }, label)

  route({
    path: TREE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const sessionId = new URL(request.url).searchParams.get('sessionId') ?? ''
      if (sessionId === '') return failure('sessionId is required')
      try {
        const family = await familyOf(sessionId)
        if (family === undefined) return failure(`unknown session "${sessionId}"`, 404)
        return json(family)
      } catch (error) {
        ctx.logger.warn(`message-branches: tree for ${sessionId} failed: ${String(error)}`)
        return failure(String(error), 500)
      }
    },
  }, 'message-branches: tree route')

  route({
    path: EDIT_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body
      try { body = await request.json() } catch { return failure('body must be JSON') }
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
      const turn = typeof body?.turn === 'number' ? body.turn : Number.NaN
      const text = typeof body?.text === 'string' ? body.text : ''
      const keep = new Set(Array.isArray(body?.keep) ? body.keep.filter(id => typeof id === 'string') : [])
      const images = Array.isArray(body?.images) ? body.images : []
      const files = Array.isArray(body?.files) ? body.files : []
      if (sessionId === '') return failure('sessionId is required')
      if (!Number.isSafeInteger(turn) || turn < 1) return failure('turn must be a positive integer')
      if (text.trim() === '' && keep.size === 0 && images.length === 0 && files.length === 0) {
        return failure('the edited message needs text or an attachment')
      }
      try {
        const childId = await editIntoBranch({ sessionId, turn, text, keep, images, files })
        familyCache.clear()
        return json({ sessionId: childId })
      } catch (error) {
        const status = error instanceof EditError ? error.status : 500
        if (status === 500) ctx.logger.warn(`message-branches: edit of ${sessionId} turn ${turn} failed: ${error?.stack ?? String(error)}`)
        return failure(error instanceof Error ? error.message : String(error), status)
      }
    },
  }, 'message-branches: edit route')

  class EditError extends Error {
    constructor(message, status = 400) {
      super(message)
      this.status = status
    }
  }

  /** The workspace whose session list holds `sessionId`, when any. */
  const workspaceOf = sessionId => ctx.workspaceRegistry.list().find(w => w.sessionIds.includes(sessionId))

  async function editIntoBranch({ sessionId, turn, text, keep, images, files }) {
    let prepared
    try {
      prepared = await withObservation(sessionId, (source) => {
        const events = source.events
        const placed = cutForTurn(events, turn)
        if ('error' in placed) throw new EditError(placed.error, 409)
        const cut = placed.cut
        if (events.length < cut || events.some((e, i) => i < cut && e.seq !== i)) {
          throw new EditError('session log is not contiguous; refusing to fork it', 500)
        }
        const childId = `session-${randomUUID()}`
        const now = Date.now()
        const seed = [
          ...events.slice(0, cut),
          { type: 'session/end-seed', seq: cut, time: now, data: { inherited: true } },
        ]
        const parent = source.header
        const header = {
          version: parent.version,
          id: childId,
          createdAt: now,
          ...(parent.cwd === undefined ? {} : { cwd: parent.cwd }),
          parentSession: sessionId,
          isSeeded: true,
          ...(parent.agentPreset === undefined ? {} : { agentPreset: parent.agentPreset }),
        }
        return { childId, cut, seed, header, original: userMessageOfTurn(events, turn) }
      })
    } catch (error) {
      if (error instanceof EditError) throw error
      throw new EditError(`session "${sessionId}" is unavailable: ${String(error)}`, 404)
    }
    const { childId, cut, seed, header, original } = prepared

    // 1. Store the child cold, exactly as persistence would have received it from a live fork.
    const handle = await ctx.sessionPersistence.create(header, { inheritedEventCount: cut })
    try {
      await handle.append(seed)
      await handle.flush()
    } finally {
      await handle.close()
    }
    try {
      ctx.get('sessionProjectionCache')?.coldSnapshot(header, cut, seed)
    } catch (error) {
      ctx.logger.warn(`message-branches: projection cache seed for ${childId} failed: ${String(error)}`)
    }
    ctx.emit('session-persistence/stored', header)
    cutCache.set(childId, { cut, firstOwnTurn: turn })

    // 2. Same workspace as the source.
    const workspace = workspaceOf(sessionId)
    if (workspace !== undefined) await workspace.attachSession(childId)

    // 3. Resume through the controller and queue the edited prompt.
    const resolved = await ctx.sessionController.resolveAgent(childId)
    if ('error' in resolved) throw new EditError(`branch "${childId}" could not be resumed: ${resolved.error.message}`, 500)
    const agent = resolved.agent
    if (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) agent.inbox.clear()

    const content = []
    content.push(...keptAttachmentBlocks(original?.data?.content, keep))
    if (images.length > 0) {
      const parts = images.map(image => ({
        type: 'image',
        mediaType: String(image?.mediaType ?? ''),
        data: String(image?.data ?? ''),
        ...(typeof image?.name === 'string' && image.name !== '' ? { name: image.name } : {}),
      }))
      let admitted
      try {
        admitted = await ctx.attachments.admitPromptContent(parts)
      } catch (error) {
        throw new EditError(`image refused: ${error instanceof Error ? error.message : String(error)}`, 400)
      }
      content.push(...admitted)
    }
    if (files.length > 0) {
      const parentResolved = await ctx.sessionController.resolveAgent(sessionId)
      if ('error' in parentResolved) throw new EditError(`source session unavailable for file receipts: ${parentResolved.error.message}`, 500)
      for (const file of files) {
        const receiptId = typeof file?.receiptId === 'string' ? file.receiptId : ''
        const ref = receiptId === '' ? undefined : ctx.fileUploads.resolve(parentResolved.agent, receiptId)
        if (ref === undefined) throw new EditError('a file was not uploaded for this session', 400)
        content.push({ type: 'file', attachment: ref })
      }
    }
    if (text !== '') content.push({ type: 'text', text })
    const message = createUserMessage({ content, source: { kind: 'user' } })
    agent.followup(message)
    ctx.logger.info(`message-branches: ${sessionId} turn ${turn} → branch ${childId} (${content.length} blocks)`)
    return childId
  }

  ctx.logger.info('message-branches: routes registered')
}

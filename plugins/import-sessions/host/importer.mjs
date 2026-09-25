/**
 * Importer — turns one selected transcript into a stored DSH session through
 * DSH's own services, the same sequence the built-in ZIP importer
 * (<checkout>/packages/session-query/session-log-export/src/import.ts) uses:
 *
 *   sessionPersistence.create(header) → handle.append(events) → flush → close
 *   sessionProjectionCache.coldSnapshot(header, 0, events)   (title/stats in the sidebar before first open)
 *   ctx.emit('session-persistence/stored', header)
 *   workspace.attachSession(id)                              (directory-matched workspace)
 *
 * so there is no hand-written zstd, no restart, and no "server owns the
 * cursor" hazard. Images go through `attachments.saveImages` and come back as
 * real ImageBlocks.
 *
 * Destination rules (the client resolves them per session from the tree modal):
 *   existing   header.cwd = workspace.path; attach
 *   new        mkdir -p dir if needed; workspaceRegistry.create(dir) (title = basename, DSH's default); header.cwd = dir; attach
 *   ungrouped  header.cwd = the transcript's own cwd (kept for a later regroup); no attach
 *
 * Claude subagent transcripts become child sessions (parentSession, origin
 * 'subagent', delegationDepth 1) so the subagent tree renders.
 */
import { mkdir, stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import { checkInvariant } from './events.mjs'
import { listClaudeSubagents, readClaudeSession } from './claude-reader.mjs'
import { readPiSession } from './pi-reader.mjs'
import { SOURCES, collapseHome, dshSessionId, expandHome, inspectClaudeSession, inspectPiSession } from './sources.mjs'

const SESSION_FORMAT_VERSION = 3

/** Wire `attachments.saveImages` as the builder's image hook. */
export function imageSaver(attachments) {
  if (attachments === undefined || typeof attachments.saveImages !== 'function') return undefined
  return async (data, mediaType, name) => {
    const [ref] = await attachments.saveImages([{ data, mediaType, ...(name ? { name } : {}) }])
    return ref === undefined ? null : { type: 'image', attachment: ref }
  }
}

function fmtDate(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : '?'
}

function countsOf(builder, extra = {}) {
  const s = builder.stats
  return {
    turns: s.turns,
    steps: s.steps,
    toolCalls: s.toolCalls,
    toolResults: s.toolResults,
    images: s.images,
    imagesImported: s.imagesImported,
    truncatedResults: s.truncatedResults,
    droppedRecords: Object.values(s.droppedRecords).reduce((a, b) => a + b, 0),
    orphanResults: s.orphanResults,
    ...(s.foldedTurns > 0 ? { foldedTurns: s.foldedTurns } : {}),
    ...extra,
  }
}

/**
 * @typedef {object} ImportServices
 * @property {object} persistence   - `sessionPersistence`
 * @property {object} [attachments]
 * @property {object} [projectionCache]
 * @property {object} workspaces    - `workspaceRegistry`
 * @property {(message: object) => number} [estimate]
 * @property {(header: object) => void} stored - emit `session-persistence/stored`
 * @property {(line: string) => void} [log]
 */

/**
 * Resolve a destination to `{ workspace, cwd }`.
 * @param {ImportServices} services
 */
async function resolveDestination(services, destination, fallbackCwd) {
  if (destination?.kind === 'existing') {
    const workspace = services.workspaces.get(destination.workspaceId)
    if (workspace === undefined) throw new Error(`workspace ${destination.workspaceId} no longer exists`)
    return { workspace, cwd: workspace.path }
  }
  if (destination?.kind === 'new') {
    // The client names the path (`<base>/<basename of the original cwd>`, `~`
    // allowed); the directory may not exist on this machine yet (remote
    // client, or a worktree that is gone) — create it, since a DSH workspace
    // needs a real directory.
    const dir = resolve(expandHome(String(destination.dir ?? '')))
    if (!isAbsolute(dir) || dir === '/') throw new Error(`invalid new-workspace path: ${String(destination.dir)}`)
    let info
    try { info = await stat(dir) } catch { info = undefined }
    if (info === undefined) await mkdir(dir, { recursive: true })
    else if (!info.isDirectory()) throw new Error(`${collapseHome(dir)} exists and is not a directory`)
    const existing = await services.workspaces.resolveByPath(dir)
    const workspace = existing ?? await services.workspaces.create(dir)
    return { workspace, cwd: workspace.path }
  }
  return { workspace: undefined, cwd: fallbackCwd }
}

/**
 * Store one built session.
 * @param {ImportServices} services
 */
async function storeSession(services, header, events) {
  const problems = checkInvariant(events)
  if (problems.length > 0) throw new Error(`built log violates the session invariant: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? ` (+${problems.length - 3} more)` : ''}`)
  const handle = await services.persistence.create(header)
  try {
    if (events.length > 0) await handle.append(events)
    await handle.flush()
  } finally {
    await handle.close()
  }
  try {
    services.projectionCache?.coldSnapshot(header, 0, events)
  } catch (error) {
    services.log?.(`import-sessions: projection cache seed for ${header.id} failed: ${String(error?.message ?? error)}`)
  }
  services.stored(header)
}

/**
 * Import one transcript.
 * @param {ImportServices} services
 * @param {object} job
 * @param {'claude'|'pi'} job.source
 * @param {string} job.file
 * @param {object} job.destination
 * @param {{kind:'archive'} | {kind:'working', keepTurns:number, resultCap:number}} job.mode
 * @param {number} [job.archiveResultCap]
 * @param {(phase: 'reading'|'writing'|'attaching', title?: string) => void} [job.onPhase]
 */
export async function importTranscript(services, { source, file, destination, mode, archiveResultCap = 0, onPhase }) {
  const meta = source === 'claude' ? await inspectClaudeSession(file) : await inspectPiSession(file)
  const sessionId = dshSessionId(source, meta.sourceId)
  if (await services.persistence.stat(sessionId) !== undefined) throw new Error(`already imported as ${sessionId}`)
  const resultCap = mode.kind === 'working' ? Math.max(0, Number(mode.resultCap) || 0) : Math.max(0, Number(archiveResultCap) || 0)
  const saveImage = imageSaver(services.attachments)
  onPhase?.('reading', meta.title)

  let builder
  let cwd
  let children = []
  if (source === 'claude') {
    const read = await readClaudeSession(file, { sessionId, resultCap, saveImage })
    builder = read.builder
    cwd = read.cwd ?? meta.cwd
    for (const childFile of await listClaudeSubagents(file)) {
      const childId = `${sessionId}-${basename(childFile, '.jsonl')}`
      if (await services.persistence.stat(childId) !== undefined) continue
      const child = await readClaudeSession(childFile, { sessionId: childId, resultCap, saveImage, child: true })
      child.builder.finish(`Subagent ${basename(childFile, '.jsonl').replace(/^agent-/, '')}`)
      children.push({ id: childId, builder: child.builder, file: childFile })
    }
  } else {
    const read = await readPiSession(file, { sessionId, resultCap, saveImage, estimate: services.estimate })
    builder = read.builder
    cwd = read.cwd ?? meta.cwd
  }

  const label = `${SOURCES[source].label} session${meta.title ? ` "${meta.title}"` : ''}, ${fmtDate(builder.stats.firstTime ?? meta.startedAt)} → ${fmtDate(builder.stats.lastTime ?? meta.endedAt)}`
  const fallbackTitle = meta.title ?? `${SOURCES[source].label} import ${meta.sourceId.slice(0, 8)}`
  builder.finish(fallbackTitle)
  if (mode.kind === 'working') builder.fold({ keepTurns: mode.keepTurns, estimate: services.estimate, sourceLabel: label })
  const surfaceTokens = builder.surfaceTokens(services.estimate)

  onPhase?.('writing', fallbackTitle)
  const { workspace, cwd: headerCwd } = await resolveDestination(services, destination, cwd)
  const createdAt = Math.round(builder.stats.firstTime ?? meta.startedAt ?? Date.now())
  // Logical header (no `type`: the codec adds it when it encodes the physical header line).
  const header = {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt,
    ...(headerCwd !== undefined ? { cwd: headerCwd } : {}),
    isSeeded: false,
    delegationDepth: 0,
  }
  await storeSession(services, header, builder.events)
  let storedChildren = 0
  for (const child of children) {
    const childHeader = {
      version: SESSION_FORMAT_VERSION,
      id: child.id,
      createdAt: Math.round(child.builder.stats.firstTime ?? createdAt),
      ...(headerCwd !== undefined ? { cwd: headerCwd } : {}),
      parentSession: sessionId,
      isSeeded: false,
      origin: 'subagent',
      delegationDepth: 1,
    }
    try {
      await storeSession(services, childHeader, child.builder.events)
      storedChildren++
    } catch (error) {
      services.log?.(`import-sessions: child ${child.id} (${collapseHome(child.file)}) skipped: ${String(error?.message ?? error)}`)
    }
  }

  let attached = null
  if (workspace !== undefined) {
    onPhase?.('attaching', fallbackTitle)
    await workspace.attachSession(sessionId)
    attached = { id: workspace.id, title: workspace.title }
  }
  return {
    file,
    ok: true,
    sessionId,
    title: builder.titleText ?? fallbackTitle,
    workspace: attached,
    counts: countsOf(builder, { surfaceTokens, ...(storedChildren > 0 ? { children: storedChildren } : {}) }),
  }
}

/** In-memory import jobs with progress, kept for a while after finishing. */
export class ImportJobs {
  constructor({ ttlMs = 10 * 60 * 1000 } = {}) {
    this.jobs = new Map()
    this.ttlMs = ttlMs
  }

  /**
   * @param {ImportServices} services
   * @param {{source:'claude'|'pi', mode?:object, selections:Array<{file:string, destination:object, mode?:object}>, archiveResultCap?:number, onFinished?:Function}} request
   */
  start(services, request) {
    const jobId = `import-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const job = { jobId, total: request.selections.length, done: 0, current: undefined, finished: false, results: [], startedAt: Date.now() }
    this.jobs.set(jobId, job)
    void (async () => {
      for (const selection of request.selections) {
        job.current = { file: selection.file, title: basename(selection.file), phase: 'reading' }
        try {
          const result = await importTranscript(services, {
            source: request.source,
            file: selection.file,
            destination: selection.destination,
            mode: selection.mode ?? request.mode ?? { kind: 'archive' },
            archiveResultCap: request.archiveResultCap,
            onPhase: (phase, title) => { job.current = { file: selection.file, title: title ?? basename(selection.file), phase } },
          })
          job.results.push(result)
          services.log?.(`import-sessions: imported ${result.sessionId} "${result.title}" → ${result.workspace?.title ?? 'Ungrouped'} (${result.counts.turns} turns, ${result.counts.toolCalls} tool calls${result.counts.foldedTurns ? `, ${result.counts.foldedTurns} folded` : ''})`)
        } catch (error) {
          job.results.push({ file: selection.file, ok: false, error: String(error?.message ?? error) })
          services.log?.(`import-sessions: ${collapseHome(selection.file)} failed: ${String(error?.message ?? error)}`)
        }
        job.done++
      }
      job.current = undefined
      job.finished = true
      job.finishedAt = Date.now()
      try { await request.onFinished?.(job) } catch (error) { services.log?.(`import-sessions: job ${jobId} cleanup failed: ${String(error?.message ?? error)}`) }
      setTimeout(() => { this.jobs.delete(jobId) }, this.ttlMs).unref?.()
    })()
    return { jobId, total: job.total }
  }

  progress(jobId) {
    const job = this.jobs.get(jobId)
    if (job === undefined) return undefined
    return { jobId, total: job.total, done: job.done, current: job.current, finished: job.finished, results: job.results }
  }

  get running() {
    return [...this.jobs.values()].filter(j => !j.finished).length
  }
}

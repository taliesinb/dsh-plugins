/**
 * tali-import-sessions — host half.
 *
 * `/import-claude` and `/import-pi` bring coding-agent transcripts that live on
 * this machine's disk (Claude Code: ~/.claude/projects; pi: ~/.pi/agent/sessions)
 * into DSH as real, resumable sessions, grouped into the DSH workspace whose
 * directory matches the transcript's working directory.
 *
 * Two surfaces:
 *
 *   - the HOST slash commands (ctx.commands): bare `/import-claude` reports the
 *     store (where it is, how many workspaces/sessions, how many already
 *     imported); `/import-claude <path>` imports that transcript / workspace
 *     dir / store root headlessly in archive mode (phone UI, no dialog). The
 *     browser half DECORATES the bare command to open the guided modal instead.
 *   - the control channel `POST /import-sessions/<endpoint>` for the modal:
 *     `sources`, `pick` (native chooser on this machine), `scan`, `import`,
 *     `progress` — see PROTOCOL.md.
 *
 * Writes go through DSH's own services (sessionPersistence, attachments,
 * sessionProjectionCache, workspaceRegistry) — host/importer.mjs.
 */
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { readClaudeSession } from './host/claude-reader.mjs'
import { ImportJobs, importTranscript } from './host/importer.mjs'
import { readPiSession } from './host/pi-reader.mjs'
import { pickPath, pickerCapability } from './host/picker.mjs'
import { SOURCES, collapseHome, expandHome, scanSelection } from './host/sources.mjs'
import { UploadStore } from './host/uploads.mjs'
import { peerHost, requestClient, serverHost } from './host/hosts.mjs'

export const name = 'import-sessions'
export const inject = ['webServer', 'connection', 'commands', 'sessionPersistence', 'workspaceRegistry']

export const Config = Schema.object({
  claudeRoot: Schema.string().default('~/.claude/projects').description('Claude Code project store'),
  piRoot: Schema.string().default('~/.pi/agent/sessions').description('pi session store'),
  keepTurns: Schema.number().min(1).default(20).description('Working-session default: turns kept on the model-visible surface'),
  resultCap: Schema.number().min(0).default(4096).description('Working-session default: max chars per tool-result text block (stay below the pruner threshold of 8192)'),
  archiveResultCap: Schema.number().min(0).default(0).description('Archive mode: max chars per tool-result text block; 0 = unlimited'),
  largeTokens: Schema.number().min(1000).default(100_000).description('A session whose estimated model-visible surface exceeds this many tokens is "large": the dialog offers the working-session fold for it'),
})

export const CHANNEL = '/import-sessions'
const MAX_BODY = 256 * 1024
/** Upload chunks travel base64 inside the JSON envelope: 4 MiB raw per chunk. */
const MAX_UPLOAD_BODY = 6 * 1024 * 1024
const UPLOAD_ENDPOINTS = new Set(['upload-chunk'])

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const isSource = value => value === 'claude' || value === 'pi'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{claudeRoot:string, piRoot:string, keepTurns:number, resultCap:number, archiveResultCap:number}} config
 */
export function apply(ctx, config) {
  const log = line => ctx.logger.info(line)
  const roots = { claude: expandHome(config.claudeRoot), pi: expandHome(config.piRoot) }
  const jobs = new ImportJobs()
  const uploads = new UploadStore(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'import-sessions', 'uploads'))
  void uploads.sweep().then(n => { if (n > 0) log(`import-sessions: swept ${n} stale upload${n === 1 ? '' : 's'}`) }).catch(() => {})

  /** Services the importer needs, resolved per call (optional ones may mount later). */
  const services = () => ({
    persistence: ctx.sessionPersistence,
    attachments: ctx.get('attachments'),
    projectionCache: ctx.get('sessionProjectionCache'),
    workspaces: ctx.workspaceRegistry,
    estimate: (() => { const meter = ctx.get('tokenMeter'); return meter === undefined ? undefined : (message => meter.estimateMessage(message)) })(),
    stored: header => { ctx.emit('session-persistence/stored', header) },
    log,
  })

  const probe = async ({ id }) => ({ imported: (await ctx.sessionPersistence.stat(id)) !== undefined })

  /** Full read (no image saving) for exact turn counts and a surface-token estimate. */
  const measureFor = (source) => async ({ file, id }) => {
    const estimate = services().estimate
    const read = source === 'claude'
      ? await readClaudeSession(file, { sessionId: id })
      : await readPiSession(file, { sessionId: id, estimate })
    read.builder.finish('measure')
    const estimatedTokens = read.builder.surfaceTokens(estimate)
    return { turns: read.builder.stats.turns, toolCalls: read.builder.stats.toolCalls, estimatedTokens, large: estimatedTokens > config.largeTokens }
  }
  const scan = async (source, path) => {
    const result = await decorateTree(await scanSelection(source, roots[source], path, { probe, measure: measureFor(source) }))
    result.uploaded = uploads.owns(result.path)
    result.largeTokens = config.largeTokens
    // One session, however it was reached (single file, one-transcript folder,
    // one uploaded transcript) → the single-session card, not a one-row table.
    if (result.workspaces.length === 1 && result.workspaces[0].sessions.length === 1) result.kind = 'session'
    return result
  }

  const workspaceOptions = () => ctx.workspaceRegistry.list().map(w => ({ id: w.id, title: w.title, path: w.path }))

  /** Default destination for a scanned workspace group. */
  const decorateTree = async (tree) => {
    for (const group of tree.workspaces) {
      // A directory-matched workspace wins; otherwise a new one (the client
      // decides where it is placed; the directory need not exist here).
      const existing = group.dirExists ? await ctx.workspaceRegistry.resolveByPath(group.dir).catch(() => undefined) : undefined
      group.destination = existing !== undefined
        ? { kind: 'existing', workspaceId: existing.id, title: existing.title }
        : { kind: 'new', title: group.dir.split('/').filter(Boolean).at(-1) ?? group.dir }
    }
    return tree
  }

  const storeSummary = async (source) => {
    const root = roots[source]
    let tree
    try { tree = await scanSelection(source, root, root, probe) } catch (error) { return `${SOURCES[source].label} store ${collapseHome(root)}: ${String(error?.message ?? error)}` }
    const sessions = tree.workspaces.flatMap(w => w.sessions)
    const imported = sessions.filter(s => s.imported).length
    const lines = [
      `${SOURCES[source].label} store: ${collapseHome(root)} — ${tree.workspaces.length} workspace${tree.workspaces.length === 1 ? '' : 's'}, ${sessions.length} session${sessions.length === 1 ? '' : 's'}${imported > 0 ? ` (${imported} already imported)` : ''}.`,
      ...tree.workspaces.map(w => `  - ${collapseHome(w.dir)}${w.dirExists ? '' : ' (directory missing)'}: ${w.sessions.length} session${w.sessions.length === 1 ? '' : 's'}${w.sessions.filter(s => s.imported).length > 0 ? `, ${w.sessions.filter(s => s.imported).length} imported` : ''}`),
      `Usage: /import-${source} <path to a transcript, a workspace folder, or the store> — imports headlessly in archive mode. In the web GUI the bare command opens the guided dialog.`,
    ]
    return lines.join('\n')
  }

  /** Headless import of a path (archive mode, directory-matched destinations). */
  const headlessImport = async (source, rawPath, signal) => {
    const tree = await scan(source, rawPath)
    const selections = []
    for (const group of tree.workspaces) {
      const destination = group.destination.kind === 'existing'
        ? { kind: 'existing', workspaceId: group.destination.workspaceId }
        : group.destination.kind === 'new' ? { kind: 'new', dir: group.dirExists ? group.dir : `~/${group.destination.title}` } : { kind: 'ungrouped' }
      for (const session of group.sessions) {
        if (session.imported || session.duplicateOf !== undefined || session.error !== undefined) continue
        selections.push({ file: session.file, destination })
      }
    }
    if (selections.length === 0) return { kind: 'success', text: 'Nothing to import: every session in that selection is already imported (or unreadable).' }
    const results = []
    for (const selection of selections) {
      signal?.throwIfAborted()
      try {
        const result = await importTranscript(services(), { source, file: selection.file, destination: selection.destination, mode: { kind: 'archive' }, archiveResultCap: config.archiveResultCap })
        results.push(`  ✓ ${result.title} → ${result.workspace?.title ?? 'Ungrouped'} (${result.counts.turns} turns, ${result.counts.toolCalls} tool calls${result.counts.children ? `, ${result.counts.children} subagents` : ''})`)
        log(`import-sessions: imported ${result.sessionId} "${result.title}" → ${result.workspace?.title ?? 'Ungrouped'}`)
      } catch (error) {
        results.push(`  ✗ ${collapseHome(selection.file)}: ${String(error?.message ?? error)}`)
      }
    }
    return { kind: 'success', text: [`Imported ${results.filter(r => r.startsWith('  ✓')).length} of ${selections.length} session${selections.length === 1 ? '' : 's'} (archive mode):`, ...results].join('\n') }
  }

  // ---- host slash commands -------------------------------------------------------------
  for (const source of ['claude', 'pi']) {
    ctx.effect(() => ctx.commands.register({
      name: `import-${source}`,
      description: `Import ${SOURCES[source].label} sessions from this machine into DSH: bare = what the store holds (the web GUI opens a chooser instead), "<path>" = import that transcript / workspace folder / store headlessly (archive mode)`,
      input: { hint: 'path' },
      handler: async ({ rawInput, signal }) => {
        const path = rawInput.trim()
        try {
          if (path === '') return { kind: 'success', text: await storeSummary(source) }
          return await headlessImport(source, path, signal)
        } catch (error) {
          return { kind: 'error', text: String(error?.message ?? error) }
        }
      },
    }), `import-sessions: /import-${source}`)
  }

  // ---- control channel for the browser half ------------------------------------------
  const ok = value => ({ ok: true, value })
  const fail = (code, message) => ({ ok: false, error: { code: `import-sessions/${code}`, message, details: {} } })
  const dispatch = async (endpoint, args, signal, req) => {
    switch (endpoint) {
      case 'sources': {
        const capability = await pickerCapability()
        const sources = {}
        for (const source of ['claude', 'pi']) {
          let exists = false
          try { exists = (await stat(roots[source])).isDirectory() } catch { exists = false }
          // `exists` only counts a store with at least one workspace directory in it.
          if (exists) { try { exists = (await scanSelection(source, roots[source], roots[source])).workspaces.length > 0 } catch { exists = false } }
          sources[source] = { label: SOURCES[source].label, root: roots[source], defaultRoot: SOURCES[source].defaultRoot, exists }
        }
        const who = requestClient(req)
        const client = { sameMachine: who.sameMachine, host: who.sameMachine ? serverHost() : await peerHost(who.address).catch(() => undefined) }
        return ok({ platform: process.platform, pickerAvailable: capability.available, pickerKind: capability.kind, sources, workspaces: workspaceOptions(), defaults: { keepTurns: config.keepTurns, resultCap: config.resultCap }, server: { host: serverHost() }, client })
      }
      case 'pick': {
        if (!isSource(args.source)) return fail('bad-request', 'source must be "claude" or "pi"')
        try {
          const path = await pickPath({ initialDirectory: roots[args.source], message: `Import ${SOURCES[args.source].label} sessions into DSH: choose one transcript, one workspace folder, or the whole store`, signal })
          return ok({ path })
        } catch (error) {
          if (error?.code === 'picker-unavailable') return fail('picker-unavailable', error.message)
          throw error
        }
      }
      case 'scan': {
        if (!isSource(args.source)) return fail('bad-request', 'source must be "claude" or "pi"')
        if (typeof args.path !== 'string' || args.path.trim() === '') return fail('bad-request', 'path is required')
        try {
          return ok(await scan(args.source, args.path.trim()))
        } catch (error) {
          return fail('scan', String(error?.message ?? error))
        }
      }
      case 'upload-begin': {
        if (!isSource(args.source)) return fail('bad-request', 'source must be "claude" or "pi"')
        const upload = await uploads.begin(args.source)
        log(`import-sessions: upload ${upload.id} started (${SOURCES[args.source].label})`)
        return ok({ uploadId: upload.id, chunkBytes: 4 * 1024 * 1024 })
      }
      case 'upload-chunk': {
        if (typeof args.data !== 'string' || typeof args.path !== 'string') return fail('bad-request', 'path and base64 data are required')
        const encoding = args.encoding === 'gzip' ? 'gzip' : 'identity'
        try {
          const written = await uploads.chunk(args.uploadId, args.path, Buffer.from(args.data, 'base64'), { encoding, ...(Number.isFinite(args.offset) ? { offset: args.offset } : {}) })
          return ok(written)
        } catch (error) {
          return fail('upload', String(error?.message ?? error))
        }
      }
      case 'upload-finish': {
        try {
          const finished = await uploads.finish(args.uploadId)
          log(`import-sessions: upload ${String(args.uploadId)} complete: ${finished.files} file(s), ${finished.bytes.toLocaleString()} bytes`)
          return ok({ path: finished.dir, files: finished.files, bytes: finished.bytes })
        } catch (error) {
          return fail('upload', String(error?.message ?? error))
        }
      }
      case 'upload-discard': {
        return ok({ discarded: await uploads.discard(args.uploadId) })
      }
      case 'import': {
        if (!isSource(args.source)) return fail('bad-request', 'source must be "claude" or "pi"')
        const normalizeMode = (mode) => {
          if (mode?.kind === 'working') {
            return { kind: 'working', keepTurns: Math.max(1, Math.floor(Number(mode.keepTurns) || config.keepTurns)), resultCap: Math.max(0, Math.floor(Number(mode.resultCap) || config.resultCap)) }
          }
          return { kind: 'archive' }
        }
        const defaultMode = normalizeMode(args.mode)
        const selections = (Array.isArray(args.selections) ? args.selections : [])
          .filter(s => typeof s?.file === 'string')
          .map(s => ({ file: s.file, destination: s.destination, mode: s.mode === undefined ? defaultMode : normalizeMode(s.mode) }))
        if (selections.length === 0) return fail('bad-request', 'no sessions selected')
        if (selections.length > 500) return fail('bad-request', 'at most 500 sessions per import')
        // Selections that came from an upload: drop the upload once the job is done.
        const uploadId = typeof args.uploadId === 'string' && uploads.get(args.uploadId) !== undefined ? args.uploadId : undefined
        const started = jobs.start(services(), {
          source: args.source,
          mode: defaultMode,
          selections,
          archiveResultCap: config.archiveResultCap,
          onFinished: uploadId === undefined ? undefined : async () => { await uploads.discard(uploadId) },
        })
        const working = selections.filter(s => s.mode.kind === 'working').length
        log(`import-sessions: job ${started.jobId} started: ${selections.length} ${SOURCES[args.source].label} session(s), ${working} as working session(s)${uploadId ? `, from upload ${uploadId}` : ''}`)
        return ok(started)
      }
      case 'progress': {
        const progress = jobs.progress(String(args.jobId ?? ''))
        return progress === undefined ? fail('unknown-job', `unknown job ${String(args.jobId)}`) : ok(progress)
      }
      default:
        return fail('unknown-endpoint', `unknown endpoint ${endpoint}`)
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CHANNEL,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      const endpoint = new URL(req.url ?? '/', 'http://x').pathname.slice(CHANNEL.length + 1)
      if (req.method !== 'POST' || endpoint === '' || endpoint.includes('/')) { res.writeHead(404); res.end('not found'); return }
      let message
      try { message = JSON.parse(await readBody(req, UPLOAD_ENDPOINTS.has(endpoint) ? MAX_UPLOAD_BODY : MAX_BODY)) } catch { res.writeHead(400); res.end('body is not JSON or too large'); return }
      if (typeof message !== 'object' || message === null || message.type !== 'client-request' || typeof message.rpcId !== 'string' || message.method !== endpoint) {
        res.writeHead(400); res.end('invalid client-request envelope'); return
      }
      const args = typeof message.payload?.args === 'object' && message.payload.args !== null ? message.payload.args : {}
      const controller = new AbortController()
      req.on('close', () => { if (!res.writableEnded) controller.abort() })
      let result
      try {
        result = await dispatch(endpoint, args, controller.signal, req)
      } catch (error) {
        result = fail('internal', String(error?.message ?? error))
      }
      if (res.writableEnded) return
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result }))
    },
  }), 'import-sessions: control channel')

  log(`import-sessions: /import-claude (${collapseHome(roots.claude)}) and /import-pi (${collapseHome(roots.pi)}) ready`)
}

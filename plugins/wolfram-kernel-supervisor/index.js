/**
 * tali-wolfram-kernel-supervisor — per-chat Wolfram Language kernels for DSH.
 *
 * Mathematica 15 ships an MCP server inside the Wolfram/AgentTools paclet
 * (`Wolfram`AgentTools`StartMCPServer[]`, stdio). This plugin owns those
 * processes: one kernel per `wolfram_kernel_open` (or on first use), isolated
 * per chat session and addressed as wl:<session>:<kernel> (kernels.mjs), and
 * registers exactly the tools in tools.mjs into each eligible agent's scope.
 * Nothing else reaches the model: no mcp__wolfram__* names, no dsh-mcp-client.
 *
 * wolfram_show is the successor of the Pi `wolfram_Show` + rho `show.ts`
 * pair: Rasterize at 144 dpi in the chat's kernel, store the PNG as a durable
 * DSH attachment, hand the reference to the GUI through the tool's
 * `presentationMeta` (the browser half, src/client, renders it inline at
 * point size) and give the model one line of text.
 *
 * MANIPULATE. wolfram_show of a top-level Manipulate[body, {x,0,1}, …] becomes an
 * interactive widget: kernel/DSHPlugin.wl parses the simple control forms the
 * way Manipulate does, prints a JSON descriptor, and the GUI draws native
 * controls; on release the <img> reloads from GET /api/wolfram/manipulate?…
 * &values=[…], which re-rasterizes the held body in the same kernel with the
 * variables substituted. Widgets die with their kernel (410 → controls disable).
 *
 * SLASH COMMANDS (no model involved): `/wolfram-show <expression>` renders exactly
 * like the wolfram_show tool and returns the presentation payload as JSON in the
 * command result, which the browser half renders through the keyed
 * `conversation.chat.commandview` slot; `/wolfram <code>` evaluates in the
 * chat's default kernel and shows the output. `/wolfram-kernels` lists them.
 *
 * IMAGE ROUTE. The GUI reads durable attachments only after the core proves
 * the session log references them in a *content* image block; a reference
 * that lives solely in presentationMeta (the user-only path) is invisible to
 * that check ("Image is not referenced by this session"). So this plugin
 * serves its own images: GET /api/wolfram/shown?sessionId=…&attachmentId=…
 * (registered through ctx.connection.fetch, behind the normal browser auth),
 * authorized by proving the session's log holds a wolfram_show result whose
 * meta.attachment carries that id — live or cold session, so it survives
 * server restarts.
 *
 * LIFECYCLE. Nothing is spawned until a tool needs it. A per-session idle
 * timer (`idleMinutes`, reset by every call) closes the session's kernels and
 * injects a notice; agent disposal and plugin unload close everything. The
 * kernel ignores SIGTERM, so closing is Quit/EOF → SIGKILL (servers.mjs).
 *
 * Config (all optional):
 *
 *   kernel: ''                 # wolfram binary; '' = first of /Applications/Wolfram.app, Mathematica.app, Wolfram Engine.app, /usr/local/bin
 *   pacletDirectory: ''        # Wolfram/AgentTools paclet dir; '' = highest ~/Library/Wolfram/Paclets/Repository/Wolfram__AgentTools-*
 *   server: WolframLanguage    # MCP_SERVER_NAME profile (WolframLanguage | Wolfram | WolframAlpha)
 *   resolution: 144            # wolfram_show default dpi (144 = @2x)
 *   writeFiles: true           # also write show/eval PNGs to showDirectory
 *   showDirectory: ~/Library/Wolfram/DeepseekHarness   # PNGs written by wolfram_show / unadmitted wolfram_eval images
 *   theme: auto                # auto | light | dark — kernels render graphics for this appearance; auto follows
 *                              # DSH's Settings ▸ Appearance (ui-theme), resolving "system" via macOS AppleInterfaceStyle
 *   subagents: true            # delegated child agents get the tools too (each its own session)
 *   idleMinutes: 60            # close a session's kernels after this long unused (0 = never)
 *   maxKernelsPerSession: 4
 *   maxKernelsGlobal: 12
 *   toolCallTimeoutMs: 180000  # per MCP call (kernel evals can be long)
 *   traceFile: ''              # append JSON lifecycle lines here ('' = off)
 */

import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { resolve as resolvePath, sep } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { KernelSessions, evaluate } from './kernels.mjs'
import { findAgentToolsDirectory, findKernel, kernelLaunch } from './servers.mjs'
import { WOLFRAM_INSTALL_REMEDY, kernelStartRemedy, registerUnavailableStubs } from './environment.mjs'
import { createShowCore, createTools, parseShowReport, pngSize, showPresentation, stripReports } from './tools.mjs'

export const name = 'wolfram-kernel-supervisor'

export const inject = ['agents', 'tools', 'connection', 'commands']

export const Config = Schema.object({
  kernel: Schema.string().default(''),
  pacletDirectory: Schema.string().default(''),
  server: Schema.string().default('WolframLanguage'),
  resolution: Schema.number().min(36).max(576).default(144),
  writeFiles: Schema.boolean().default(true),
  showDirectory: Schema.string().default('~/Library/Wolfram/DeepseekHarness'),
  theme: Schema.union(['auto', 'light', 'dark']).default('auto'),
  subagents: Schema.boolean().default(true),
  idleMinutes: Schema.number().min(0).default(60),
  maxKernelsPerSession: Schema.number().min(1).default(4),
  maxKernelsGlobal: Schema.number().min(1).default(12),
  toolCallTimeoutMs: Schema.number().default(180_000),
  traceFile: Schema.string().default(''),
})

const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'wolfram-kernel-supervisor' }

/**
 * A complete user-role message for `agent.inject`. DSH's `UserMessage.content`
 * is a `ContentBlock[]`; injecting a bare string is persisted as-is and then
 * every later turn of that session fails with "content.some is not a function".
 * Mirrors `createUserMessage` in `@deepseek-ai/dsh-llm` (role + fresh id) without
 * taking the dependency.
 * @param {string} text - the notice text.
 */
function pluginNotice(text) {
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: PLUGIN_SOURCE }
}
/** Exact Fetch routes (below /api). Mirrored in src/client. */
export const SHOWN_IMAGE_PATH = '/api/wolfram/shown'
export const MANIPULATE_PATH = '/api/wolfram/manipulate'
export const OPEN_PATH = '/api/wolfram/open'
/** Kernel-side support code, Get[]'d once per kernel at bootstrap (DSHPlugin` context). */
export const KERNEL_PACKAGE = fileURLToPath(new URL('./kernel/DSHPlugin.wl', import.meta.url))

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - host-plane plugin context.
 * @param {ReturnType<typeof Config>} config - validated plugin config.
 */
export function apply(ctx, config) {
  const trace = (record) => {
    if (config.traceFile === '') return
    try { appendFileSync(config.traceFile, `${JSON.stringify({ t: new Date().toISOString(), ...record })}\n`) } catch { /* best effort */ }
  }

  const kernel = findKernel(config.kernel)
  if (kernel === undefined) {
    // Not inert: register the same tool names as stubs that fail with the
    // install instruction, so the model can tell the user what would unlock
    // them instead of concluding the tools do not exist.
    ctx.logger.warn(`wolfram-kernel-supervisor: no Wolfram kernel binary found${config.kernel ? ` at "${config.kernel}"` : ' (Wolfram.app / Mathematica.app / Wolfram Engine.app)'}; registering unavailable stubs`)
    registerUnavailableStubs(ctx, config, config.kernel)
    return
  }
  const pacletDirectory = findAgentToolsDirectory(config.pacletDirectory)
  if (pacletDirectory === undefined) {
    ctx.logger.warn('wolfram-kernel-supervisor: no Wolfram__AgentTools paclet directory found; falling back to the paclet-manager launch (~2 s slower per kernel). Install/update Wolfram/AgentTools in Mathematica 15+.')
  }
  const launch = kernelLaunch({ kernel, pacletDirectory, server: config.server })

  /** Label for one chat: session title when logged, else the short id. */
  function chatLabel(agent) {
    let title
    try { title = ctx.get('sessionProjections')?.stateOf(agent.session, 'title') } catch { /* no projection for this session shape */ }
    const text = typeof title === 'string' && title.trim() !== '' ? title.trim() : `chat ${agent.id.slice(-8)}`
    return text.replace(/\s+/g, ' ').slice(0, 60)
  }

  /**
   * The appearance kernels should render for. `auto` reads DSH's persisted
   * theme preference (settings namespace `ui-theme`, field `preference`;
   * absent/`system` when the user never changed it) and resolves `system`
   * through macOS (`defaults read -g AppleInterfaceStyle` prints "Dark" only in
   * dark mode). Decided once per kernel, at bootstrap — a theme switch applies
   * to kernels started afterwards.
   * @returns {'light' | 'dark'}
   */
  function resolveTheme() {
    if (config.theme !== 'auto') return config.theme
    let preference
    try { preference = ctx.get('settings')?.get('ui-theme')?.preference } catch { /* namespace unregistered */ }
    if (preference === 'light' || preference === 'dark') return preference
    if (process.platform === 'darwin') {
      try {
        return execFileSync('defaults', ['read', '-g', 'AppleInterfaceStyle'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'Dark' ? 'dark' : 'light'
      } catch { return 'light' } // the key is absent in light mode
    }
    return 'light'
  }

  /**
   * Per-kernel bootstrap code: pin the front-end appearance (Plot themes, Grid
   * frames, text colour follow it) and load the DSHPlugin` package that owns
   * Show / Render / RunScript (kernel/DSHPlugin.wl).
   */
  const kernelBootstrap = (theme) =>
    `UsingFrontEnd[CurrentValue[$FrontEndSession, LightDark] = ${theme === 'dark' ? '"Dark"' : '"Light"'}]; Get[${JSON.stringify(KERNEL_PACKAGE)}];`

  const sessions = new KernelSessions({
    spec: (session, kernelIndex) => {
      const theme = resolveTheme()
      session.theme = theme
      return {
        ...launch,
        clientName: `DSH ${chatLabel(session.agent)} · wl:${session.index}:${kernelIndex}`,
        cwd: session.agent.session.header?.cwd,
        bootstrap: kernelBootstrap(theme),
      }
    },
    timeoutMs: config.toolCallTimeoutMs,
    idleMs: config.idleMinutes * 60_000,
    maxPerSession: config.maxKernelsPerSession,
    maxGlobal: config.maxKernelsGlobal,
    onIdleClose: (agent, closed) => {
      try {
        agent.inject(pluginNotice(
          `[wolfram-kernel-supervisor] Closed idle Wolfram kernel(s) ${closed.join(', ')} after ${config.idleMinutes} min without use; their definitions are gone. Any wolfram_* call starts a fresh kernel.`,
        ))
      } catch { /* agent disposed or not accepting injections */ }
    },
    trace,
    logger: ctx.logger,
  })

  /** Model-gated admission (same rule as dsh-mcp-client): only when the current model declares image input. */
  async function admitImage(exec, bytes, name, mediaType = 'image/png') {
    const attachments = ctx.get('attachments')
    if (attachments === undefined) return { reason: 'no attachment store is mounted' }
    const routed = exec.agent?.session.requestHeader?.()?.config
    const provider = routed?.provider ?? exec.agent?.options?.provider
    const model = routed?.model ?? exec.agent?.options?.model
    const llm = ctx.get('llm')
    if (provider === undefined || model === undefined || llm === undefined) return { reason: 'the current model route could not be resolved' }
    let info
    try { info = await llm.resolveModelInfo(provider, model, exec.signal) } catch { return { reason: 'the current model route could not be verified' } }
    if (!info.inputModalities?.includes('image')) return { reason: `model "${model}" does not declare image input` }
    try {
      const [ref] = await attachments.saveImages([{ data: bytes, mediaType, name }])
      return { ref }
    } catch (error) {
      return { reason: `attachment store rejected the image: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** Ungated admission for user-facing images (wolfram_show): the model never receives these. */
  async function storeImage(bytes, name) {
    const attachments = ctx.get('attachments')
    if (attachments === undefined) return { reason: 'no attachment store is mounted' }
    try {
      const [ref] = await attachments.saveImages([{ data: bytes, mediaType: 'image/png', name }])
      return { ref }
    } catch (error) {
      return { reason: `attachment store rejected the image: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  const deps = {
    sessions, admitImage, storeImage, labelOf: chatLabel, trace,
    config: { resolution: config.resolution, writeFiles: config.writeFiles, showDirectory: config.showDirectory },
    themeOf: (kernel) => kernel.theme ?? 'light',
  }


  // ---------------------------------------------------------------- shown-image route

  /** Whether the session's log holds a wolfram_show result whose meta references the attachment. */
  async function sessionShows(sessionId, attachmentId) {
    const live = ctx.get('sessions')?.get?.(sessionId)
    let events
    let observation
    if (live !== undefined) {
      events = live.snapshotEvents()
    } else {
      const query = ctx.get('sessionQuery')
      if (query === undefined) return undefined
      try {
        observation = await query.observeSession(sessionId, { projectionMode: 'none' })
        events = observation.events
      } catch {
        return undefined
      }
    }
    try {
      for (const event of events) {
        let ref
        if (event.type === 'tool/result') ref = event.data?.meta?.attachment
        else if (event.type === 'command/done' && typeof event.data?.text === 'string' && event.data.text.includes(attachmentId)) {
          try { ref = JSON.parse(event.data.text)?.attachment } catch { /* not a wolfram command payload */ }
        } else continue
        if (ref && typeof ref === 'object' && String(ref.attachmentId) === attachmentId) return ref
      }
      return undefined
    } finally {
      observation?.[Symbol.dispose]?.()
      await observation?.[Symbol.asyncDispose]?.()
    }
  }

  ctx.connection.fetch.register({
    path: SHOWN_IMAGE_PATH,
    methods: ['GET', 'HEAD'],
    fetch: async (request) => {
      const url = new URL(request.url)
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const attachmentId = url.searchParams.get('attachmentId') ?? ''
      if (sessionId === '' || attachmentId === '') return new Response('missing sessionId or attachmentId', { status: 400 })
      const attachments = ctx.get('attachments')
      if (attachments === undefined) return new Response('no attachment store', { status: 500 })
      const ref = await sessionShows(sessionId, attachmentId)
      if (ref === undefined) return new Response('image is not a wolfram_show result of this session', { status: 404 })
      let stored
      try { stored = await attachments.readImage(ref) } catch (error) { return new Response(`attachment read failed: ${error instanceof Error ? error.message : String(error)}`, { status: 404 }) }
      const headers = { 'content-type': stored.ref.mediaType, 'content-length': String(stored.data.byteLength), 'cache-control': 'private, max-age=31536000, immutable' }
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
      return new Response(stored.data, { status: 200, headers })
    },
  })


  const showCore = createShowCore(deps)

  // ---------------- interactive Manipulate renders

  /** Find a live, supervised kernel of the given session by id (both ids come from the browser, untrusted). */
  function kernelFor(sessionId, kernelId) {
    for (const session of sessions.sessions.values()) {
      const agent = session.agent
      if (agent.id !== sessionId && agent.session?.id !== sessionId) continue
      for (const kernel of session.kernels.values()) {
        if (kernel.id === kernelId && kernel.conn !== undefined && !kernel.conn.closed) return kernel
      }
    }
    return undefined
  }

  /** Validate browser-supplied control values against the stored descriptor; returns Wolfram list source or undefined. */
  function wolframValues(descriptor, values) {
    if (!Array.isArray(values) || values.length !== descriptor.controls.length) return undefined
    const out = []
    for (const [i, control] of descriptor.controls.entries()) {
      const v = values[i]
      if (control.type === 'slider') {
        if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
        const clamped = Math.min(control.max, Math.max(control.min, v))
        out.push(Number.isInteger(clamped) ? `${clamped}.` : String(clamped))
      } else if (control.type === 'checkbox') {
        out.push(v === true ? 'True' : 'False')
      } else {
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v >= control.choices.length) return undefined
        out.push(String(v))
      }
    }
    return `{${out.join(', ')}}`
  }

  ctx.connection.fetch.register({
    path: MANIPULATE_PATH,
    methods: ['GET', 'HEAD'],
    fetch: async (request) => {
      const url = new URL(request.url)
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const kernelId = url.searchParams.get('kernelId') ?? ''
      const id = url.searchParams.get('id') ?? ''
      let values
      try { values = JSON.parse(url.searchParams.get('values') ?? '') } catch { return new Response('values must be a JSON array', { status: 400 }) }
      const kernel = kernelFor(sessionId, kernelId)
      if (kernel === undefined) return new Response(`kernel ${kernelId || '?'} is not running for this chat; re-run wolfram_show`, { status: 410 })
      const entry = kernel.manipulates?.get(id)
      if (entry === undefined) return new Response(`no interactive graphic "${id}" in kernel ${kernelId}; re-run wolfram_show`, { status: 410 })
      const list = wolframValues(entry.descriptor, values)
      if (list === undefined) return new Response('values do not match the controls', { status: 400 })
      let result
      const t0 = Date.now()
      try {
        result = await evaluate(kernel, `DSHPlugin\`Render[${JSON.stringify(id)}, ${list}]`)
      } catch (error) {
        return new Response(`render failed: ${error instanceof Error ? error.message : String(error)}`, { status: 500 })
      }
      const totalMs = Date.now() - t0
      const report = parseShowReport(result.text)
      if (report !== undefined && !report.ok) {
        // 422: the body failed for these values (messages / timeout); the widget keeps its last frame and shows why.
        return new Response(JSON.stringify({ error: report.error, messages: report.messages, timedOut: report.timedOut }), { status: 422, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
      }
      const image = result.images.find(i => i.mediaType === 'image/png') ?? result.images[0]
      if (image === undefined) return new Response(`render produced no image: ${stripReports(result.text).slice(0, 500)}`, { status: 500 })
      const size = pngSize(image.data)
      // &save=1: also write this frame to the show directory (the picture icon → Preview) and report the path.
      let savedPath
      if (url.searchParams.get('save') === '1') {
        try { savedPath = await showCore.writeShowFile(image.data, entry.scale) } catch { /* reported as absent */ }
      }
      const headers = {
        'content-type': image.mediaType, 'content-length': String(image.data.byteLength), 'cache-control': 'no-store',
        ...(savedPath !== undefined ? { 'x-wolfram-path': encodeURIComponent(savedPath) } : {}),
        'x-wolfram-scale': String(entry.scale), ...(size ? { 'x-wolfram-width': String(size.width), 'x-wolfram-height': String(size.height) } : {}),
        'x-wolfram-eval-ms': String(report?.evalMs ?? ''), 'x-wolfram-raster-ms': String(report?.rasterMs ?? ''), 'x-wolfram-kernel-ms': String(report?.kernelMs ?? ''), 'x-wolfram-total-ms': String(totalMs),
        'x-wolfram-error-image': report?.errorImage ? '1' : '0',
      }
      trace({ event: 'manipulate-render', kernelId, id, values, evalMs: report?.evalMs ?? null, rasterMs: report?.rasterMs ?? null, totalMs })
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
      return new Response(image.data, { status: 200, headers })
    },
  })


  // ---------------- slash commands and the open route

  const showDirectory = () => resolvePath(config.showDirectory.replace(/^~(?=\/|$)/, homedir()))

  ctx.effect(() => ctx.commands.register({
    name: 'wolfram-show',
    description: 'Render a Wolfram Language expression in this chat\'s kernel and show it inline (Manipulate becomes interactive). No model involved.',
    input: { hint: 'expression, e.g. Plot[Sin[x], {x, 0, 2 Pi}]' },
    handler: async (invocation) => {
      const expression = invocation.rawInput.trim()
      if (expression === '') return { kind: 'error', text: 'usage: /wolfram-show <expression>' }
      try {
        const value = await showCore.show(invocation.agent, { expression, label: '' })
        delete value.pngBytes
        return { kind: 'success', text: JSON.stringify({ dsh: 'wolfram-show', expression, opened: value.opened, ...showPresentation(value) }) }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  }), 'wolfram-kernel-supervisor: /wolfram-show')

  ctx.effect(() => ctx.commands.register({
    name: 'wolfram',
    description: 'Evaluate Wolfram Language code in this chat\'s kernel and show the output. No model involved.',
    input: { hint: 'code, e.g. Integrate[Sin[x]^2, x]' },
    handler: async (invocation) => {
      const code = invocation.rawInput.trim()
      if (code === '') return { kind: 'error', text: 'usage: /wolfram <code>' }
      try {
        const { kernel, opened } = await sessions.resolve(invocation.agent, undefined)
        const { text, images } = await evaluate(kernel, code)
        const note = images.length > 0 ? `\n[${images.length} graphic${images.length === 1 ? '' : 's'} not shown — use /wolfram-show for graphics]` : ''
        return { kind: 'success', text: `${opened ? `Opened kernel ${kernel.id}. ` : ''}[${kernel.id}]\n${text || '(no output)'}${note}` }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  }), 'wolfram-kernel-supervisor: /wolfram')

  ctx.effect(() => ctx.commands.register({
    name: 'wolfram-kernels',
    description: 'List this chat\'s Wolfram kernels.',
    handler: async (invocation) => {
      const own = sessions.listOwn(invocation.agent)
      if (own.kernels.length === 0) return { kind: 'success', text: 'This chat has no Wolfram kernel running.' }
      return { kind: 'success', text: own.kernels.map(k => `${k.kernelId}${k.default ? ' *' : ''}  pid ${k.pid}  ${k.theme}  idle ${k.idleSeconds}s  evals ${k.evalCount}`).join('\n') }
    },
  }), 'wolfram-kernel-supervisor: /wolfram-kernels')

  /** GET /api/wolfram/open?path=… — open a PNG or .wl this plugin wrote with the system default app (paths under showDirectory only). */
  ctx.connection.fetch.register({
    path: OPEN_PATH,
    methods: ['GET', 'HEAD'],
    fetch: async (request) => {
      const raw = new URL(request.url).searchParams.get('path') ?? ''
      const path = resolvePath(raw)
      const root = showDirectory()
      if (raw === '' || !(path === root || path.startsWith(root + sep)) || !/\.(png|wl)$/.test(path)) return new Response('not a wolfram_show image or source path', { status: 403 })
      if (request.method === 'HEAD') return new Response(null, { status: 200 })
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
      await new Promise((done) => execFile(opener, [path], () => done()))
      trace({ event: 'open', path })
      return new Response('opened', { status: 200, headers: { 'content-type': 'text/plain' } })
    },
  })

  /** Plugin-owned disposer of each attached agent's scoped tool registrations. */
  const attached = new Map()

  function attach(agent) {
    if (attached.has(agent)) return
    const depth = agent.session.header?.delegationDepth ?? 0
    if (depth > 0 && !config.subagents) return
    const dispose = ctx.effect(() => {
      const disposers = createTools(deps, agent).map(tool => agent.ctx.tools.register(tool))
      return () => { for (const dispose of disposers) dispose() }
    }, 'wolfram-kernel-supervisor.tools')
    attached.set(agent, dispose)
    trace({ event: 'attach', id: agent.id, depth })
  }

  for (const agent of ctx.agents.list()) attach(agent)
  ctx.on('agent/created', ({ agent }) => { attach(agent) })

  ctx.on('agent/disposed', ({ agent }) => {
    const dispose = attached.get(agent)
    if (dispose !== undefined) {
      attached.delete(agent)
      void dispose()
    }
    void sessions.forget(agent, 'agent-disposed').catch((error) => {
      ctx.logger.warn(`wolfram-kernel-supervisor: closing kernels of disposed agent "${agent.id}" failed: ${String(error)}`)
    })
  })

  // Plugin unload: every session's kernels.
  ctx.effect(() => async () => { await sessions.dispose() }, 'wolfram-kernel-supervisor.kernels')
}

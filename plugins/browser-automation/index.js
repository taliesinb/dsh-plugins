/**
 * tali-browser-automation — per-chat Safari and Chrome, curated tools only.
 *
 * The plugin owns the MCP forwarding: it holds private MCP SDK connections to
 * Apple's Safari MCP server (`safaridriver --mcp`, Safari Technology Preview)
 * and Google's `chrome-devtools-mcp`, and registers exactly the tools in
 * curated-tools.mjs (`safari_*`, `chrome_*`) into each eligible agent's scope.
 * Nothing else reaches the model: no `mcp__server__tool` names, no raw tools,
 * no dsh-mcp-client. Per-session behavior needs no dynamic registration — the
 * tool set is static and every call reads `exec.agent` to find the caller's
 * windows (windows.mjs).
 *
 * WINDOWS. `safari_open` / `chrome_open` return ids like `s:0:2` / `c:0:0`
 * (session index, then window index within that session). Every window tool
 * takes an optional `windowId`; omitted, the browser must have zero or one
 * window in the session (zero opens one). A Safari window is its own
 * `safaridriver --mcp` process (own STP window, banner labeled with the chat
 * and the id); Chrome windows are pages of one isolated Chrome instance per
 * session. Ids are validated against the caller's session.
 *
 * LIFECYCLE. Nothing is spawned until a tool needs it. A per-session idle timer
 * (`idleMinutes`, reset by every tool call) closes all of a session's windows
 * and injects a notice; agent disposal and plugin unload close everything.
 * Web sessions are never disposed by DSH itself, hence the timer.
 *
 * READERS. `safari_get_page_content` with a url (and no windowId) and
 * `safari_get_youtube_notes` read in a host-wide pool of isolated Safari
 * readers (reader-pool.mjs), never in a chat's own window.
 *
 * Config (all optional):
 *
 *   safari:
 *     enabled: true
 *     driver: /Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver
 *     labelPrefix: 'DSH: '    # STP banner: "This window is controlled by DSH: <chat title> · s:0:0."
 *     reader:                 # isolated reader pool
 *       enabled: true
 *       maxIdle: 1            # readers kept warm after a read
 *       idleMinutes: 30       # close warm readers after this long unused (0 = never)
 *       maxChars: 120000      # truncate returned page content beyond this (full text saved to a file)
 *   chrome:
 *     enabled: true
 *     command: ''             # '' = the chrome-devtools-mcp pinned in this plugin's package.json (run with the host's node);
 *                             #      a path overrides it (e.g. /opt/homebrew/bin/chrome-devtools-mcp from npm i -g)
 *     headless: false
 *     hideAutomationBanner: true                       # drop --enable-automation (no infobar)
 *     quietStderr: true                                # drop chrome-devtools-mcp's launch boilerplate from stderr
 *     args: []                                         # extra chrome-devtools-mcp flags
 *   subagents: true           # also give delegated child agents the tools (each its own session)
 *   idleMinutes: 30           # close a session's windows after this long without a tool call (0 = never)
 *   toolCallTimeoutMs: 60000  # per MCP call
 *   traceFile: ''             # append JSON lifecycle lines here (debugging; '' = off)
 */

import { CHROME_INSTALL_REMEDY, STP_INSTALL_REMEDY, checkSafariTechnologyPreview, findChrome } from './environment.mjs'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { createTools } from './curated-tools.mjs'
import { createReaderPool } from './reader-pool.mjs'
import { CHROME_STDERR_NOISE, safariInstance } from './servers.mjs'
import { BrowserSessions } from './windows.mjs'

export const name = 'browser-automation'

export const inject = ['agents', 'tools']

export const Config = Schema.object({
  safari: Schema.object({
    enabled: Schema.boolean().default(true),
    driver: Schema.string().default('/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver'),
    labelPrefix: Schema.string().default('DSH: '),
    reader: Schema.object({
      enabled: Schema.boolean().default(true),
      maxIdle: Schema.number().min(0).default(1),
      idleMinutes: Schema.number().min(0).default(30),
      maxChars: Schema.number().min(1000).default(120_000),
    }).default({}),
  }).default({}),
  chrome: Schema.object({
    enabled: Schema.boolean().default(true),
    command: Schema.string().default(''),
    headless: Schema.boolean().default(false),
    hideAutomationBanner: Schema.boolean().default(true),
    quietStderr: Schema.boolean().default(true),
    args: Schema.array(String).default([]),
  }).default({}),
  subagents: Schema.boolean().default(true),
  idleMinutes: Schema.number().min(0).default(30),
  toolCallTimeoutMs: Schema.number().default(60_000),
  traceFile: Schema.string().default(''),
})

const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'browser-automation' }

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

/**
 * The chrome-devtools-mcp to run: `{ command, args }` prefix for the spawn, plus a description for
 * messages. Default (`chrome.command: ''`) is the version pinned in this plugin's package.json — its bin
 * script run by the host's own node (`process.execPath`), so no global install, PATH or shebang is
 * involved and `pnpm install` in the plugin directory is the whole upgrade procedure. A non-empty
 * `chrome.command` is an executable path and is used verbatim (the previous `npm i -g` arrangement).
 * @returns {{ command: string, args: string[], describe: string, missing?: string }}
 */
export function chromeServer(config) {
  if (config.chrome.command !== '') {
    return existsSync(config.chrome.command)
      ? { command: config.chrome.command, args: [], describe: config.chrome.command }
      : { command: config.chrome.command, args: [], describe: config.chrome.command, missing: `no chrome-devtools-mcp at "${config.chrome.command}" (chrome.command). Install it with \`npm i -g chrome-devtools-mcp\`, or set chrome.command to '' to use the version bundled with the plugin` }
  }
  let packageJson
  try {
    packageJson = createRequire(import.meta.url).resolve('chrome-devtools-mcp/package.json')
  } catch {
    return { command: process.execPath, args: [], describe: 'bundled chrome-devtools-mcp', missing: 'the bundled chrome-devtools-mcp is not installed: run `pnpm install` in the plugin directory (or set chrome.command to a global install)' }
  }
  const bin = join(dirname(packageJson), 'build/src/bin/chrome-devtools-mcp.js')
  const version = (() => { try { return JSON.parse(readFileSync(packageJson, 'utf8')).version } catch { return '?' } })()
  return { command: process.execPath, args: [bin], describe: `bundled chrome-devtools-mcp ${version}`, ...(existsSync(bin) ? {} : { missing: `bundled chrome-devtools-mcp ${version} has no bin at ${bin}` }) }
}

/**
 * Chrome server arguments derived from config (always an isolated profile). `--no-performance-crux`:
 * the plugin exposes no performance tools, and the flag also silences the CrUX notice on launch.
 */
export function chromeArgs(config) {
  return [
    ...chromeServer(config).args,
    '--isolated',
    '--no-usage-statistics',
    '--no-performance-crux',
    ...(config.chrome.headless ? ['--headless'] : []),
    ...(config.chrome.hideAutomationBanner ? ['--ignoreDefaultChromeArg=--enable-automation'] : []),
    ...config.chrome.args,
  ]
}

/**
 * Environment for a chrome-devtools-mcp child (merged over the MCP SDK's safe default set).
 * - CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: no "Update available" banner and no daily `npm view`
 *   subprocess (utils/check-for-updates.js); the version is pinned in package.json.
 * - NODE_OPTIONS --localstorage-file: the server touches `localStorage` (devtools/DevtoolsUtils.js);
 *   Node ≥ 22 prints an ExperimentalWarning per launch unless a backing file is named. One 4 kB file per
 *   session under the temp dir, removed when the instance closes.
 * @param {string} localStorageFile - absolute path for Node's localStorage backing file.
 */
export function chromeEnv(localStorageFile) {
  return {
    CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
    NODE_OPTIONS: `--localstorage-file=${localStorageFile}`,
  }
}

/**
 * Reject before spawning when a server executable is absent, with the exact
 * remedy. Classic Safari cannot substitute for STP: stable Safari's
 * /usr/bin/safaridriver has no --mcp mode, so there is no server to fall back to.
 */
export function preflightFor(config) {
  return (browser) => {
    if (browser === 'safari') {
      if (!config.safari.enabled) throw new Error('Safari automation is disabled in this deployment (safari.enabled=false).')
      if (checkSafariTechnologyPreview(config.safari.driver) === 'missing') {
        throw new Error(`Safari automation is unavailable: no safaridriver at "${config.safari.driver}" (Safari Technology Preview is not installed). ${STP_INSTALL_REMEDY}`)
      }
      return
    }
    if (!config.chrome.enabled) throw new Error('Chrome automation is disabled in this deployment (chrome.enabled=false).')
    const server = chromeServer(config)
    if (server.missing !== undefined) {
      throw new Error(`Chrome automation is unavailable: ${server.missing}. Google Chrome must also be installed. Or use the safari_* tools.`)
    }
    // The browser itself, not just the MCP server: a missing Chrome otherwise
    // surfaces as a launch-time "Target closed" that reads like a page error.
    if (config.chrome.args.every(arg => !arg.startsWith('--executablePath') && !arg.startsWith('--browserUrl') && arg !== '--autoConnect') && findChrome() === undefined) {
      throw new Error(`Chrome automation is unavailable: Google Chrome is not installed on this machine. ${CHROME_INSTALL_REMEDY}`)
    }
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - host-plane plugin context.
 * @param {ReturnType<typeof Config>} config - validated plugin config.
 */
export function apply(ctx, config) {
  if (!config.safari.enabled && !config.chrome.enabled) {
    ctx.logger.warn('browser-automation: no browser enabled; plugin is inert')
    return
  }
  const trace = (record) => {
    if (config.traceFile === '') return
    try {
      appendFileSync(config.traceFile, `${JSON.stringify({ t: new Date().toISOString(), ...record })}\n`)
    } catch {
      // Best-effort debugging output; never affects the session.
    }
  }
  const preflight = preflightFor(config)

  /** Banner label for one chat: prefix + session title (when logged) or short id. */
  function chatLabel(agent) {
    let title
    try {
      title = ctx.get('sessionProjections')?.stateOf(agent.session, 'title')
    } catch {
      // Projection absent for this session shape; fall back to the id.
    }
    const text = typeof title === 'string' && title.trim() !== '' ? title.trim() : `chat ${agent.id.slice(-8)}`
    return `${config.safari.labelPrefix}${text}`.replace(/\s+/g, ' ').slice(0, 70)
  }

  const sessions = new BrowserSessions({
    safariSpec: (session, windowIndex) => ({
      command: config.safari.driver,
      args: ['--mcp'],
      clientName: `${chatLabel(session.agent)} · s:${session.index}:${windowIndex}`,
      cwd: session.agent.session.header?.cwd,
    }),
    chromeSpec: (session) => {
      const cwd = session.agent.session.header?.cwd
      const localStorageFile = join(tmpdir(), `dsh-chrome-${process.pid}-${session.index}-localstorage.json`)
      const label = `chrome-devtools-mcp c:${session.index}`
      return {
        command: chromeServer(config).command,
        args: chromeArgs(config),
        clientName: `${chatLabel(session.agent)} · c:${session.index}`,
        cwd,
        env: chromeEnv(localStorageFile),
        roots: cwd !== undefined ? [cwd] : [],
        // Boilerplate is dropped (CHROME_STDERR_NOISE); anything else the server says is worth a log line.
        ...(config.chrome.quietStderr ? { stderrNoise: CHROME_STDERR_NOISE } : {}),
        onStderr: (line) => {
          ctx.logger.warn(`browser-automation: ${label}: ${line}`)
          trace({ event: 'chrome-stderr', session: session.index, line })
        },
        dispose: () => rm(localStorageFile, { force: true }).catch(() => {}),
      }
    },
    timeoutMs: config.toolCallTimeoutMs,
    idleMs: config.idleMinutes * 60_000,
    onIdleClose: (agent, closed) => {
      try {
        agent.inject(pluginNotice(
          `[browser-automation] Closed idle browser window(s) ${closed.join(', ')} after ${config.idleMinutes} min without use. Any safari_*/chrome_* call opens a fresh window.`,
        ))
      } catch {
        // The agent may be disposed or not accepting injections; the windows are closed either way.
      }
    },
    trace,
    logger: ctx.logger,
  })

  const readerPool = config.safari.enabled && config.safari.reader.enabled
    ? createReaderPool({
      driver: config.safari.driver,
      labelPrefix: config.safari.labelPrefix,
      maxIdle: config.safari.reader.maxIdle,
      idleMs: config.safari.reader.idleMinutes * 60_000,
      readTimeoutMs: config.toolCallTimeoutMs,
      trace,
      logger: ctx.logger,
    })
    : undefined

  /** Same admission rule as dsh-mcp-client: store the image only when the current model declares image input. */
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
    const [ref] = await attachments.saveImages([{ data: bytes, mediaType, name }])
    return { ref }
  }

  /** Admitted inline screenshots awaiting finalizeContent, keyed by execution. */
  const inlineImages = new WeakMap()
  const deps = { sessions, readerPool, admitImage, inlineImages, preflight, limits: { maxChars: config.safari.reader.maxChars, timeoutMs: config.toolCallTimeoutMs } }

  /** Plugin-owned disposer of each attached agent's scoped tool registrations. */
  const attached = new Map()

  /**
   * Register the curated tools into one agent's scope. Owned by BOTH lifetimes:
   * they unwind with the agent's scope, and this plugin's effect removes them
   * on unload/reload (effect disposers are idempotent).
   */
  function attach(agent) {
    if (attached.has(agent)) return
    const depth = agent.session.header?.delegationDepth ?? 0
    if (depth > 0 && !config.subagents) return
    const dispose = ctx.effect(() => {
      const disposers = createTools(deps, agent)
        .filter(tool => (tool.name.startsWith('safari_') ? config.safari.enabled : config.chrome.enabled))
        .map(tool => agent.ctx.tools.register(tool))
      return () => { for (const dispose of disposers) dispose() }
    }, 'browser-automation.tools')
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
      ctx.logger.warn(`browser-automation: closing windows of disposed agent "${agent.id}" failed: ${String(error)}`)
    })
  })

  // Plugin unload: every session's windows and the reader pool.
  ctx.effect(() => async () => {
    await sessions.dispose()
    await readerPool?.dispose()
    await safariInstance.dispose()
  }, 'browser-automation.mounts')
}

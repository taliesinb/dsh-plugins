/**
 * Per-session Wolfram kernels.
 *
 * Every DSH agent (chat or subagent) that uses a kernel gets a session index
 * M (consecutive over this plugin instance's lifetime). Within a session,
 * kernels are numbered N from 0 and addressed as
 *
 *   wl:<session>:<kernel>      one `StartMCPServer[]` process per kernel
 *                              (its own controlling kernel + its own sandboxed
 *                              evaluator kernel + one evaluator `session` id).
 *
 * Tools take an optional `kernelId`. When omitted, the session's LAST-STARTED
 * live kernel is used; a session with none gets a fresh one (`opened: true`).
 * Ids are validated against the caller's session, so no agent can reach
 * another agent's kernel; `wolfram_kernel_list global:true` is read-only.
 *
 * An idle timer per session (reset by every tool call) closes everything
 * after `idleMs`; agent disposal and plugin unload close everything at once.
 *
 * Mirrors browser-automation/windows.mjs (BrowserSessions).
 */

import { connectKernel, imagesOf, isAlive, scanKernelProcesses } from './servers.mjs'

const ID = /^wl:(\d+):(\d+)$/

/** A Wolfram string literal for `s`. */
export function wlString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Drop the evaluator's `<system-reminder>…</system-reminder>` blocks (session id, image hint). */
export function stripReminders(text) {
  return text.replace(/\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '\n').trim()
}

/**
 * Run code in a kernel's evaluator session.
 * @param {Kernel} kernel
 * @param {string} code
 * @param {{ timeConstraint?: number }} [opts]
 * @returns {Promise<{ text: string, images: { data: Uint8Array, mediaType: string }[] }>}
 */
export async function evaluate(kernel, code, opts = {}) {
  const args = {
    code,
    ...(kernel.evalSession !== undefined ? { session: kernel.evalSession } : {}),
    ...(opts.timeConstraint !== undefined ? { timeConstraint: opts.timeConstraint } : {}),
  }
  const result = await kernel.conn.callRaw('WolframLanguageEvaluator', args)
  const raw = (result.content ?? []).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
  const session = /Pass session="([^"]+)"/.exec(raw)
  if (session !== null) kernel.evalSession = session[1]
  kernel.lastUsedAt = Date.now()
  kernel.evalCount += 1
  const text = stripReminders(raw)
  if (result.isError) throw new Error(text || 'Wolfram evaluation failed')
  return { text, images: imagesOf(result) }
}

export class KernelSessions {
  /**
   * @param {object} options
   * @param {(session: Session, kernelIndex: number) => { command: string, args: string[], env: object, cwd?: string, clientName: string, bootstrap?: string }} options.spec - `bootstrap`: extra Wolfram code run once after SetDirectory (e.g. the light/dark front-end setting)
   * @param {number} options.timeoutMs - per MCP call.
   * @param {number} options.idleMs - 0 disables idle closing.
   * @param {number} options.maxPerSession
   * @param {number} options.maxGlobal
   * @param {(agent: object, closed: string[]) => void} options.onIdleClose
   * @param {(record: object) => void} options.trace
   * @param {{ warn(message: string): void }} options.logger
   */
  constructor(options) {
    this.options = options
    /** @type {Map<object, Session>} */
    this.sessions = new Map()
    this.nextSession = 0
  }

  /** The calling agent's session, created on first use. */
  session(agent, create = true) {
    let session = this.sessions.get(agent)
    if (session === undefined && create) {
      session = { index: this.nextSession++, agent, kernels: new Map(), order: [], nextKernel: 0, timer: undefined }
      this.sessions.set(agent, session)
      this.options.trace({ event: 'session', id: agent.id, session: session.index })
    }
    return session
  }

  id(session, kernelIndex) { return `wl:${session.index}:${kernelIndex}` }

  /** Parse and validate a kernel id against the caller's session. */
  parse(agent, kernelId) {
    const match = ID.exec(String(kernelId).trim())
    if (match === null) throw new Error(`Invalid kernelId "${kernelId}": expected wl:<session>:<kernel> (from wolfram_kernel_open or wolfram_kernel_list).`)
    const session = this.session(agent, false)
    if (session === undefined || session.index !== Number(match[1])) {
      throw new Error(`kernelId "${kernelId}" does not belong to this chat session${session === undefined ? '' : ` (this session is ${session.index})`}. Your kernels: ${this.ids(agent).join(', ') || '(none)'}.`)
    }
    return { session, kernelIndex: Number(match[2]) }
  }

  ids(agent) {
    const session = this.session(agent, false)
    return session === undefined ? [] : session.order.map(i => this.id(session, i))
  }

  /** The session's default kernel: the last-started one still alive. */
  defaultOf(session) {
    for (let i = session.order.length - 1; i >= 0; i--) {
      const kernel = session.kernels.get(session.order[i])
      if (kernel !== undefined && (kernel.conn === undefined || !kernel.conn.closed)) return kernel
    }
    return undefined
  }

  total() {
    let n = 0
    for (const session of this.sessions.values()) n += session.kernels.size
    return n
  }

  /**
   * Spawn a new kernel in the caller's session and make it the default. The
   * kernel is registered (and ordered) at reservation time, so ids and the
   * "last-started" default follow open() call order even when several opens
   * run in parallel; `ready` settles after the bootstrap eval.
   */
  async open(agent, label) {
    const session = this.session(agent)
    if (session.kernels.size >= this.options.maxPerSession) {
      throw new Error(`This chat already has ${session.kernels.size} kernels open (${this.ids(agent).join(', ')}); the limit is ${this.options.maxPerSession}. Close one with wolfram_kernel_close first.`)
    }
    if (this.total() >= this.options.maxGlobal) {
      throw new Error(`${this.total()} Wolfram kernels are open across all chats (limit ${this.options.maxGlobal}). Close some (wolfram_kernel_list global:true shows them) or raise maxKernelsGlobal.`)
    }
    // spec() may refuse (no kernel configured): ask before reserving an index.
    const spec = this.options.spec(session, session.nextKernel)
    const kernelIndex = session.nextKernel++
    const id = this.id(session, kernelIndex)
    const startedAt = Date.now()
    /** @type {Kernel} */
    const kernel = {
      id, index: kernelIndex, label: label ?? '', conn: undefined, pid: undefined, sandboxPid: undefined,
      evalSession: undefined, startedAt, lastUsedAt: startedAt, evalCount: 0, cwd: spec.cwd ?? process.cwd(), startupMs: 0, ready: undefined, theme: session.theme ?? 'light', manipulates: new Map(),
    }
    session.kernels.set(kernelIndex, kernel)
    session.order.push(kernelIndex)
    const unregister = () => {
      if (session.kernels.get(kernelIndex) === kernel) {
        session.kernels.delete(kernelIndex)
        session.order = session.order.filter(i => i !== kernelIndex)
      }
    }
    kernel.ready = (async () => {
      try {
        kernel.conn = await connectKernel({
          ...spec,
          timeoutMs: this.options.timeoutMs,
          onClose: () => {
            if (session.kernels.get(kernelIndex) === kernel) {
              unregister()
              this.options.trace({ event: 'kernel-lost', id: agent.id, kernelId: id })
            }
          },
          onError: (error) => this.options.logger.warn(`wolfram-kernel-supervisor: ${id} transport error: ${String(error)}`),
        })
        kernel.pid = kernel.conn.pid
      } catch (error) {
        unregister()
        throw error
      }
      // Bootstrap: pin the evaluator to the chat's cwd, learn the sandbox pid,
      // capture the evaluator session id, and absorb the ~6 s first-eval autoload.
      try {
        const { text } = await evaluate(kernel, `SetDirectory[${wlString(kernel.cwd)}]; ${spec.bootstrap ?? ''} $ProcessID`)
        const pid = /(\d+)\s*$/.exec(text)
        if (pid !== null) kernel.sandboxPid = Number(pid[1])
        kernel.evalCount = 0
      } catch (error) {
        await this.closeKernel(session, kernel, 'bootstrap-failed')
        throw new Error(`Wolfram kernel ${id} started but its evaluator failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      kernel.startupMs = Date.now() - startedAt
      this.options.trace({ event: 'kernel-open', id: agent.id, kernelId: id, pid: kernel.pid, sandboxPid: kernel.sandboxPid, startupMs: kernel.startupMs })
      return kernel
    })()
    await kernel.ready
    this.touch(agent)
    return kernel
  }

  /**
   * The kernel a tool should use.
   * @returns {Promise<{ kernel: Kernel, opened: boolean }>}
   */
  async resolve(agent, kernelId) {
    if (kernelId !== undefined && kernelId !== null && kernelId !== '') {
      const { session, kernelIndex } = this.parse(agent, kernelId)
      const kernel = session.kernels.get(kernelIndex)
      if (kernel === undefined || kernel.conn?.closed) {
        throw new Error(`Kernel "${kernelId}" is not running (closed, crashed, or idle-reaped). Your kernels: ${this.ids(agent).join(', ') || '(none)'}; omit kernelId to use the default or call wolfram_kernel_open.`)
      }
      await kernel.ready
      this.touch(agent)
      return { kernel, opened: false }
    }
    const session = this.session(agent)
    const current = this.defaultOf(session)
    if (current !== undefined) {
      await current.ready
      this.touch(agent)
      return { kernel: current, opened: false }
    }
    return { kernel: await this.open(agent), opened: true }
  }

  /** Close one kernel (default when kernelId is omitted). Returns the closed ids. */
  async close(agent, kernelId, reason = 'tool') {
    const session = this.session(agent, false)
    if (session === undefined) return []
    let kernel
    if (kernelId !== undefined && kernelId !== null && kernelId !== '') {
      const { kernelIndex } = this.parse(agent, kernelId)
      kernel = session.kernels.get(kernelIndex)
    } else {
      kernel = this.defaultOf(session)
    }
    if (kernel === undefined) return []
    await this.closeKernel(session, kernel, reason)
    return [kernel.id]
  }

  async closeKernel(session, kernel, reason) {
    session.kernels.delete(kernel.index)
    session.order = session.order.filter(i => i !== kernel.index)
    if (kernel.conn === undefined) { try { await kernel.ready } catch { /* never started; nothing to close */ } }
    try { await kernel.conn?.close() } catch (error) { this.options.logger.warn(`wolfram-kernel-supervisor: closing ${kernel.id} failed: ${String(error)}`) }
    this.options.trace({ event: 'kernel-close', id: session.agent.id, kernelId: kernel.id, reason })
  }

  /** Close every kernel of an agent's session and drop the session. */
  async forget(agent, reason) {
    const session = this.sessions.get(agent)
    if (session === undefined) return []
    this.sessions.delete(agent)
    if (session.timer !== undefined) clearTimeout(session.timer)
    const closed = []
    for (const kernel of [...session.kernels.values()]) {
      await this.closeKernel(session, kernel, reason)
      closed.push(kernel.id)
    }
    return closed
  }

  async dispose() {
    for (const agent of [...this.sessions.keys()]) await this.forget(agent, 'plugin-unload')
  }

  /** Reset the session's idle timer. */
  touch(agent) {
    const session = this.session(agent, false)
    if (session === undefined || this.options.idleMs <= 0) return
    if (session.timer !== undefined) clearTimeout(session.timer)
    session.timer = setTimeout(() => {
      session.timer = undefined
      if (session.kernels.size === 0) return
      void this.forget(agent, 'idle').then((closed) => {
        if (closed.length > 0) this.options.onIdleClose(agent, closed)
      })
    }, this.options.idleMs)
    session.timer.unref?.()
  }

  /** Public description of one kernel. */
  describe(session, kernel) {
    const d = this.defaultOf(session)
    return {
      kernelId: kernel.id,
      label: kernel.label,
      default: d === kernel,
      pid: kernel.pid ?? 0,
      sandboxPid: kernel.sandboxPid ?? 0,
      alive: kernel.conn === undefined ? false : !kernel.conn.closed && isAlive(kernel.pid),
      starting: kernel.conn === undefined,
      startedAt: new Date(kernel.startedAt).toISOString(),
      lastUsedAt: new Date(kernel.lastUsedAt).toISOString(),
      idleSeconds: Math.round((Date.now() - kernel.lastUsedAt) / 1000),
      evalCount: kernel.evalCount,
      cwd: kernel.cwd,
      theme: kernel.theme,
    }
  }

  /** The caller's kernels. */
  listOwn(agent) {
    const session = this.session(agent, false)
    if (session === undefined) return { session: null, kernels: [] }
    return { session: session.index, kernels: session.order.map(i => session.kernels.get(i)).filter(Boolean).map(k => this.describe(session, k)) }
  }

  /** Every session's kernels (read-only), plus host processes we do not own. */
  listAll(agent, labelOf) {
    const own = this.session(agent, false)
    const others = []
    const owned = new Set()
    for (const session of this.sessions.values()) {
      for (const kernel of session.kernels.values()) {
        owned.add(kernel.pid); owned.add(kernel.sandboxPid)
        if (session === own) continue
        others.push({ chat: labelOf(session.agent), session: session.index, ...this.describe(session, kernel) })
      }
    }
    const strays = scanKernelProcesses().filter(p => !owned.has(p.pid))
    return { others, strays }
  }
}

/**
 * @typedef {object} Kernel
 * @property {string} id
 * @property {number} index
 * @property {string} label
 * @property {import('./servers.mjs').KernelConnection} conn
 * @property {number | undefined} pid
 * @property {number | undefined} sandboxPid
 * @property {string | undefined} evalSession
 * @property {number} startedAt
 * @property {number} lastUsedAt
 * @property {number} evalCount
 * @property {string} cwd
 * @property {number} startupMs
 * @property {Promise<Kernel> | undefined} ready
 * @property {'light' | 'dark'} theme - appearance the kernel's front end was pinned to at bootstrap
 * @property {Map<string, { descriptor: object, scale: number }>} manipulates - interactive graphics registered by wolfram_show (kernel lifetime)
 */
/**
 * @typedef {object} Session
 * @property {number} index
 * @property {object} agent
 * @property {Map<number, Kernel>} kernels
 * @property {number[]} order
 * @property {number} nextKernel
 * @property {ReturnType<typeof setTimeout> | undefined} timer
 */

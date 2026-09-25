/**
 * Per-session browser windows.
 *
 * Every DSH agent (chat or subagent) that opens a browser gets a session index
 * (consecutive over this plugin instance's lifetime). Within a session,
 * windows are numbered from 0 per browser and addressed as
 *
 *   s:<session>:<window>   Safari — one `safaridriver --mcp` process per
 *                          window (its own automation session and STP window;
 *                          this is the only isolation Safari offers).
 *   c:<session>:<window>   Chrome — one `chrome-devtools-mcp --isolated`
 *                          instance per session, one page per window, routed
 *                          by pageId (windows share the session's cookies like
 *                          tabs of one browser).
 *
 * Tools take an optional `windowId`. When omitted: zero windows opens one, one
 * is used, several use the MOST RECENTLY USED one (the result says so and names
 * the others). Ids are validated against the caller's session, so no agent can
 * reach another agent's window.
 *
 * Chrome pages remember their last navigated URL. When the Chrome instance dies
 * (crash, idle close of the process, `chrome-devtools-mcp` restart) a tool that
 * names a lost window gets it REOPENED at that URL under the same id instead of
 * an error (`resolved.reopened`), and a stale-pageId failure mid-call is retried
 * once the same way (`recoverChrome`).
 *
 * An idle timer per session (reset by every tool call) closes everything after
 * `idleMs`; agent disposal and plugin unload close everything immediately.
 */

import { connectServer, textOf } from './servers.mjs'

const LETTER = { safari: 's', chrome: 'c' }
const BROWSER = { s: 'safari', c: 'chrome' }

export class BrowserSessions {
  /**
   * @param {object} options
   * @param {(session: Session, windowIndex: number) => { command: string, args: string[], clientName: string }} options.safariSpec
   * @param {(session: Session) => { command: string, args: string[], clientName: string, cwd?: string, env?: Record<string, string>, roots?: string[], onStderr?: (line: string) => void, stderrNoise?: RegExp[], dispose?: () => unknown }} options.chromeSpec - connectServer options plus `dispose`, run when the instance's process ends.
   * @param {number} options.timeoutMs - per MCP call.
   * @param {number} options.idleMs - 0 disables idle closing.
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
      session = { index: this.nextSession++, agent, safari: new Map(), chrome: { conn: undefined, pages: new Map(), lost: new Map(), lastUsed: undefined }, safariLastUsed: undefined, nextWindow: { safari: 0, chrome: 0 }, timer: undefined }
      this.sessions.set(agent, session)
      this.options.trace({ event: 'session', id: agent.id, session: session.index })
    }
    return session
  }

  /** Parse and validate a window id against the caller's session. */
  parse(agent, browser, windowId) {
    const match = /^([sc]):(\d+):(\d+)$/.exec(String(windowId).trim())
    if (match === null) throw new Error(`Invalid windowId "${windowId}": expected s:<session>:<window> or c:<session>:<window>.`)
    const [, letter, sessionIndex, windowIndex] = match
    if (BROWSER[letter] !== browser) throw new Error(`windowId "${windowId}" is a ${BROWSER[letter]} window; this tool drives ${browser}.`)
    const session = this.session(agent, false)
    if (session === undefined || session.index !== Number(sessionIndex)) {
      throw new Error(`windowId "${windowId}" does not belong to this session${session === undefined ? '' : ` (this session is ${session.index})`}. Open ids: ${this.listIds(agent, browser).join(', ') || '(none)'}.`)
    }
    return { session, windowIndex: Number(windowIndex) }
  }

  /** Open window ids of one browser in the caller's session. */
  listIds(agent, browser) {
    const session = this.session(agent, false)
    if (session === undefined) return []
    const indexes = browser === 'safari' ? [...session.safari.keys()] : [...session.chrome.pages.keys()]
    return indexes.map(index => `${LETTER[browser]}:${session.index}:${index}`)
  }

  id(session, browser, windowIndex) {
    return `${LETTER[browser]}:${session.index}:${windowIndex}`
  }

  // ---- Safari ----

  /** Spawn a new Safari window (driver process) in the caller's session. */
  async openSafari(agent) {
    const session = this.session(agent)
    const windowIndex = session.nextWindow.safari++
    const id = this.id(session, 'safari', windowIndex)
    const spec = this.options.safariSpec(session, windowIndex)
    const window = { id, conn: undefined }
    // safaridriver explains a refusal to start only on stderr ("could not launch because it is not configured
    // correctly or you need to authenticate", i.e. Remote Automation off — or no GUI session to check it in) and
    // then exits, which the MCP client reports as a bare "Connection closed". Keep its last lines for the error.
    const stderr = []
    try {
      window.conn = await connectServer({
        ...spec,
        safari: true,
        timeoutMs: this.options.timeoutMs,
        onStderr: (line) => {
          stderr.push(line); if (stderr.length > 6) stderr.shift()
          this.options.logger.warn(`browser-automation: ${id} safaridriver: ${line}`)
          this.options.trace({ event: 'safari-stderr', id: agent.id, windowId: id, line })
        },
        onClose: () => {
          if (session.safari.get(windowIndex) === window) {
            session.safari.delete(windowIndex)
            this.options.trace({ event: 'safari-window-lost', id: agent.id, windowId: id })
          }
        },
        onError: (error) => this.options.logger.warn(`browser-automation: ${id} transport error: ${String(error)}`),
      })
    } catch (error) {
      if (stderr.length === 0) throw error
      const said = stderr.join(' ').replace(/\s+/g, ' ').trim()
      throw new Error(`${error instanceof Error ? error.message : String(error)} — safaridriver said: ${said}`, { cause: error })
    }
    session.safari.set(windowIndex, window)
    this.touch(agent)
    this.options.trace({ event: 'safari-open', id: agent.id, windowId: id })
    return window
  }

  /**
   * The Safari window a tool should use.
   * @returns {Promise<{ id: string, conn: import('./servers.mjs').ServerConnection, opened: boolean }>}
   */
  async resolveSafari(agent, windowId) {
    if (windowId !== undefined && windowId !== '') {
      const { session, windowIndex } = this.parse(agent, 'safari', windowId)
      const window = session.safari.get(windowIndex)
      if (window === undefined) throw new Error(`Safari window "${windowId}" is not open. Open ids: ${this.listIds(agent, 'safari').join(', ') || '(none)'}; call safari_open for a new one.`)
      session.safariLastUsed = windowIndex
      this.touch(agent)
      return { ...window, opened: false }
    }
    const session = this.session(agent)
    if (session.safari.size === 0) {
      const window = await this.openSafari(agent)
      session.safariLastUsed = [...session.safari.keys()].at(-1)
      return { ...window, opened: true }
    }
    if (session.safari.size === 1) {
      this.touch(agent)
      session.safariLastUsed = session.safari.keys().next().value
      return { ...session.safari.values().next().value, opened: false }
    }
    // Several windows and no id: the most recently used one, and say so.
    const index = session.safari.has(session.safariLastUsed) ? session.safariLastUsed : [...session.safari.keys()].at(-1)
    session.safariLastUsed = index
    this.touch(agent)
    const window = session.safari.get(index)
    return { ...window, opened: false, defaulted: { count: session.safari.size, others: this.listIds(agent, 'safari').filter(x => x !== window.id) } }
  }

  /** Close one Safari window, or all of the session's when windowId is omitted. */
  async closeSafari(agent, windowId, reason = 'tool') {
    const session = this.session(agent, false)
    if (session === undefined) return []
    let targets
    if (windowId !== undefined && windowId !== '') {
      const { windowIndex } = this.parse(agent, 'safari', windowId)
      targets = session.safari.has(windowIndex) ? [windowIndex] : []
    } else {
      targets = [...session.safari.keys()]
    }
    const closed = []
    for (const windowIndex of targets) {
      const window = session.safari.get(windowIndex)
      session.safari.delete(windowIndex)
      try { await window.conn.close() } catch (error) { this.options.logger.warn(`browser-automation: closing ${window.id} failed: ${String(error)}`) }
      closed.push(window.id)
    }
    if (closed.length > 0) this.options.trace({ event: 'safari-close', id: agent.id, windows: closed, reason })
    this.afterClose(session)
    return closed
  }

  // ---- Chrome ----

  async chromeInstance(session) {
    if (session.chrome.conn !== undefined && !session.chrome.conn.closed) return session.chrome.conn
    const spec = this.options.chromeSpec(session)
    const { dispose, ...serverSpec } = spec
    const conn = await connectServer({
      ...serverSpec,
      timeoutMs: this.options.timeoutMs,
      onClose: () => {
        void dispose?.() // per-instance scratch (Node localStorage file); runs for our close() and for crashes alike
        if (session.chrome.conn === conn) {
          session.chrome.conn = undefined
          // Remember what was open so a tool naming one of these ids can reopen it in place.
          for (const [index, page] of session.chrome.pages) session.chrome.lost.set(index, { id: page.id, lastUrl: page.lastUrl })
          session.chrome.pages.clear()
          this.options.trace({ event: 'chrome-instance-lost', id: session.agent.id, session: session.index, lost: [...session.chrome.lost.keys()] })
        }
      },
      onError: (error) => this.options.logger.warn(`browser-automation: chrome (session ${session.index}) transport error: ${String(error)}`),
    })
    session.chrome.conn = conn
    this.options.trace({ event: 'chrome-instance', id: session.agent.id, session: session.index })
    return conn
  }

  /**
   * `new_page` that failed to load (ERR_CONNECTION_REFUSED, DNS, …) still creates a page — a selected
   * `chrome-error://chromewebdata/` tab nobody has an id for. Close such orphans and turn the server's
   * text into a clear error naming the URL, so the agent knows no window was opened.
   */
  async newChromePage(conn, url) {
    const result = await conn.callRaw('new_page', { url })
    const listing = textOf(result)
    const pageId = selectedPageId(listing)
    if (result.isError || pageId === undefined) {
      try {
        const pages = textOf(await conn.callRaw('list_pages', {}))
        for (const match of pages.matchAll(/^(\d+):\s.*\(chrome-error:\/\/[^)]*\)/gm)) {
          try { await conn.callText('close_page', { pageId: Number(match[1]) }) } catch { /* best effort */ }
        }
      } catch { /* best effort */ }
      throw new Error(`Chrome could not open ${url}: ${listing.replace(/^Error:\s*/, '').trim()}. No window was opened; start the server or fix the URL and call chrome_open again.`)
    }
    return { pageId, listing }
  }

  /** Open a new Chrome page (window) in the caller's session; `reuseIndex` reopens a lost window under its old id. */
  async openChrome(agent, url, reuseIndex) {
    const session = this.session(agent)
    const conn = await this.chromeInstance(session)
    const target = url ?? 'about:blank'
    const { pageId, listing } = await this.newChromePage(conn, target)
    const windowIndex = reuseIndex ?? session.nextWindow.chrome++
    const id = this.id(session, 'chrome', windowIndex)
    session.chrome.pages.set(windowIndex, { id, pageId, lastUrl: target })
    session.chrome.lost.delete(windowIndex)
    session.chrome.lastUsed = windowIndex
    this.touch(agent)
    this.options.trace({ event: reuseIndex === undefined ? 'chrome-open' : 'chrome-reopen', id: agent.id, windowId: id, pageId, url: target })
    return { id, pageId, conn, listing }
  }

  /** Record the URL a window navigated to (so a lost window can be reopened there). */
  noteChromeUrl(agent, windowId, url) {
    if (typeof url !== 'string' || url === '') return
    const session = this.session(agent, false)
    if (session === undefined) return
    for (const page of session.chrome.pages.values()) if (page.id === windowId) page.lastUrl = url
  }

  /**
   * A Chrome call failed with a stale page (the server reconnected or the page vanished): drop the
   * bookkeeping for that window and reopen it at its last URL under the same id, once.
   * @returns the reopened page, or undefined when the window was unknown
   */
  async recoverChrome(agent, windowId) {
    const session = this.session(agent, false)
    if (session === undefined) return undefined
    const { windowIndex } = this.parse(agent, 'chrome', windowId)
    const page = session.chrome.pages.get(windowIndex) ?? session.chrome.lost.get(windowIndex)
    if (page === undefined) return undefined
    session.chrome.pages.delete(windowIndex)
    session.chrome.lost.set(windowIndex, { id: page.id, lastUrl: page.lastUrl })
    if (session.chrome.conn !== undefined && session.chrome.pages.size === 0) {
      const conn = session.chrome.conn
      session.chrome.conn = undefined
      try { await conn.close() } catch { /* the instance is already in trouble */ }
    }
    const reopened = await this.openChrome(agent, page.lastUrl, windowIndex)
    return { ...reopened, opened: false, reopened: { url: page.lastUrl ?? 'about:blank' } }
  }

  /**
   * Run `fn` on a temporary page of the session's Chrome instance — the Chrome
   * counterpart of an isolated Safari read: never one of the chat's registered
   * windows, closed afterwards. The instance stays warm and is closed by the
   * session idle timer (or with the session).
   * @template T
   * @param {object} agent
   * @param {string} url
   * @param {(page: { conn: import('./servers.mjs').ServerConnection, pageId: number }) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async withChromeReaderPage(agent, url, fn) {
    const session = this.session(agent)
    const conn = await this.chromeInstance(session)
    const { pageId } = await this.newChromePage(conn, url)
    this.touch(agent)
    this.options.trace({ event: 'chrome-reader-open', id: agent.id, pageId, url })
    try {
      return await fn({ conn, pageId })
    } finally {
      if (!conn.closed) {
        try { await conn.callText('close_page', { pageId }) } catch (error) { this.options.logger.warn(`browser-automation: closing chrome reader page failed: ${String(error)}`) }
      }
      this.touch(agent)
    }
  }

  /**
   * The Chrome page a tool should use.
   * @returns {Promise<{ id: string, pageId: number, conn: import('./servers.mjs').ServerConnection, opened: boolean }>}
   */
  async resolveChrome(agent, windowId) {
    if (windowId !== undefined && windowId !== '') {
      const { session, windowIndex } = this.parse(agent, 'chrome', windowId)
      const page = session.chrome.pages.get(windowIndex)
      if (page === undefined || session.chrome.conn === undefined || session.chrome.conn.closed) {
        // The instance died since the model last saw this id: reopen the window where it was.
        const lost = session.chrome.lost.get(windowIndex) ?? (page !== undefined ? { id: page.id, lastUrl: page.lastUrl } : undefined)
        if (lost !== undefined) {
          const reopened = await this.openChrome(agent, lost.lastUrl, windowIndex)
          return { ...reopened, opened: false, reopened: { url: lost.lastUrl ?? 'about:blank' } }
        }
        throw new Error(`Chrome window "${windowId}" is not open. Open ids: ${this.listIds(agent, 'chrome').join(', ') || '(none)'}; call chrome_open for a new one.`)
      }
      session.chrome.lastUsed = windowIndex
      this.touch(agent)
      return { ...page, conn: session.chrome.conn, opened: false }
    }
    const session = this.session(agent)
    if (session.chrome.pages.size === 0) {
      // Nothing open. If the instance died with windows open, bring back the most recently used one.
      const lostIndex = session.chrome.lost.has(session.chrome.lastUsed) ? session.chrome.lastUsed : [...session.chrome.lost.keys()].at(-1)
      if (lostIndex !== undefined) {
        const lost = session.chrome.lost.get(lostIndex)
        const reopened = await this.openChrome(agent, lost.lastUrl, lostIndex)
        return { ...reopened, opened: false, reopened: { url: lost.lastUrl ?? 'about:blank' } }
      }
      return { ...(await this.openChrome(agent)), opened: true }
    }
    if (session.chrome.pages.size === 1) {
      this.touch(agent)
      session.chrome.lastUsed = session.chrome.pages.keys().next().value
      return { ...session.chrome.pages.values().next().value, conn: session.chrome.conn, opened: false }
    }
    // Several windows and no id: the most recently used one, and say so.
    const index = session.chrome.pages.has(session.chrome.lastUsed) ? session.chrome.lastUsed : [...session.chrome.pages.keys()].at(-1)
    session.chrome.lastUsed = index
    this.touch(agent)
    const page = session.chrome.pages.get(index)
    return { ...page, conn: session.chrome.conn, opened: false, defaulted: { count: session.chrome.pages.size, others: this.listIds(agent, 'chrome').filter(x => x !== page.id) } }
  }

  /** Close one Chrome window, or all of the session's; the instance quits with its last page. */
  async closeChrome(agent, windowId, reason = 'tool') {
    const session = this.session(agent, false)
    if (session === undefined) return []
    let targets
    if (windowId !== undefined && windowId !== '') {
      const { windowIndex } = this.parse(agent, 'chrome', windowId)
      targets = session.chrome.pages.has(windowIndex) ? [windowIndex] : []
      session.chrome.lost.delete(windowIndex) // closing a lost window forgets it
    } else {
      targets = [...session.chrome.pages.keys()]
    }
    const closed = []
    const conn = session.chrome.conn
    if (windowId === undefined || windowId === '') session.chrome.lost.clear() // an explicit close-all forgets lost windows too
    for (const windowIndex of targets) {
      const page = session.chrome.pages.get(windowIndex)
      session.chrome.pages.delete(windowIndex)
      session.chrome.lost.delete(windowIndex)
      if (conn !== undefined && !conn.closed && session.chrome.pages.size > 0) {
        try { await conn.callText('close_page', { pageId: page.pageId }) } catch (error) { this.options.logger.warn(`browser-automation: closing ${page.id} failed: ${String(error)}`) }
      }
      closed.push(page.id)
    }
    if (session.chrome.pages.size === 0 && conn !== undefined) {
      session.chrome.conn = undefined
      try { await conn.close() } catch (error) { this.options.logger.warn(`browser-automation: closing chrome (session ${session.index}) failed: ${String(error)}`) }
    }
    if (closed.length > 0) this.options.trace({ event: 'chrome-close', id: agent.id, windows: closed, reason })
    this.afterClose(session)
    return closed
  }

  // ---- lifecycle ----

  /** Close every window of the agent's session. */
  async closeAll(agent, reason) {
    const closed = [...await this.closeSafari(agent, undefined, reason), ...await this.closeChrome(agent, undefined, reason)]
    return closed
  }

  /** Reset the session's idle timer (any tool call counts as activity). */
  touch(agent) {
    const session = this.session(agent, false)
    if (session === undefined || this.options.idleMs === 0) return
    clearTimeout(session.timer)
    if (!this.anythingOpen(session)) return
    session.timer = setTimeout(() => {
      void this.closeAll(agent, 'idle').then((closed) => {
        if (closed.length > 0) this.options.onIdleClose(agent, closed)
      })
    }, this.options.idleMs)
    session.timer.unref?.()
  }

  /** Windows, or a warm Chrome instance kept for reader pages, that the idle timer should eventually close. */
  anythingOpen(session) {
    return session.safari.size > 0 || session.chrome.pages.size > 0 || (session.chrome.conn !== undefined && !session.chrome.conn.closed)
  }

  afterClose(session) {
    if (!this.anythingOpen(session)) {
      clearTimeout(session.timer)
      session.timer = undefined
    }
  }

  /** Forget an agent (its scope already unwound); its processes are closed. */
  async forget(agent, reason) {
    const session = this.sessions.get(agent)
    if (session === undefined) return
    clearTimeout(session.timer)
    await this.closeAll(agent, reason)
    this.sessions.delete(agent)
  }

  /** Windows currently open, for diagnostics. */
  stats() {
    let safari = 0; let chrome = 0
    for (const session of this.sessions.values()) { safari += session.safari.size; chrome += session.chrome.pages.size }
    return { sessions: this.sessions.size, safari, chrome }
  }

  async dispose() {
    for (const agent of [...this.sessions.keys()]) await this.forget(agent, 'unload')
  }
}

/** Page id of the `[selected]` line in chrome-devtools-mcp's "## Pages" listing. */
export function selectedPageId(listing) {
  const match = /^(\d+):\s.*\[selected\]\s*$/m.exec(listing)
  return match === null ? undefined : Number(match[1])
}

/**
 * @typedef {object} Session
 * @property {number} index
 * @property {object} agent
 * @property {Map<number, { id: string, conn: import('./servers.mjs').ServerConnection }>} safari
 * @property {{ conn: import('./servers.mjs').ServerConnection | undefined, pages: Map<number, { id: string, pageId: number, lastUrl?: string }>, lost: Map<number, { id: string, lastUrl?: string }>, lastUsed: number | undefined }} chrome
 * @property {number | undefined} safariLastUsed
 * @property {{ safari: number, chrome: number }} nextWindow
 * @property {ReturnType<typeof setTimeout> | undefined} timer
 */

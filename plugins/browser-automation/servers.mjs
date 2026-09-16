/**
 * Private MCP connections to the browser servers. The plugin owns the
 * forwarding itself (no dsh-mcp-client): each connection is one child process
 * driven through the MCP SDK, and only the plugin's curated tools ever reach
 * the model.
 *
 * - Safari: `safaridriver --mcp` (Safari Technology Preview). One process =
 *   one automation session = one STP window whose banner reads "This window is
 *   controlled by <clientName>." — the handshake's clientInfo.name is the label.
 * - Chrome: `chrome-devtools-mcp --isolated` (own temporary profile). Chrome
 *   itself launches on the first page; pages are routed by pageId.
 */

import { execFile, execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

/**
 * stderr lines chrome-devtools-mcp 1.8.0 prints on every launch that carry no information for the
 * operator (index.js `logDisclaimers`, utils/check-for-updates.js, Node's localStorage warning, the
 * roots notice). The disclaimer has no opt-out flag, so the plugin pipes the child's stderr and drops
 * these; everything else is forwarded (see connectServer `onStderr`).
 */
export const CHROME_STDERR_NOISE = [
  /^chrome-devtools-mcp exposes content of the browser instance/,
  /^debug, and modify any data in the browser or DevTools\.?$/,
  /^Avoid sharing sensitive or personal information/,
  /^Performance tools may send trace URLs to the Google CrUX API/,
  /^Google collects usage statistics to improve Chrome DevTools MCP/,
  /^For more details, visit: https:\/\/github\.com\/ChromeDevTools\/chrome-devtools-mcp/,
  /^Update available: \d/,
  /^Run `npm install chrome-devtools-mcp@latest` to update\./,
  /ExperimentalWarning: localStorage is not available/,
  /^\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)/,
  /^\[chrome-devtools-mcp\] The connecting client did not negotiate the MCP roots capability/,
]

/** True when a stderr line is known launch boilerplate (or blank). */
export function isNoiseLine(line, patterns) {
  const trimmed = line.trim()
  if (trimmed === '') return true
  return patterns.some(pattern => pattern.test(trimmed))
}

/**
 * Split a byte stream into lines and hand each to `onLine` (the trailing partial line on close too).
 * @param {import('node:stream').Readable} stream
 * @param {(line: string) => void} onLine
 */
export function readLines(stream, onLine) {
  let rest = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    rest += chunk
    let index
    while ((index = rest.indexOf('\n')) >= 0) {
      onLine(rest.slice(0, index).replace(/\r$/, ''))
      rest = rest.slice(index + 1)
    }
  })
  stream.on('end', () => { if (rest !== '') onLine(rest) })
}

const STP_PROCESS = 'Contents/MacOS/Safari Technology Preview'

/** PIDs of running Safari Technology Preview app instances (not helpers). */
export function stpPids() {
  try {
    return execFileSync('pgrep', ['-f', STP_PROCESS], { encoding: 'utf8' }).split('\n').map(Number).filter(Boolean)
  } catch {
    return [] // pgrep exits 1 when nothing matches
  }
}

/**
 * Host-wide ownership of the STP app instance our sessions launch.
 *
 * Apple's driver launches STP on a session's first navigation and terminates
 * it only when THAT launching session ends; if other sessions were alive at
 * that moment, the instance is never terminated and lingers with no windows
 * (observed). We count our live Safari connections; when the first one is made
 * while no STP instance is running, any instance that appears is ours, and once
 * our count returns to zero we quit it after a short grace period (a new
 * connection within it simply reuses the warm instance).
 */
class SafariInstanceOwner {
  constructor() { this.live = 0; this.owned = false; this.timer = undefined }

  acquire() {
    clearTimeout(this.timer)
    if (this.live === 0) this.owned = stpPids().length === 0
    this.live++
  }

  release() {
    this.live = Math.max(0, this.live - 1)
    if (this.live > 0 || !this.owned) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.quit() }, 3000)
    this.timer.unref?.()
  }

  async quit() {
    if (this.live > 0 || !this.owned) return
    const pids = stpPids()
    if (pids.length === 0) { this.owned = false; return }
    await new Promise(resolve => execFile('osascript', ['-e', 'quit app "Safari Technology Preview"'], () => resolve()))
    await new Promise(resolve => setTimeout(resolve, 2000))
    for (const pid of stpPids()) {
      if (pids.includes(pid)) { try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ } }
    }
    this.owned = false
  }

  async dispose() {
    clearTimeout(this.timer)
    this.live = 0
    await this.quit()
  }
}

export const safariInstance = new SafariInstanceOwner()

/**
 * Spawn one MCP server and complete the handshake.
 *
 * stderr: with `onStderr` the child's stderr is piped, lines matching `stderrNoise` are dropped and the
 * rest go to the callback (the operator's terminal stays quiet; genuine complaints still surface). Without
 * it the child inherits our stderr as before.
 *
 * roots: when given, the client declares the MCP `roots` capability and answers `roots/list` with these
 * directories. chrome-devtools-mcp otherwise warns on every launch and confines its file-writing tools to
 * the temp dir (index.js `oninitialized`); negotiating roots is the quiet alternative to
 * `--allow-unrestricted-paths` and keeps writes scoped to the session's cwd (+ the server's own temp dir).
 *
 * @param {{ command: string, args: string[], clientName: string, cwd?: string, env?: Record<string, string>, roots?: string[], timeoutMs: number, safari?: boolean, onClose?: () => void, onError?: (error: unknown) => void, onStderr?: (line: string) => void, stderrNoise?: RegExp[] }} options
 * @returns {Promise<ServerConnection>}
 */
export async function connectServer(options) {
  if (options.safari) safariInstance.acquire()
  let released = false
  const release = () => { if (!released && options.safari) { released = true; safariInstance.release() } }
  const pipeStderr = typeof options.onStderr === 'function'
  const transport = new StdioClientTransport({
    command: options.command,
    args: options.args,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}), // merged over the SDK's safe default set (HOME, PATH, …)
    stderr: pipeStderr ? 'pipe' : 'inherit',
  })
  if (pipeStderr) {
    const noise = options.stderrNoise ?? []
    readLines(transport.stderr, (line) => { if (!isNoiseLine(line, noise)) options.onStderr(line) })
  }
  const roots = (options.roots ?? []).filter(root => typeof root === 'string' && root !== '')
  const client = new Client({ name: options.clientName, version: '0.1.0' }, roots.length > 0 ? { capabilities: { roots: { listChanged: false } } } : undefined)
  if (roots.length > 0) {
    client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: roots.map(root => ({ uri: pathToFileURL(root).href, name: basename(root) || root })) }))
  }
  let closed = false
  transport.onclose = () => { closed = true; release(); options.onClose?.() }
  transport.onerror = (error) => { options.onError?.(error) }
  try {
    await client.connect(transport)
  } catch (error) {
    release()
    throw error
  }
  const timeout = options.timeoutMs

  /** Call a tool and return the raw MCP result (content blocks, isError). */
  async function callRaw(name, args) {
    return client.callTool({ name, arguments: args ?? {} }, undefined, { timeout })
  }

  /** Call a tool and return its text; throws on isError. */
  async function callText(name, args) {
    const result = await callRaw(name, args)
    const text = textOf(result)
    if (result.isError) throw new Error(`${name}: ${text || 'tool error'}`)
    return text
  }

  return {
    get closed() { return closed },
    callRaw,
    callText,
    /** Close stdin so the server exits cleanly (safaridriver: ~20 ms, closes its window). */
    async close() {
      if (closed) return
      closed = true
      try { await client.close() } finally { release() }
    },
  }
}

/** Join the text blocks of an MCP result. */
export function textOf(result) {
  return (result.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
}

/** First image block of an MCP result as bytes, or undefined. */
export function imageOf(result) {
  const block = (result.content ?? []).find(candidate => candidate.type === 'image' && typeof candidate.data === 'string')
  if (block === undefined) return undefined
  return { data: new Uint8Array(Buffer.from(block.data, 'base64')), mediaType: block.mimeType ?? 'image/png' }
}

/**
 * One-line inventory of an MCP result's content blocks, for error messages:
 * `text ×2, image ×1 (image/png, 12345 base64 chars)`; `(no content blocks)` when empty.
 */
export function describeBlocks(result) {
  const blocks = result?.content ?? []
  if (blocks.length === 0) return '(no content blocks)'
  const counts = new Map()
  for (const block of blocks) {
    const type = typeof block?.type === 'string' ? block.type : 'unknown'
    const detail = type === 'image' ? ` (${block.mimeType ?? 'no mimeType'}, ${typeof block.data === 'string' ? `${block.data.length} base64 chars` : 'no data'})` : ''
    const key = `${type}${detail}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts].map(([key, count]) => count > 1 ? key.replace(/^(\w+)/, `$1 ×${count}`) : key).join(', ')
}

/**
 * Path from chrome-devtools-mcp's "Saved screenshot to <path>." line (its
 * take_screenshot writes captures ≥ 2 MB — or any capture when `filePath` is
 * passed — to disk instead of attaching an image block; screenshot.js:256 in
 * 1.8.0). Undefined when the text has no such line.
 */
export function savedFileOf(text) {
  const match = /Saved (?:screenshot|file|output) to (.+?)\.?\s*$/m.exec(text ?? '')
  return match?.[1]
}

/**
 * Decode a get_page_content result into `{ url?, title?, content }`.
 *
 * Apple's server answers either with an inline JSON envelope `{title,url,content,format}` or, past roughly
 * 40 kB, with the pointer "Saved large output to '<path>' (…)" whose file holds the same envelope. `content`
 * is text for every format (json/html included). Never emit `undefined` fields: DSH requires lossless JSON.
 * @param {string} raw
 * @returns {Promise<{ url?: string, title?: string, content: string }>}
 */
export async function unwrapPageContent(raw) {
  let text = raw
  const saved = /(?:saved|written)[^'\n]*'([^']+)'/i.exec(raw) ?? /\/[^\s'"]+\.(?:md|txt|json|html)\b/.exec(raw)
  if (!raw.trimStart().startsWith('{') && saved) {
    text = await readFile(saved[1] ?? saved[0], 'utf8')
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && 'content' in parsed) {
      return {
        ...(typeof parsed.url === 'string' ? { url: parsed.url } : {}),
        ...(typeof parsed.title === 'string' ? { title: parsed.title } : {}),
        content: typeof parsed.content === 'string' ? parsed.content : JSON.stringify(parsed.content),
      }
    }
  } catch {
    // Not JSON: the extraction is the whole text.
  }
  return { content: text }
}

/** Decode Apple's JSON text results (sometimes double-encoded). */
export function parseJsonText(text) {
  let value = text
  for (let i = 0; i < 2 && typeof value === 'string'; i++) {
    try { value = JSON.parse(value) } catch { break }
  }
  return value
}

/**
 * @typedef {object} ServerConnection
 * @property {boolean} closed
 * @property {(name: string, args?: object) => Promise<object>} callRaw
 * @property {(name: string, args?: object) => Promise<string>} callText
 * @property {() => Promise<void>} close
 */

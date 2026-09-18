/**
 * One Wolfram kernel = one `wolfram … StartMCPServer[]` process speaking MCP
 * over stdio (Mathematica 15's Wolfram/AgentTools paclet). This module owns
 * the process: a custom MCP transport around `child_process.spawn` so the
 * supervisor controls stdin and the pid directly.
 *
 * WHY NOT the SDK's StdioClientTransport: the kernel IGNORES SIGTERM and
 * SIGINT (measured: still alive 10 s later) and exits only on stdin EOF, a
 * bare `Quit` line, or SIGKILL. Older SDK / Claude Code / Pi close paths that
 * SIGTERM the child left 23 orphaned kernels (~160 MB each) on this machine.
 * The ladder here is: `Quit` + EOF → wait 2 s → SIGKILL → SIGKILL any child
 * kernel (the sandboxed evaluator kernel the server launches).
 *
 * FAST LAUNCH: `-nopaclet` skips the paclet manager (~2.1 s of kernel boot);
 * the AgentTools paclet is loaded from its own directory. `initialize` takes
 * ~1.8 s; the first WolframLanguageEvaluator call another ~6 s (Chatbook
 * autoload) — the supervisor pays that in its bootstrap eval.
 */

import { kernelStartRemedy } from './environment.mjs'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'

export const KERNEL_CANDIDATES = [
  '/Applications/Wolfram.app/Contents/MacOS/wolfram',
  '/Applications/Mathematica.app/Contents/MacOS/wolfram',
  '/Applications/Wolfram Engine.app/Contents/MacOS/wolfram',
  '/usr/local/bin/wolfram',
]

/** The kernel binary: the configured path when non-empty, else the first existing candidate. */
export function findKernel(configured) {
  if (configured) return existsSync(configured) ? configured : undefined
  return KERNEL_CANDIDATES.find(p => existsSync(p))
}

/** Highest-versioned Wolfram/AgentTools paclet directory in the user repository (or the configured one). */
export function findAgentToolsDirectory(configured) {
  if (configured) return existsSync(configured) ? configured : undefined
  const base = process.env.WOLFRAM_USERBASE ?? join(homedir(), 'Library', 'Wolfram')
  const repo = join(base, 'Paclets', 'Repository')
  let entries
  try { entries = readdirSync(repo) } catch { return undefined }
  const dirs = entries.filter(e => e.startsWith('Wolfram__AgentTools-')).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  return dirs.length > 0 ? join(repo, dirs[0]) : undefined
}

/** Launch spec for one kernel: fast path when the paclet dir resolves, legacy PacletSymbol path otherwise. */
export function kernelLaunch({ kernel, pacletDirectory, server }) {
  const run = pacletDirectory
    ? `PacletDirectoryLoad[${JSON.stringify(pacletDirectory)}]; Needs["Wolfram\`AgentTools\`"]; Wolfram\`AgentTools\`StartMCPServer[]`
    : 'PacletSymbol["Wolfram/AgentTools","Wolfram`AgentTools`StartMCPServer"][]'
  return {
    command: kernel,
    args: [...(pacletDirectory ? ['-nopaclet'] : []), '-noinit', '-noprompt', '-run', run],
    env: { ...process.env, MCP_SERVER_NAME: server },
  }
}

// ---------------------------------------------------------------- processes

export function isAlive(pid) {
  if (typeof pid !== 'number') return false
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Direct child pids of a process (macOS/Linux `pgrep -P`); [] on any failure. */
export function childPids(pid) {
  if (typeof pid !== 'number') return []
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0)
  } catch { return [] }
}

export function killHard(pids) {
  const killed = []
  for (const pid of pids) {
    if (!isAlive(pid)) continue
    try { process.kill(pid, 'SIGKILL'); killed.push(pid) } catch { /* already gone */ }
  }
  return killed
}

/**
 * Every process on this host running the AgentTools MCP server, with parent
 * info and a launcher guess. Used for `wolfram_kernel_list global:true`.
 * @returns {{ pid: number, ppid: number, parentAlive: boolean, launcher: string, command: string }[]}
 */
export function scanKernelProcesses() {
  let lines
  try {
    lines = execFileSync('pgrep', ['-lf', 'StartMCPServer'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')
  } catch { return [] }
  const out = []
  for (const line of lines) {
    const m = /^(\d+)\s+(.*)$/.exec(line.trim())
    if (m === null) continue
    const pid = Number(m[1])
    const command = m[2]
    let ppid = 0
    try { ppid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) } catch { /* ps unavailable */ }
    const launcher = /disclaimer --pgroup/.test(command) ? 'claude-desktop'
      : /-nopaclet/.test(command) ? 'fast-launch (dsh supervisor, pi bridge, or probe)'
      : /PacletSymbol/.test(command) ? 'legacy launch (Claude Code / InstallMCPServer config)'
      : 'unknown'
    out.push({ pid, ppid, parentAlive: ppid > 1 && isAlive(ppid), launcher, command: command.slice(0, 160) })
  }
  return out
}

// ---------------------------------------------------------------- transport

/** How long the server gets to honour Quit/EOF before SIGKILL. Measured exit: ~250 ms. */
const QUIT_GRACE_MS = 2000

class KernelTransport {
  /** @param {{ command: string, args: string[], env: Record<string, string | undefined>, cwd?: string, onStderr?: (chunk: string) => void }} spec */
  constructor(spec) {
    this.spec = spec
    this.proc = undefined
    this.buffer = new ReadBuffer()
    this.exited = false
    this.closing = false
    this.stderrTail = ''
    this.onclose = undefined
    this.onerror = undefined
    this.onmessage = undefined
  }

  get pid() { return this.proc?.pid }

  async start() {
    if (this.proc !== undefined) throw new Error('kernel transport already started')
    const proc = spawn(this.spec.command, this.spec.args, {
      env: this.spec.env,
      ...(this.spec.cwd !== undefined ? { cwd: this.spec.cwd } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.proc = proc
    await new Promise((resolve, reject) => {
      proc.once('spawn', resolve)
      proc.once('error', reject)
    })
    proc.on('error', (error) => { this.onerror?.(error) })
    proc.stdout.on('data', (chunk) => {
      this.buffer.append(chunk)
      for (;;) {
        let message
        try { message = this.buffer.readMessage() } catch (error) { this.onerror?.(error); continue }
        if (message === null) break
        this.onmessage?.(message)
      }
    })
    proc.stderr.on('data', (chunk) => {
      const text = String(chunk)
      this.stderrTail = (this.stderrTail + text).slice(-4000)
      this.spec.onStderr?.(text)
    })
    proc.stdin.on('error', () => { /* EPIPE after the kernel died; the exit handler reports it */ })
    proc.on('exit', () => {
      this.exited = true
      this.buffer.clear()
      this.onclose?.()
    })
  }

  async send(message) {
    const proc = this.proc
    if (proc === undefined || this.exited || this.closing) throw new Error('kernel is not running')
    await new Promise((resolve, reject) => {
      proc.stdin.write(serializeMessage(message), (error) => (error ? reject(error) : resolve()))
    })
  }

  /** The kill ladder. Idempotent. Resolves when the server process and its child kernels are gone. */
  async close() {
    const proc = this.proc
    if (proc === undefined || this.closing) return
    this.closing = true
    const pid = proc.pid
    const children = childPids(pid)
    if (!this.exited) {
      try { proc.stdin.write('Quit\n') } catch { /* stdin already closed */ }
      try { proc.stdin.end() } catch { /* ignore */ }
      await this.waitExit(QUIT_GRACE_MS)
    }
    if (!this.exited) {
      try { proc.kill('SIGKILL') } catch { /* ignore */ }
      await this.waitExit(1000)
    }
    killHard([...new Set([...children, ...childPids(pid)])])
  }

  waitExit(ms) {
    if (this.exited) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      this.proc.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
}

/**
 * Spawn one kernel MCP server and complete the handshake.
 * @param {{ command: string, args: string[], env: Record<string, string|undefined>, cwd?: string, clientName: string, timeoutMs: number, onClose?: () => void, onError?: (error: unknown) => void }} options
 * @returns {Promise<KernelConnection>}
 */
export async function connectKernel(options) {
  const transport = new KernelTransport({ command: options.command, args: options.args, env: options.env, cwd: options.cwd })
  const client = new Client({ name: options.clientName, version: '0.1.0' })
  let closed = false
  let connected = false
  transport.onclose = () => { closed = true; if (connected) options.onClose?.() }
  transport.onerror = (error) => { options.onError?.(error) }
  try {
    await client.connect(transport)
    connected = true
  } catch (error) {
    await transport.close()
    const tail = transport.stderrTail.trim()
    const detail = `${error instanceof Error ? error.message : String(error)}${tail ? `\nkernel stderr: ${tail.slice(-800)}` : ''}`
    throw new Error(`Wolfram kernel failed to start. ${kernelStartRemedy(detail)}\n(underlying error: ${detail.slice(0, 600)})`)
  }
  const timeout = options.timeoutMs

  return {
    get closed() { return closed },
    get pid() { return transport.pid },
    get stderrTail() { return transport.stderrTail },
    /** Raw MCP result (content blocks, isError). */
    async callRaw(name, args) {
      return client.callTool({ name, arguments: args ?? {} }, undefined, { timeout })
    },
    /** Text of a call; throws on isError. */
    async callText(name, args) {
      const result = await this.callRaw(name, args)
      const text = textOf(result)
      if (result.isError) throw new Error(`${name}: ${text || 'tool error'}`)
      return text
    },
    /** Quit → EOF → SIGKILL → SIGKILL children. Never SIGTERM. */
    async close() {
      if (closed) return
      closed = true
      await transport.close()
    },
  }
}

/** Join the text blocks of an MCP result. */
export function textOf(result) {
  return (result.content ?? []).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
}

/** Image blocks of an MCP result as bytes. */
export function imagesOf(result) {
  return (result.content ?? [])
    .filter(block => block.type === 'image' && typeof block.data === 'string')
    .map(block => ({ data: new Uint8Array(Buffer.from(block.data, 'base64')), mediaType: block.mimeType ?? 'image/png' }))
}

/**
 * @typedef {object} KernelConnection
 * @property {boolean} closed
 * @property {number | undefined} pid
 * @property {string} stderrTail
 * @property {(name: string, args?: object) => Promise<object>} callRaw
 * @property {(name: string, args?: object) => Promise<string>} callText
 * @property {() => Promise<void>} close
 */

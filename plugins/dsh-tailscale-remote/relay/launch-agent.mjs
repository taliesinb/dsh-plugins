/**
 * The relay as a per-user LaunchAgent (`~/Library/LaunchAgents/<label>.plist`),
 * started at login and kept alive, so the port `tailscale serve` targets is
 * always answered even when DSH is not running.
 *
 *   ProgramArguments: <support dir>/dsh-web-relay relay.mjs --listen … --backend … --dsh … --cwd … --start … --log …
 *
 * `dsh-web-relay` is a symlink to the installing Node binary: launchd/System
 * Settings name a background item after its executable, so this reads
 * "dsh-web-relay" in Login Items instead of "zsh" or "node". The relay needs no
 * login shell itself — it starts DSH through `/bin/zsh -lc` (see relay.mjs) so
 * the operator's exported API keys reach `dsh web` as in a terminal — but the
 * installing context's PATH is baked into the plist (a login shell does not
 * read `.zshrc`, where pnpm/node are often added). Relay diagnostics go to
 * `<logDir>/relay.log`, DSH's own output to `<logDir>/dsh-web.log`. macOS only.
 */
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { isListening } from './relay.mjs'

const execFileAsync = promisify(execFile)
export const LABEL = 'io.github.taliesinb.dsh-web-relay'
/** Label of one instance: the base label, or `<base>.<instance>` (a preview relay beside the live one). */
export function labelFor(instance = '') {
  return instance === '' ? LABEL : `${LABEL}.${instance}`
}
const RELAY_SCRIPT = fileURLToPath(new URL('./relay.mjs', import.meta.url))

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function defaultLogDir() {
  return join(dshHome(), 'logs')
}

export function plistPath(instance = '') {
  return join(homedir(), 'Library', 'LaunchAgents', `${labelFor(instance)}.plist`)
}

/** Where the named Node symlink lives. */
export function supportDir() {
  return join(homedir(), 'Library', 'Application Support', 'dsh-tailscale-remote')
}

export function relayExecutable(instance = '') {
  return join(supportDir(), instance === '' ? 'dsh-web-relay' : `dsh-web-relay-${instance}`)
}

/** Log file basenames of one instance (`relay.log` / `relay-preview.log`, same for `dsh-web`). */
export function logFile(logDir, stem, instance = '') {
  return join(logDir, instance === '' ? `${stem}.log` : `${stem}-${instance}.log`)
}

function domain() {
  return `gui/${String(userInfo().uid)}`
}

/** POSIX single-quote shell quoting. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function xml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * @param {{ listen: string, backend: string, dsh: string, cwd: string, start: string, logDir: string, instance?: string, executable?: string, path?: string }} spec
 *   `listen`/`backend`/`dsh` are `host:port`; `start` is the shell command that runs DSH in `cwd`;
 *   `instance` ('' = the main one) keeps a preview relay's label, symlink and logs apart.
 * @returns {string[]} ProgramArguments
 */
export function relayArguments(spec) {
  return [
    spec.executable ?? relayExecutable(spec.instance ?? ''),
    RELAY_SCRIPT,
    '--listen', spec.listen,
    '--backend', spec.backend,
    '--dsh', spec.dsh,
    '--cwd', spec.cwd,
    '--start', spec.start,
    '--log', logFile(spec.logDir, 'dsh-web', spec.instance ?? ''),
  ]
}

/** The same invocation as one shell line (for display and for running it by hand). */
export function relayCommand(spec) {
  return relayArguments(spec).map(shellQuote).join(' ')
}

export function launchAgentPlist(spec) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${labelFor(spec.instance ?? '')}</string>
  <key>ProgramArguments</key>
  <array>
${relayArguments(spec).map(arg => `    <string>${xml(arg)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xml(logFile(spec.logDir, 'relay', spec.instance ?? ''))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logFile(spec.logDir, 'relay', spec.instance ?? ''))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DSH_HOME</key>
    <string>${xml(dshHome())}</string>
    <key>PATH</key>
    <string>${xml(spec.path ?? process.env.PATH ?? '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin')}</string>
  </dict>
</dict>
</plist>
`
}

async function launchctl(args) {
  try {
    const { stdout } = await execFileAsync('/bin/launchctl', args, { maxBuffer: 4 * 1024 * 1024 })
    return { code: 0, stdout }
  } catch (error) {
    return { code: typeof error?.code === 'number' ? error.code : 1, stdout: String(error?.stdout ?? ''), stderr: String(error?.stderr ?? error?.message ?? '') }
  }
}

/**
 * @param {{ listenPort: number, instance?: string }} options
 * @returns {Promise<{ supported: boolean, installed: boolean, loaded: boolean, pid?: number, listening: boolean, plist: string, label: string, logDir?: string, command?: string }>}
 */
export async function relayStatus(options) {
  const instance = options.instance ?? ''
  const label = labelFor(instance)
  const plist = plistPath(instance)
  if (process.platform !== 'darwin') return { supported: false, installed: false, loaded: false, listening: false, plist, label }
  let installed = false
  let command
  try {
    const text = await readFile(plist, 'utf8')
    installed = true
    const strings = [...text.matchAll(/<string>([^<]*)<\/string>/g)].map(match => match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))
    const startAt = strings.indexOf('--start')
    command = startAt === -1 ? undefined : strings[startAt + 1]
  } catch {
    installed = false
  }
  const print = await launchctl(['print', `${domain()}/${label}`])
  const loaded = print.code === 0
  const pid = loaded ? Number(/^\s*pid = (\d+)/m.exec(print.stdout)?.[1]) : undefined
  const listening = await isListening({ host: '127.0.0.1', port: options.listenPort }, 500)
  return { supported: true, installed, loaded, pid: Number.isFinite(pid) ? pid : undefined, listening, plist, label, logDir: defaultLogDir(), command }
}

/**
 * Write the plist and (re)load the agent; resolves once the port answers (or after 8 s).
 * @param {Parameters<typeof relayCommand>[0] & { log?: (line: string) => void }} spec
 */
export async function installRelayAgent(spec) {
  if (process.platform !== 'darwin') throw new Error('the relay LaunchAgent is macOS-only')
  const log = spec.log ?? (() => {})
  const instance = spec.instance ?? ''
  const label = labelFor(instance)
  const plist = plistPath(instance)
  await mkdir(spec.logDir, { recursive: true })
  await mkdir(dirname(plist), { recursive: true })
  // Named symlink to the Node that is installing (Login Items shows "dsh-web-relay").
  await mkdir(supportDir(), { recursive: true })
  await rm(relayExecutable(instance), { force: true })
  await symlink(process.execPath, relayExecutable(instance))
  const target = `${domain()}/${label}`
  const wasLoaded = (await launchctl(['print', target])).code === 0
  if (wasLoaded) {
    // bootout returns before the service is gone; bootstrapping into a label
    // that is still unloading fails with EIO (5).
    await launchctl(['bootout', target])
    const gone = Date.now() + 10_000
    while (Date.now() < gone && (await launchctl(['print', target])).code === 0) {
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }
  await writeFile(plist, launchAgentPlist(spec))
  let boot = await launchctl(['bootstrap', domain(), plist])
  for (let attempt = 0; boot.code !== 0 && attempt < 10; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 500))
    boot = await launchctl(['bootstrap', domain(), plist])
  }
  if (boot.code !== 0) throw new Error(`launchctl bootstrap failed (${String(boot.code)}): ${boot.stderr.trim()}`)
  log(`relay: LaunchAgent ${label} ${wasLoaded ? 'reloaded' : 'installed'} (${plist})`)
  const port = Number(spec.listen.split(':').pop())
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (await isListening({ host: '127.0.0.1', port }, 300)) return { listening: true }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return { listening: false }
}

export async function uninstallRelayAgent({ instance = '', log = () => {} } = {}) {
  if (process.platform !== 'darwin') throw new Error('the relay LaunchAgent is macOS-only')
  const label = labelFor(instance)
  await launchctl(['bootout', `${domain()}/${label}`])
  let removed = false
  try {
    await stat(plistPath(instance))
    await rm(plistPath(instance))
    removed = true
  } catch {
    removed = false
  }
  await rm(relayExecutable(instance), { force: true })
  log(`relay: LaunchAgent ${label} removed`)
  return { removed }
}

/** Restart the relay (and with it the DSH it spawned, which the relay stops on SIGTERM). */
export async function restartRelayAgent(instance = '') {
  const result = await launchctl(['kickstart', '-k', `${domain()}/${labelFor(instance)}`])
  if (result.code !== 0) throw new Error(`launchctl kickstart failed: ${result.stderr.trim()}`)
}

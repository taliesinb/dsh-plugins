/**
 * Where is the Wolfram kernel? — resolution, auto-detection and the
 * wolframscript hand-off for wolfram-kernel-supervisor.
 *
 * INPUT FORMS. A user (or the plugin config) may name the kernel as any of:
 *   /Applications/Wolfram.app                                  (macOS bundle)
 *   /Applications/Wolfram.app/Contents/MacOS/WolframKernel     (the kernel)
 *   /Applications/Wolfram.app/Contents/MacOS/wolfram           (the launcher script)
 *   /usr/local/Wolfram/Wolfram/14.3                            (Linux install root)
 *   /usr/local/Wolfram/Wolfram/14.3/Executables/WolframKernel
 *   C:\Program Files\Wolfram Research\Wolfram\14.3\WolframKernel.exe
 *   /usr/local/bin/wolfram                                     (symlink into any of the above)
 * `locateKernel` normalizes all of them to { kernelPath, launcher, root, version }:
 * `kernelPath` is the WolframKernel executable — the value wolframscript wants
 * in WOLFRAMSCRIPT_KERNELPATH — and `launcher` is the sibling `wolfram` wrapper
 * when it exists (it sets up the environment before exec'ing the kernel), else
 * the kernel itself. The supervisor spawns `launcher`.
 *
 * DETECTION ORDER (`detectKernel`): $WOLFRAMSCRIPT_KERNELPATH → the path in
 * wolframscript's own configuration → the platform's standard install
 * locations (macOS: /Applications and ~/Applications bundles named Wolfram* /
 * Mathematica*; Linux: /usr/local/Wolfram, /opt/Wolfram, … product/version
 * trees; Windows: %ProgramFiles%\Wolfram Research\<product>\<version>) →
 * `WolframKernel` / `wolfram` / `math` on $PATH (symlinks resolved).
 *
 * WOLFRAMSCRIPT. `wolframscript` finds a kernel through its own defaults or an
 * explicit `WOLFRAMSCRIPT_KERNELPATH=` line in WolframScript.conf. When that
 * line is absent it *usually* works — but not always (observed: exit 0,
 * no output, `-activate` says "An appropriate WolframKernel location could not
 * be determined"). `KernelLocator` therefore probes it once per (wolframscript,
 * conf, kernel) combination — `wolframscript -code ToString[$VersionNumber]`,
 * result cached on disk — and only when the probe fails (or the explicit path
 * points at a missing file) writes the resolved kernel into its configuration
 * with `wolframscript -configure WOLFRAMSCRIPT_KERNELPATH=…`. A wolframscript
 * that works is never touched.
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join, resolve as resolvePath } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const WINDOWS = process.platform === 'win32'
const EXE = WINDOWS ? '.exe' : ''
const KERNEL_NAMES = WINDOWS ? ['WolframKernel.exe', 'MathKernel.exe'] : ['WolframKernel', 'MathKernel']
const LAUNCHER_NAMES = WINDOWS ? ['wolfram.exe', 'math.exe'] : ['wolfram', 'math']

/** `~` → home; relative → absolute. */
export function expandPath(input) {
  const text = String(input ?? '').trim()
  if (text === '') return ''
  return resolvePath(text.replace(/^~(?=[/\\]|$)/, homedir()))
}

function isFile(path) {
  try { return statSync(path).isFile() } catch { return false }
}
function isDirectory(path) {
  try { return statSync(path).isDirectory() } catch { return false }
}
function realpath(path) {
  try { return realpathSync(path) } catch { return path }
}

/** Numeric-aware descending sort (14.3 before 14.1 before 13.3). */
function byVersionDesc(a, b) {
  return b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' })
}

/**
 * Normalize one path (see module header) to a kernel description.
 * @param {string} input - any of the accepted forms; '' → undefined.
 * @returns {LocatedKernel | undefined}
 */
export function locateKernel(input) {
  const path = expandPath(input)
  if (path === '') return undefined
  let kernelPath
  if (isDirectory(path)) {
    const inside = [
      ...KERNEL_NAMES.map(n => join(path, 'Contents', 'MacOS', n)),   // macOS bundle
      ...KERNEL_NAMES.map(n => join(path, 'Executables', n)),          // Linux install root
      ...KERNEL_NAMES.map(n => join(path, n)),                         // Windows install root / MacOS dir / Executables dir
    ]
    kernelPath = inside.find(isFile)
  } else if (isFile(path)) {
    const real = realpath(path)
    const name = basename(real)
    if (KERNEL_NAMES.includes(name)) kernelPath = real
    else {
      // A launcher (wolfram, math, wolframscript, …): the kernel is its sibling.
      const sibling = KERNEL_NAMES.map(n => join(dirname(real), n)).find(isFile)
      kernelPath = sibling ?? (LAUNCHER_NAMES.includes(name) ? real : undefined)
    }
  }
  if (kernelPath === undefined) return undefined
  const dir = dirname(kernelPath)
  const launcher = LAUNCHER_NAMES.map(n => join(dir, n)).find(isFile) ?? kernelPath
  return { kernelPath, launcher, root: installRoot(kernelPath), version: kernelVersion(kernelPath) }
}

/** The bundle / install directory a kernel belongs to, for display. */
function installRoot(kernelPath) {
  let dir = dirname(kernelPath)
  for (let i = 0; i < 4; i++) {
    if (/\.app$/i.test(dir)) return dir
    if (basename(dir) === 'Executables') return dirname(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    if (basename(dir) === 'MacOS' || basename(dir) === 'Contents') { dir = parent; continue }
    break
  }
  return dirname(kernelPath)
}

/** Product version: macOS Info.plist CFBundleShortVersionString, else a version-shaped path segment. */
function kernelVersion(kernelPath) {
  const root = installRoot(kernelPath)
  if (/\.app$/i.test(root)) {
    try {
      const plist = readFileSync(join(root, 'Contents', 'Info.plist'), 'utf8')
      const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)
      if (m !== null) return m[1].trim()
    } catch { /* binary plist or unreadable */ }
  }
  const seg = /(?:^|[\\/])(\d+\.\d+(?:\.\d+)?)(?:[\\/]|$)/.exec(root)
  return seg?.[1]
}

// ---------------------------------------------------------------- detection

/** Standard install locations for this platform, most preferred first. */
export function standardLocations() {
  const out = []
  if (process.platform === 'darwin') {
    const preferred = ['Wolfram.app', 'Mathematica.app', 'Wolfram Engine.app', 'WolframEngine.app']
    for (const dir of ['/Applications', join(homedir(), 'Applications')]) {
      let entries = []
      try { entries = readdirSync(dir) } catch { continue }
      const apps = entries.filter(e => /\.app$/i.test(e) && /^(Wolfram|Mathematica)/i.test(e) && !/^WolframScript\.app$/i.test(e))
      const first = preferred.filter(p => apps.includes(p))
      const rest = apps.filter(a => !preferred.includes(a)).sort(byVersionDesc)
      for (const app of [...first, ...rest]) out.push(join(dir, app))
    }
  } else if (WINDOWS) {
    const bases = [...new Set([process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean))]
    for (const base of bases) {
      const vendor = join(base, 'Wolfram Research')
      out.push(...productVersionDirs(vendor))
    }
  } else {
    for (const base of ['/usr/local/Wolfram', '/opt/Wolfram', '/opt/wolfram', '/usr/local/wolfram', join(homedir(), 'Wolfram')]) {
      out.push(...productVersionDirs(base))
    }
  }
  return out
}

/** `<base>/<Product>/<version>` directories (Wolfram, Mathematica, WolframEngine, …), newest first per product. */
function productVersionDirs(base) {
  let products = []
  try { products = readdirSync(base) } catch { return [] }
  const order = ['Wolfram', 'Mathematica', 'WolframEngine', 'Wolfram Engine']
  products.sort((a, b) => {
    const ia = order.indexOf(a); const ib = order.indexOf(b)
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b)
  })
  const out = []
  for (const product of products) {
    const dir = join(base, product)
    if (!isDirectory(dir)) continue
    let versions = []
    try { versions = readdirSync(dir).filter(v => isDirectory(join(dir, v))) } catch { continue }
    for (const v of versions.sort(byVersionDesc)) out.push(join(dir, v))
  }
  return out
}

/** First `name` on $PATH, symlinks resolved. */
export function onPath(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, name)
    if (isFile(candidate)) return candidate
  }
  return undefined
}

/**
 * Search the platform for a kernel.
 * @returns {{ found: LocatedKernel | undefined, searched: string[], via?: string }}
 *   `searched` is the human-readable list of places tried (for the "not found" message).
 */
export function detectKernel() {
  const searched = []
  const tryPath = (path, via) => {
    if (!path) return undefined
    searched.push(`${via}: ${path}`)
    const located = locateKernel(path)
    return located === undefined ? undefined : { found: located, searched, via }
  }
  let hit = tryPath(process.env.WOLFRAMSCRIPT_KERNELPATH, '$WOLFRAMSCRIPT_KERNELPATH')
  if (hit) return hit
  const ws = findWolframscript()
  const conf = ws === undefined ? undefined : readWolframscriptConfSync(ws.path)
  hit = tryPath(conf?.kernelPath, 'wolframscript configuration')
  if (hit) return hit
  const standard = standardLocations()
  for (const dir of standard) {
    hit = tryPath(dir, 'standard location')
    if (hit) return hit
  }
  if (standard.length === 0) {
    searched.push(process.platform === 'darwin'
      ? 'standard locations: no Wolfram*.app / Mathematica*.app in /Applications or ~/Applications'
      : WINDOWS ? 'standard locations: nothing under %ProgramFiles%\\Wolfram Research'
        : 'standard locations: nothing under /usr/local/Wolfram, /opt/Wolfram, /opt/wolfram, ~/Wolfram')
  }
  for (const name of [...KERNEL_NAMES, ...LAUNCHER_NAMES]) {
    hit = tryPath(onPath(name), `$PATH ${name}`)
    if (hit) return hit
  }
  if (!searched.some(s => s.startsWith('$PATH'))) searched.push(`$PATH: no ${[...KERNEL_NAMES, ...LAUNCHER_NAMES].join(' / ')}`)
  return { found: undefined, searched }
}

// ---------------------------------------------------------------- wolframscript

/** wolframscript on $PATH, or beside a kernel launcher. */
export function findWolframscript(located) {
  const name = `wolframscript${EXE}`
  const path = onPath(name) ?? (located ? [join(dirname(located.launcher), name), join(dirname(located.kernelPath), name)].find(isFile) : undefined)
  return path === undefined ? undefined : { path }
}

/** Per-platform WolframScript.conf location (fallback when `-configure` cannot be run). */
export function defaultWolframscriptConfPath() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Wolfram', 'WolframScript', 'WolframScript.conf')
  if (WINDOWS) return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Wolfram', 'WolframScript', 'WolframScript.conf')
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Wolfram', 'WolframScript', 'WolframScript.conf')
}

/**
 * Parse WolframScript.conf text: `KEY=VALUE` lines; `//KEY=…` lines are the
 * commented hints wolframscript writes itself and count as unset.
 */
export function parseWolframscriptConf(text) {
  const values = {}
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('//') || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return values
}

/** Sync read of wolframscript's explicit kernel path from the default conf location. */
function readWolframscriptConfSync() {
  const confPath = defaultWolframscriptConfPath()
  try {
    const values = parseWolframscriptConf(readFileSync(confPath, 'utf8'))
    return { confPath, kernelPath: values.WOLFRAMSCRIPT_KERNELPATH || undefined, text: undefined }
  } catch { return { confPath, kernelPath: undefined } }
}

/**
 * `wolframscript -configure` (no kernel launched): the conf file path and its
 * current contents. Falls back to reading the default conf location.
 */
export async function readWolframscriptConf(wsPath) {
  let stdout = ''
  try {
    ({ stdout } = await execFileAsync(wsPath, ['-configure'], { encoding: 'utf8', timeout: 15_000, windowsHide: true }))
  } catch (error) {
    stdout = String(error?.stdout ?? '')
  }
  const location = /Configuration file location:\s*(.+)/.exec(stdout)?.[1]?.trim()
  const block = stdout.split(/Configuration file:\s*\r?\n/)[1]
  const confPath = location ?? defaultWolframscriptConfPath()
  let text = block
  if (text === undefined) { try { text = readFileSync(confPath, 'utf8') } catch { text = '' } }
  const values = parseWolframscriptConf(text)
  return { confPath, kernelPath: values.WOLFRAMSCRIPT_KERNELPATH || undefined, values }
}

/** `wolframscript -version` first line. */
export async function wolframscriptVersion(wsPath) {
  try {
    const { stdout } = await execFileAsync(wsPath, ['-version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
    return stdout.trim().split(/\r?\n/)[0]
  } catch { return undefined }
}

/**
 * Can wolframscript actually run a kernel? Launches one (slow: seconds).
 * @returns {Promise<{ ok: boolean, output: string, ms: number }>}
 */
export async function probeWolframscript(wsPath, timeoutMs = 90_000) {
  const t0 = Date.now()
  try {
    // $Version → "15.0.1 for Mac OS X ARM (64-bit) (…)"; a wolframscript without a kernel prints nothing and exits 0.
    const { stdout, stderr } = await execFileAsync(wsPath, ['-code', '$Version'], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true })
    const out = stdout.trim()
    return { ok: /^\d+\.\d+/.test(out), output: (out || stderr.trim()).slice(0, 400), ms: Date.now() - t0 }
  } catch (error) {
    const text = [error?.stdout, error?.stderr, error?.killed ? `timed out after ${timeoutMs} ms` : error?.message].filter(Boolean).join('\n').trim()
    return { ok: false, output: text.slice(0, 400), ms: Date.now() - t0 }
  }
}

/** `wolframscript -configure WOLFRAMSCRIPT_KERNELPATH=<kernelPath>`; resolves to the re-read conf. */
export async function configureWolframscriptKernel(wsPath, kernelPath) {
  await execFileAsync(wsPath, ['-configure', `WOLFRAMSCRIPT_KERNELPATH=${kernelPath}`], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
  return readWolframscriptConf(wsPath)
}

// ---------------------------------------------------------------- the locator

/**
 * Holds the resolved kernel for the supervisor and keeps it in step with the
 * settings namespace, the plugin config and the machine.
 *
 * Resolution precedence: the settings value (user layer, when a settings
 * provider is mounted) → the plugin config `kernel` → auto-detection. A
 * successful detection is written back into the setting (`persist`) so the
 * user sees — and can correct — what was found; nothing is written when
 * detection fails, and every kernel spawn then fails with `unconfiguredMessage()`.
 */
export class KernelLocator {
  /**
   * @param {object} options
   * @param {() => string} options.configuredPath - the plugin config `kernel` (may be '').
   * @param {() => string | undefined} options.settingPath - the settings value, or undefined while no settings provider is mounted.
   * @param {((kernelPath: string) => Promise<void>) | undefined} options.persist - write an auto-detected kernel into the setting.
   * @param {boolean} options.manageWolframscript - probe wolframscript and repair its kernel path when broken.
   * @param {string} options.cacheDir - directory for the probe cache file.
   * @param {string} [options.installRemedy] - appended to the not-found message (what the user must install).
   * @param {{ info: Function, warn: Function }} options.logger
   * @param {(record: object) => void} options.trace
   */
  constructor(options) {
    this.options = options
    /** @type {LocatedKernel | undefined} */
    this.located = undefined
    this.source = undefined
    this.input = ''
    this.error = undefined
    /** @type {string[]} */
    this.searched = []
    this.autoFilled = undefined
    this.checkedAt = undefined
    this.wolframscript = { state: 'unknown' }
    this.pending = undefined
    this.wsPending = undefined
    this.listeners = new Set()
  }

  /** The kernel to spawn, or undefined. Sync; refreshed by `refresh()`. */
  current() { return this.located }

  onChange(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  emit() { for (const l of this.listeners) { try { l() } catch { /* listener error */ } } }

  /**
   * The message every kernel spawn fails with while nothing is configured. The
   * model cannot fix this; the text tells it what to relay to the user: where
   * the setting is, and (when nothing was found at all) the install remedy.
   */
  unconfiguredMessage() {
    const fix = 'To fix: in the DSH web GUI open Settings ▸ Plugins ▸ Plugin configuration ▸ "Wolfram kernel" and enter the kernel location (the WolframKernel executable, or the Wolfram.app / Mathematica.app bundle or install directory), or set `kernel:` in the wolfram-kernel-supervisor plugin config.'
    if (this.error !== undefined) return `Wolfram kernel not usable: ${this.error} ${fix}`
    const looked = this.searched.length > 0 ? ` Auto-detection looked at: ${this.searched.join('; ')}.` : ''
    const install = this.options.installRemedy ? ` If Wolfram is not installed at all: ${this.options.installRemedy}` : ''
    return `No Wolfram kernel is configured and none was found on this machine.${looked} ${fix}${install}`
  }

  /** Re-resolve from the current inputs. Serialized; safe to call often (fs checks only). */
  refresh(reason = 'refresh') {
    if (this.pending !== undefined) return this.pending
    this.pending = this.resolve(reason).finally(() => { this.pending = undefined })
    return this.pending
  }

  async resolve(reason) {
    const setting = this.options.settingPath()
    const configured = this.options.configuredPath()
    const before = this.located?.kernelPath
    let located
    let source
    let input = ''
    let error
    let searched = []
    let persisted = false
    if (setting !== undefined && setting.trim() !== '') {
      input = setting.trim(); source = 'setting'
      located = locateKernel(input)
      if (located === undefined) error = `"${input}" (from the Wolfram kernel setting) is not a Wolfram kernel: no WolframKernel executable there.`
    } else if (configured.trim() !== '') {
      input = configured.trim(); source = 'config'
      located = locateKernel(input)
      if (located === undefined) error = `"${input}" (plugin config \`kernel\`) is not a Wolfram kernel: no WolframKernel executable there.`
    } else {
      const detection = detectKernel()
      located = detection.found
      searched = detection.searched
      source = located === undefined ? undefined : 'detected'
      if (located !== undefined) {
        this.autoFilled = located.kernelPath
        if (this.options.persist !== undefined && setting !== undefined) {
          try { await this.options.persist(located.kernelPath); persisted = true } catch (e) { this.options.logger.warn(`wolfram-kernel-supervisor: could not save the detected kernel path into settings: ${String(e?.message ?? e)}`) }
        }
      }
    }
    if (source === 'setting' && this.autoFilled !== undefined && input === this.autoFilled) source = 'detected'
    this.located = located; this.source = source; this.input = input; this.error = error; this.searched = searched
    this.checkedAt = new Date().toISOString()
    this.options.trace({ event: 'kernel-resolve', reason, source, kernel: located?.kernelPath ?? null, error: error ?? null, persisted })
    if (located?.kernelPath !== before) {
      if (located !== undefined) this.options.logger.info(`wolfram-kernel-supervisor: kernel ${located.kernelPath}${located.version ? ` (${located.version})` : ''} — ${source === 'detected' ? 'auto-detected' : `from ${source}`}`)
      else this.options.logger.warn(`wolfram-kernel-supervisor: ${this.unconfiguredMessage()}`)
    }
    this.emit()
    // wolframscript is checked in the background: a probe launches a kernel.
    void this.checkWolframscript(false)
  }

  /** Detect ignoring the setting, and write what is found into it (the card's Auto-detect button). */
  async detectAndFill() {
    const detection = detectKernel()
    this.searched = detection.searched
    if (detection.found !== undefined) {
      this.autoFilled = detection.found.kernelPath
      if (this.options.persist !== undefined) await this.options.persist(detection.found.kernelPath)
    }
    await this.refresh('detect')
    return detection.found
  }

  // ---- wolframscript

  cacheFile() { return join(this.options.cacheDir, 'wolframscript-probe.json') }
  readCache() { try { return JSON.parse(readFileSync(this.cacheFile(), 'utf8')) } catch { return undefined } }
  writeCache(record) {
    try { mkdirSync(this.options.cacheDir, { recursive: true }); writeFileSync(this.cacheFile(), JSON.stringify(record, null, 2)) } catch { /* best effort */ }
  }

  /**
   * Assess wolframscript and, when it cannot find a kernel, point it at ours.
   * @param {boolean | 'probe' | 'configure'} force - false: cached policy;
   *   'probe': re-probe ignoring the cache; 'configure': write our kernel into
   *   its configuration unconditionally (user asked).
   */
  checkWolframscript(force = false) {
    if (this.wsPending !== undefined && force === false) return this.wsPending
    const run = async () => {
      if (this.wsPending !== undefined) await this.wsPending.catch(() => {})
      return this.assessWolframscript(force)
    }
    const p = run().finally(() => { if (this.wsPending === p) this.wsPending = undefined })
    this.wsPending = p
    return p
  }

  async assessWolframscript(force) {
    const located = this.located
    const ws = findWolframscript(located)
    if (ws === undefined) { this.setWolframscript({ state: 'absent' }); return }
    const version = await wolframscriptVersion(ws.path)
    let conf = await readWolframscriptConf(ws.path)
    const base = { path: ws.path, version, confPath: conf.confPath }
    const explicitExists = conf.kernelPath !== undefined && isFile(expandPath(conf.kernelPath))
    const matches = located !== undefined && conf.kernelPath !== undefined && realpath(expandPath(conf.kernelPath)) === realpath(located.kernelPath)
    const manage = this.options.manageWolframscript
    if (located === undefined) {
      this.setWolframscript({ ...base, state: conf.kernelPath === undefined ? 'implicit' : explicitExists ? 'explicit' : 'explicit-broken', configuredKernel: conf.kernelPath, matches: false })
      return
    }
    if (force === 'configure' || (manage && conf.kernelPath !== undefined && !explicitExists)) {
      // Explicit but pointing at nothing (or the user asked): repair.
      await this.pointWolframscriptAt(ws.path, located, base, conf.kernelPath === undefined ? 'requested' : 'explicit path was missing')
      return
    }
    if (conf.kernelPath !== undefined) {
      this.setWolframscript({ ...base, state: 'explicit', configuredKernel: conf.kernelPath, matches })
      return
    }
    // Implicit: does it find a kernel by itself? Probe once per (ws, conf, kernel).
    let wsMtime = 0
    try { wsMtime = statSync(ws.path).mtimeMs } catch { /* fine */ }
    const key = `${ws.path}|${version ?? ''}|${wsMtime}|${located.kernelPath}|implicit`
    let probe
    const cached = this.readCache()
    if (force !== 'probe' && cached?.key === key && typeof cached.ok === 'boolean') probe = { ok: cached.ok, output: cached.output ?? '', ms: cached.ms ?? 0, at: cached.at, cached: true }
    else {
      this.setWolframscript({ ...base, state: 'checking', configuredKernel: undefined, matches: false })
      const result = await probeWolframscript(ws.path)
      probe = { ...result, at: new Date().toISOString(), cached: false }
      this.writeCache({ key, ok: probe.ok, output: probe.output, ms: probe.ms, at: probe.at })
      this.options.trace({ event: 'wolframscript-probe', path: ws.path, ok: probe.ok, ms: probe.ms, output: probe.output })
    }
    if (probe.ok) { this.setWolframscript({ ...base, state: 'implicit-ok', configuredKernel: undefined, matches: false, probe }); return }
    if (!manage) { this.setWolframscript({ ...base, state: 'implicit-broken', configuredKernel: undefined, matches: false, probe }); return }
    await this.pointWolframscriptAt(ws.path, located, base, `probe failed: ${probe.output || 'no output'}`)
  }

  async pointWolframscriptAt(wsPath, located, base, why) {
    try {
      const conf = await configureWolframscriptKernel(wsPath, located.kernelPath)
      const ok = conf.kernelPath !== undefined && realpath(expandPath(conf.kernelPath)) === realpath(located.kernelPath)
      this.options.logger.info(`wolfram-kernel-supervisor: configured wolframscript (${wsPath}) to use ${located.kernelPath} — ${why}`)
      this.options.trace({ event: 'wolframscript-configure', path: wsPath, kernel: located.kernelPath, why, ok })
      // The explicit path changes what a probe would test; drop the implicit-mode cache entry.
      this.writeCache({ key: 'configured', at: new Date().toISOString() })
      this.setWolframscript({ ...base, confPath: conf.confPath, state: ok ? 'explicit' : 'explicit-broken', configuredKernel: conf.kernelPath, matches: ok, configuredByDsh: { at: new Date().toISOString(), why } })
    } catch (error) {
      const message = String(error?.message ?? error)
      this.options.logger.warn(`wolfram-kernel-supervisor: wolframscript -configure failed: ${message}`)
      this.setWolframscript({ ...base, state: 'error', error: message })
    }
  }

  setWolframscript(status) {
    this.wolframscript = { ...status, checkedAt: new Date().toISOString() }
    this.emit()
  }

  /** JSON snapshot for the settings card and for diagnostics. */
  status() {
    return {
      platform: process.platform,
      kernel: this.located === undefined ? undefined : { ...this.located },
      source: this.source,
      input: this.input,
      error: this.error,
      searched: this.searched,
      settingsAvailable: this.options.settingPath() !== undefined,
      manageWolframscript: this.options.manageWolframscript,
      wolframscript: this.wolframscript,
      checkedAt: this.checkedAt,
      message: this.located === undefined ? this.unconfiguredMessage() : undefined,
    }
  }
}

/**
 * @typedef {object} LocatedKernel
 * @property {string} kernelPath - the WolframKernel executable (what wolframscript wants).
 * @property {string} launcher - what the supervisor spawns: the sibling `wolfram` wrapper when present, else the kernel.
 * @property {string} root - the .app bundle or install directory, for display.
 * @property {string | undefined} version - product version when it could be read.
 */

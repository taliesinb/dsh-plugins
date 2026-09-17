/**
 * The Dock app: build, assemble, inspect and install the WKWebView wrapper in
 * `dock-app/` (see dock-app/Sources/main.swift for what it does).
 *
 * Why a wrapper and not Safari's "Add to Dock": Launch Services refuses to
 * launch a template-app bundle whose signature is not in its data vault, and
 * only Safari's private `templateapp.creation` entitlement can write that
 * vault — so a web-app bundle cannot be created by anything but Safari's own
 * UI. Safari's web app also holds only the 30-day DSH cookie and has no URL
 * bar to renew it. The wrapper needs no permission of any kind.
 *
 * Build (cached by mtime; Command Line Tools' swiftc, ~5 s cold):
 *   dock-app/build/DSH           the executable (Sources/main.swift)
 *   dock-app/build/make-icon     Tools/make-icon.swift
 *   dock-app/build/AppIcon.icns  icon.svg on a rounded tile
 * Install: assemble `<name>.app` (Info.plist, executable, icon, the JSON the
 * app reads), ad-hoc sign, replace `~/Applications/<name>.app` (only when the
 * existing item is a Safari web app or an earlier copy of ours), register it
 * with Launch Services, pin it to the Dock if no tile points at that path,
 * and launch it. macOS only.
 */
import { execFile } from 'node:child_process'
import { chmod, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
export const DOCK_APP_DIR = join(HERE, 'dock-app')
const BUILD_DIR = join(DOCK_APP_DIR, 'build')
export const BUNDLE_ID = 'io.github.taliesinb.dsh-dock-app'
/** Bundle id of one instance (`<base>.<instance>` for a preview app beside the main one — separate WebKit data store). */
export function bundleIdFor(instance = '') {
  return instance === '' ? BUNDLE_ID : `${BUNDLE_ID}.${instance}`
}
const EXECUTABLE = 'DSH'
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
const SAFARI_WEBAPP_TEMPLATE = 'com.apple.Safari.WebApp'

export function assertMacOS() {
  if (process.platform !== 'darwin') throw new Error('the Dock app is macOS-only')
}

export function applicationsDir() {
  return join(homedir(), 'Applications')
}

export function bundlePathFor(name) {
  return join(applicationsDir(), `${sanitizeName(name)}.app`)
}

/** A Finder-safe bundle name: no path separators or colons, trimmed, non-empty. */
export function sanitizeName(name) {
  const text = String(name ?? '').replace(/[/:\\]/g, ' ').trim()
  if (text === '' || text === '.' || text === '..') throw new Error('Dock app name must not be empty')
  return text.slice(0, 60)
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function mtime(path) {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return 0
  }
}

async function which(binary) {
  try {
    const { stdout } = await execFileAsync('/usr/bin/xcrun', ['--find', binary])
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

/** Whether the Swift toolchain is present (Command Line Tools or Xcode). */
export async function toolchainAvailable() {
  return (await which('swiftc')) !== undefined
}

/**
 * Compile the executable and the icon (skipped when the outputs are newer than their sources).
 * @param {{ glyphColor?: string, tileColor?: string, log?: (line: string) => void, force?: boolean }} options
 */
export async function buildDockApp(options = {}) {
  assertMacOS()
  const log = options.log ?? (() => {})
  if (!(await toolchainAvailable())) throw new Error('swiftc not found: install the Xcode Command Line Tools (xcode-select --install)')
  // Through xcrun so the SDK is resolved; the CLT binary invoked directly cannot find the standard library.
  const swiftc = '/usr/bin/xcrun'
  await mkdir(BUILD_DIR, { recursive: true })
  const source = join(DOCK_APP_DIR, 'Sources', 'main.swift')
  const executable = join(BUILD_DIR, EXECUTABLE)
  const target = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13.0`
  if (options.force || (await mtime(executable)) < (await mtime(source))) {
    log('dock-app: compiling the wrapper')
    await execFileAsync(swiftc, ['swiftc', '-O', '-target', target, '-o', executable, source, '-framework', 'Cocoa', '-framework', 'WebKit'], { maxBuffer: 8 * 1024 * 1024 })
  }
  const iconTool = join(BUILD_DIR, 'make-icon')
  const iconSource = join(DOCK_APP_DIR, 'Tools', 'make-icon.swift')
  if (options.force || (await mtime(iconTool)) < (await mtime(iconSource))) {
    log('dock-app: compiling the icon renderer')
    await execFileAsync(swiftc, ['swiftc', '-O', '-target', target, '-o', iconTool, iconSource, '-framework', 'Cocoa'], { maxBuffer: 8 * 1024 * 1024 })
  }
  const glyph = join(DOCK_APP_DIR, 'icon.svg')
  const glyphColor = options.glyphColor ?? '#000000'
  const tileColor = options.tileColor ?? '#ffffff'
  const iconTag = `${glyphColor}-${tileColor}`.replace(/[^a-z0-9-]/gi, '')
  const icns = join(BUILD_DIR, `AppIcon-${iconTag}.icns`)
  if (options.force || (await mtime(icns)) < Math.max(await mtime(glyph), await mtime(iconSource))) {
    log('dock-app: rendering the icon')
    const iconset = join(BUILD_DIR, `AppIcon-${iconTag}.iconset`)
    await rm(iconset, { recursive: true, force: true })
    await execFileAsync(iconTool, [glyph, iconset, '--glyph-color', glyphColor, '--tile-color', tileColor])
    await execFileAsync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', icns])
    await rm(iconset, { recursive: true, force: true })
  }
  return { executable, icns }
}

function plistString(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** @param {{ name: string, version?: string, bundleId?: string }} spec */
export function infoPlist(spec) {
  const name = plistString(spec.name)
  const bundleId = spec.bundleId ?? BUNDLE_ID
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>${name}</string>
  <key>CFBundleExecutable</key><string>${EXECUTABLE}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>${bundleId}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>${name}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${plistString(spec.version ?? '1.0')}</string>
  <key>CFBundleVersion</key><string>${plistString(spec.version ?? '1.0')}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict>
</plist>
`
}

/**
 * Write a complete, signed bundle at `dest` (which must not exist).
 * @param {{ dest: string, name: string, url: string, fallbackUrl?: string, tokenFile?: string,
 *   executable: string, icns: string, version?: string, bundleId?: string }} spec
 */
export async function assembleBundle(spec) {
  const contents = join(spec.dest, 'Contents')
  const bundleId = spec.bundleId ?? BUNDLE_ID
  await mkdir(join(contents, 'MacOS'), { recursive: true })
  await mkdir(join(contents, 'Resources'), { recursive: true })
  await writeFile(join(contents, 'Info.plist'), infoPlist({ name: spec.name, version: spec.version, bundleId }))
  await writeFile(join(contents, 'PkgInfo'), 'APPL????')
  await cp(spec.executable, join(contents, 'MacOS', EXECUTABLE))
  await chmod(join(contents, 'MacOS', EXECUTABLE), 0o755)
  await cp(spec.icns, join(contents, 'Resources', 'AppIcon.icns'))
  const config = { name: spec.name, url: spec.url, fallbackUrl: spec.fallbackUrl, tokenFile: spec.tokenFile }
  await writeFile(join(contents, 'Resources', 'dsh-dock-app.json'), `${JSON.stringify(config, null, 2)}\n`)
  await execFileAsync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', bundleId, spec.dest])
  return spec.dest
}

/**
 * What currently sits at `~/Applications/<name>.app`.
 * @returns {Promise<{ path: string, kind: 'none'|'wrapper'|'safari-webapp'|'other', url?: string, name?: string, bundleId?: string }>}
 */
export async function inspectBundle(path) {
  const plistPath = join(path, 'Contents', 'Info.plist')
  if (!(await exists(plistPath))) return { path, kind: 'none' }
  let info
  try {
    const { stdout } = await execFileAsync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], { maxBuffer: 4 * 1024 * 1024 })
    info = JSON.parse(stdout)
  } catch {
    return { path, kind: 'other' }
  }
  const bundleId = typeof info.CFBundleIdentifier === 'string' ? info.CFBundleIdentifier : undefined
  if (bundleId === BUNDLE_ID || String(bundleId ?? '').startsWith(`${BUNDLE_ID}.`)) {
    let config = {}
    try {
      config = JSON.parse(await readFile(join(path, 'Contents', 'Resources', 'dsh-dock-app.json'), 'utf8'))
    } catch {
      // unreadable config: still ours
    }
    return { path, kind: 'wrapper', url: typeof config.url === 'string' ? config.url : undefined, name: config.name, bundleId }
  }
  const template = info.LSTemplateApplicationParameters?.CFBundleIdentifier
  if (template === SAFARI_WEBAPP_TEMPLATE || String(bundleId ?? '').startsWith(`${SAFARI_WEBAPP_TEMPLATE}.`)) {
    const start = info.Manifest?.start_url ?? info.WKPushBundleMetadata?.manifestId
    return { path, kind: 'safari-webapp', url: typeof start === 'string' ? start : undefined, name: info.CFBundleName, bundleId }
  }
  return { path, kind: 'other', bundleId, name: info.CFBundleName }
}

/** Snapshot for the settings panel. */
export async function dockAppStatus({ name, url }) {
  if (process.platform !== 'darwin') return { supported: false, path: '', kind: 'none', current: false, toolchain: false }
  const path = bundlePathFor(name)
  const bundle = await inspectBundle(path)
  return {
    supported: true,
    path,
    kind: bundle.kind,
    url: bundle.url,
    current: bundle.kind === 'wrapper' && bundle.url === url,
    toolchain: await toolchainAvailable(),
  }
}

/** Terminate a running copy of the bundle by executable path (no Apple Events, so no Automation prompt). */
async function quitBundle(bundlePath) {
  await execFileAsync('/usr/bin/pkill', ['-TERM', '-f', `${bundlePath}/Contents/MacOS/`]).catch(() => {})
  await new Promise(resolve => setTimeout(resolve, 300))
}

/**
 * The Dock's `persistent-apps` as raw XML `<dict>` items. The plist carries
 * `<data>` blobs, so a JSON round trip through plutil is impossible; the XML
 * is read through cfprefsd (`defaults export`) and rewritten verbatim.
 * @returns {Promise<string[]>}
 */
export async function dockTileItems(xml) {
  const text = xml ?? (await execFileAsync('/usr/bin/defaults', ['export', 'com.apple.dock', '-'], { maxBuffer: 16 * 1024 * 1024 })).stdout
  const keyAt = text.indexOf('<key>persistent-apps</key>')
  if (keyAt === -1) return []
  const tag = /<(\/?)(array|dict)(\/?)>/g
  tag.lastIndex = keyAt + '<key>persistent-apps</key>'.length
  const first = tag.exec(text)
  if (first === null || first[2] !== 'array' || first[1] === '/') return []
  if (first[3] === '/') return []
  const items = []
  let depth = 0
  let itemStart = -1
  for (let match = tag.exec(text); match !== null; match = tag.exec(text)) {
    const [whole, closing, name, selfClosing] = match
    if (selfClosing === '/') {
      if (depth === 0 && name === 'dict') items.push(whole)
      continue
    }
    if (closing === '') {
      if (depth === 0 && name === 'dict') itemStart = match.index
      depth += 1
    } else {
      depth -= 1
      if (depth === 0 && name === 'dict') items.push(text.slice(itemStart, match.index + whole.length))
      if (depth < 0) break // the array's own </array>
    }
  }
  return items
}

/** Bundle path a `<dict>` tile points at, or undefined. */
export function tileBundlePath(item) {
  const raw = /<key>_CFURLString<\/key>\s*<string>([^<]*)<\/string>/.exec(item)?.[1]
  if (raw === undefined) return undefined
  try {
    return decodeURIComponent(raw.replace(/&amp;/g, '&').replace(/^file:\/\//, '')).replace(/\/+$/, '')
  } catch {
    return raw
  }
}

/** Pin the bundle to the Dock unless a tile already points at its path; restarts the Dock when it changed. */
export async function ensureDockTile(bundlePath, log = () => {}) {
  const target = bundlePath.replace(/\/+$/, '')
  if ((await dockTileItems()).some(item => tileBundlePath(item) === target)) return false
  const fileUrl = `file://${encodeURI(target)}/`
  const tile = `<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>${plistString(fileUrl)}</string><key>_CFURLStringType</key><integer>15</integer></dict></dict><key>tile-type</key><string>file-tile</string></dict>`
  await execFileAsync('/usr/bin/defaults', ['write', 'com.apple.dock', 'persistent-apps', '-array-add', tile])
  await execFileAsync('/usr/bin/killall', ['Dock']).catch(() => {})
  log(`dock-app: pinned ${bundlePath} to the Dock`)
  return true
}

/**
 * Drop Dock tiles pointing at `bundlePath` (all of them, or all but the first
 * with `keepFirst`); restarts the Dock when anything was removed.
 */
export async function removeDockTile(bundlePath, log = () => {}, { keepFirst = false } = {}) {
  const items = await dockTileItems()
  const target = bundlePath.replace(/\/+$/, '')
  let seen = 0
  const kept = items.filter((item) => {
    if (tileBundlePath(item) !== target) return true
    seen += 1
    return keepFirst && seen === 1
  })
  if (kept.length === items.length) return false
  await execFileAsync('/usr/bin/defaults', ['write', 'com.apple.dock', 'persistent-apps', `<array>${kept.join('')}</array>`])
  await execFileAsync('/usr/bin/killall', ['Dock']).catch(() => {})
  log(`dock-app: removed ${String(items.length - kept.length)} Dock tile(s) for ${bundlePath}`)
  return true
}

/**
 * Build + assemble + replace + register + pin + launch.
 * @param {{ name: string, url: string, fallbackUrl?: string, tokenFile?: string, launch?: boolean, instance?: string,
 *   glyphColor?: string, tileColor?: string, version?: string, log?: (line: string) => void }} spec
 */
export async function installDockApp(spec) {
  assertMacOS()
  const log = spec.log ?? (() => {})
  const name = sanitizeName(spec.name)
  const dest = bundlePathFor(name)
  const existing = await inspectBundle(dest)
  if (existing.kind === 'other') {
    throw new Error(`${dest} exists and is neither a Safari web app nor a DSH Dock app (${existing.bundleId ?? 'unknown bundle'}); remove it or choose another name`)
  }
  const built = await buildDockApp({ glyphColor: spec.glyphColor, tileColor: spec.tileColor, log })
  await mkdir(applicationsDir(), { recursive: true })
  const staging = join(applicationsDir(), `.${name}.app.staging-${String(process.pid)}`)
  await rm(staging, { recursive: true, force: true })
  await assembleBundle({ dest: staging, name, url: spec.url, fallbackUrl: spec.fallbackUrl, tokenFile: spec.tokenFile, executable: built.executable, icns: built.icns, version: spec.version, bundleId: bundleIdFor(spec.instance ?? '') })
  if (existing.kind !== 'none') {
    log(`dock-app: replacing ${existing.kind} at ${dest}${existing.url === undefined ? '' : ` (${existing.url})`}`)
    await quitBundle(dest)
    await execFileAsync(LSREGISTER, ['-u', dest]).catch(() => {})
    await rm(dest, { recursive: true, force: true })
  }
  await rename(staging, dest)
  await execFileAsync(LSREGISTER, ['-f', dest]).catch(() => {})
  const pinned = await ensureDockTile(dest, log)
  if (spec.launch !== false) await execFileAsync('/usr/bin/open', [dest])
  log(`dock-app: installed ${dest} -> ${spec.url}`)
  return { path: dest, replaced: existing.kind, pinned }
}

/** Remove the wrapper (never a Safari web app or anything else). */
export async function uninstallDockApp({ name }) {
  assertMacOS()
  const dest = bundlePathFor(name)
  const existing = await inspectBundle(dest)
  if (existing.kind !== 'wrapper') return { removed: false, kind: existing.kind }
  await quitBundle(dest)
  await execFileAsync(LSREGISTER, ['-u', dest]).catch(() => {})
  await rm(dest, { recursive: true, force: true })
  await removeDockTile(dest)
  return { removed: true, kind: existing.kind }
}

/** Names of other wrapper installs (e.g. a preview named differently). */
export async function listWrappers() {
  const dir = applicationsDir()
  const out = []
  for (const entry of await readdir(dir).catch(() => [])) {
    if (!entry.endsWith('.app')) continue
    const bundle = await inspectBundle(join(dir, entry))
    if (bundle.kind === 'wrapper') out.push({ name: basename(entry, '.app'), url: bundle.url })
  }
  return out
}

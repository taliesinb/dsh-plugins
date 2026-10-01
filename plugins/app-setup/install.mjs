/**
 * Best-effort installers for the companion apps, without Homebrew: each ships
 * as a direct download that macOS can install headlessly.
 *
 *   tailscale  .pkg from pkgs.tailscale.com         → `installer -pkg -target /`   (admin)
 *   stp        .dmg (Apple's download page → the current STP URL) holding a .pkg
 *                                                    → mount + `installer`         (admin)
 *   chrome     .dmg from dl.google.com holding the .app → mount + copy to /Applications
 *   afm        GitHub release tarball                → unpacked into $DSH_HOME/app-setup/bin,
 *                                                      which the embedded server puts on PATH
 *
 * Admin steps run through `osascript … with administrator privileges`: macOS
 * shows its own authentication dialog, and no password ever passes through DSH.
 * The caller supplies `report(step, fraction)` for the dialog's progress; the
 * download phase reports bytes over Content-Length, later phases report their
 * start and end. Everything downloaded goes to a private temp dir removed on
 * completion. A job runs at most once per item at a time.
 */
import { execFile, spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const execFileAsync = promisify(execFile)
const UA = 'dsh-canary-app-setup/1'

export const INSTALLERS = {
  tailscale: { label: 'Tailscale', admin: true, run: installTailscale },
  stp: { label: 'Safari Technology Preview', admin: true, run: installStp },
  chrome: { label: 'Google Chrome', admin: false, run: installChrome },
  afm: { label: 'afm', admin: false, run: installAfm },
}

/** Where afm (and any future binary) is installed for the app: on the embedded server's PATH via EmbeddedServer.swift. */
export function appBinDir(home) { return join(home, 'app-setup', 'bin') }

async function download(url, dest, report) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} for ${url}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  let done = 0
  const counter = new TransformStreamCounter(chunk => { done += chunk.length; report('download', total ? done / total : 0) })
  await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(dest))
  report('download', 1)
  return dest
}

import { Transform } from 'node:stream'
class TransformStreamCounter extends Transform {
  constructor(onChunk) { super(); this.onChunk = onChunk }
  _transform(chunk, _enc, cb) { this.onChunk(chunk); cb(null, chunk) }
}

/** Run a shell command as admin through macOS's own authentication dialog. */
async function asAdmin(command, prompt) {
  const script = `do shell script ${JSON.stringify(command)} with administrator privileges with prompt ${JSON.stringify(prompt)}`
  try {
    await execFileAsync('/usr/bin/osascript', ['-e', script], { timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 })
  } catch (error) {
    const text = String(error.stderr ?? error.message)
    if (/-128|User canceled/.test(text)) throw new Error('cancelled at the password prompt')
    throw new Error(firstLine(text) || 'the privileged step failed')
  }
}

async function mountDmg(dmg) {
  const { stdout } = await execFileAsync('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-noverify', '-plist', dmg], { maxBuffer: 8 * 1024 * 1024 })
  const mount = /<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/.exec(stdout)?.[1]
  if (!mount) throw new Error('hdiutil attach: no mount point')
  return mount
}
async function unmount(mount) {
  await execFileAsync('/usr/bin/hdiutil', ['detach', mount, '-quiet']).catch(() => execFileAsync('/usr/bin/hdiutil', ['detach', mount, '-force', '-quiet']).catch(() => {}))
}

async function installTailscale({ work, report }) {
  const pkg = await download('https://pkgs.tailscale.com/stable/Tailscale-latest-macos.pkg', join(work, 'Tailscale.pkg'), report)
  report('install', 0)
  await asAdmin(`/usr/sbin/installer -pkg ${shellQuote(pkg)} -target /`, 'DSH installs Tailscale.')
  report('install', 1)
  return { launch: '/Applications/Tailscale.app' }
}

async function installStp({ work, report }) {
  // Apple republishes STP under a fresh URL each release; the download page is the index.
  const page = await (await fetch('https://developer.apple.com/safari/download/', { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh)' } })).text()
  const urls = [...page.matchAll(/https:\/\/[^" ]*Safari[^" ]*\.dmg/g)].map(m => m[0])
  // Two builds are listed (macOS N and N-1); the one whose file name carries no OS suffix is the current OS's.
  const url = urls.find(u => /SafariTechnologyPreview\.dmg$/.test(u)) ?? urls[0]
  if (!url) throw new Error('could not find the Safari Technology Preview download on developer.apple.com')
  const dmg = await download(url, join(work, 'STP.dmg'), report)
  report('install', 0)
  const mount = await mountDmg(dmg)
  try {
    const pkg = (await readdir(mount)).find(n => n.endsWith('.pkg'))
    if (!pkg) throw new Error('the Safari Technology Preview image holds no .pkg')
    await asAdmin(`/usr/sbin/installer -pkg ${shellQuote(join(mount, pkg))} -target /`, 'DSH installs Safari Technology Preview.')
  } finally {
    await unmount(mount)
  }
  report('install', 1)
  return {}
}

async function installChrome({ work, report }) {
  const dmg = await download('https://dl.google.com/chrome/mac/universal/stable/GGRO/googlechrome.dmg', join(work, 'Chrome.dmg'), report)
  report('install', 0)
  const mount = await mountDmg(dmg)
  try {
    const app = (await readdir(mount)).find(n => n.endsWith('.app'))
    if (!app) throw new Error('the Chrome image holds no .app')
    const dest = '/Applications/' + app
    // Never write over an existing (possibly running) install: SIP-adjacent
    // protections make that fail file by file. Copy beside, then rename in.
    if (await stat(dest).catch(() => null)) throw new Error(`${dest} already exists`)
    const staging = dest.replace(/\.app$/, '.dsh-install.app')
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    try {
      await execFileAsync('/usr/bin/ditto', [join(mount, app), staging])
      await execFileAsync('/bin/mv', [staging, dest])
    } catch {
      // /Applications not writable for this user: once more through the admin dialog.
      await rm(staging, { recursive: true, force: true }).catch(() => {})
      await asAdmin(`/usr/bin/ditto ${shellQuote(join(mount, app))} ${shellQuote(staging)} && /bin/mv ${shellQuote(staging)} ${shellQuote(dest)}`, 'DSH installs Google Chrome.')
    }
  } finally {
    await unmount(mount)
  }
  report('install', 1)
  return {}
}

async function installAfm({ work, report, home }) {
  const release = await (await fetch('https://api.github.com/repos/scouzi1966/maclocal-api/releases/latest', { headers: { 'user-agent': UA, accept: 'application/vnd.github+json' } })).json()
  const asset = (release.assets ?? []).find(a => /-arm64\.tar\.gz$/.test(a.name))
  if (!asset) throw new Error('no arm64 tarball on the latest afm release')
  const tgz = await download(asset.browser_download_url, join(work, 'afm.tgz'), report)
  report('install', 0)
  const bin = appBinDir(home)
  const unpack = join(bin, 'afm-dist')
  await rm(unpack, { recursive: true, force: true })
  await mkdir(unpack, { recursive: true })
  await execFileAsync('/usr/bin/tar', ['-xzf', tgz, '-C', unpack])
  await chmod(join(unpack, 'afm'), 0o755)
  // The binary loads its Resources/ and bundle beside itself: a symlink on the bin dir keeps them together.
  await rm(join(bin, 'afm'), { force: true })
  await execFileAsync('/bin/ln', ['-s', join(unpack, 'afm'), join(bin, 'afm')])
  report('install', 1)
  return { version: release.tag_name }
}

/** The first informative line of a tool's output, without osascript's `N:M: execution error:` prefix, capped for a dialog row. */
export function firstLine(text) {
  const line = String(text).replace(/^\d+:\d+: execution error: /, '').split(/[\r\n]+/).map(l => l.trim()).find(Boolean) ?? ''
  return line.length > 160 ? line.slice(0, 157) + '…' : line
}

function shellQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'` }

/**
 * Run one installer. `report(step, fraction)` is called from the download and
 * install phases; the returned promise settles with the installer's result.
 */
export async function runInstaller(id, { home, report }) {
  const entry = INSTALLERS[id]
  if (!entry) throw new Error(`no installer for ${id}`)
  const work = await mkdtemp(join(tmpdir(), `dsh-app-setup-${id}-`))
  try {
    return await entry.run({ work, report, home })
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

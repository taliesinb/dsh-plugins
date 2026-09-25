#!/usr/bin/env node
/**
 * Assemble the self-contained macOS app and its DMG from the staged pieces:
 *
 *   dist/bundle/stage/     tools/bundle/stage-dsh.mjs   (fork + plugins, production closure)
 *   dist/bundle/node/      tools/bundle/fetch-node.mjs  (official Node LTS build)
 *   dock-app/build/DSH     dsh-tailscale-remote's Swift wrapper (compiled here if stale)
 *
 *   node tools/bundle/build-app.mjs [--build N] [--name "DSH Canary"] [--glyph-color "#E5484D"] [--port 3090]
 *                                   [--sign IDENTITY] [--update-repo owner/name] [--update-feed URL] [--no-dmg]
 *                                   [--version X.Y.Z] [--out dist/bundle]
 *
 * Layout (Contents/Resources): node/ (bin/node only), dsh/ (package.json +
 * node_modules), profile-template/ (package.json listing every bundled
 * plugin as a profile bundle + an empty cordis.patch.yml), dsh-dock-app.json
 * with the `embedded` block EmbeddedServer.swift reads, AppIcon.icns.
 *
 * Signing: `--sign -` (default) is ad-hoc — Gatekeeper shows "cannot verify"
 * on a downloaded DMG until the user right-clicks → Open once; pass a
 * `Developer ID Application: …` identity to sign for real (notarization is a
 * separate `xcrun notarytool submit` step this script does not run).
 * Node addons (.node) and the node binary are signed too: a deep signature
 * over a bundle with unsigned Mach-O files is rejected at launch by the
 * hardened runtime when a real identity is used.
 */
import { execFile } from 'node:child_process'
import { chmod, cp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const args = process.argv.slice(2)
const opt = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1] }
const OUT = resolve(opt('--out', join(REPO, 'dist', 'bundle')))
const STAGE = join(OUT, 'stage')
// "DSH Canary" with the red whale: the bundled build is the pre-release channel
// beside a checkout-run DSH (stock black) and DSH Preview (the same red, but
// a different bundle id and Dock name, so the two never collide).
const NAME = opt('--name', 'DSH Canary')
const GLYPH = opt('--glyph-color', '#E5484D')
const PORT = Number(opt('--port', '3090'))
const SIGN = opt('--sign', '-')
const DMG = !args.includes('--no-dmg')
const PRUNE = !args.includes('--no-prune')
const WITH_OFFICE = args.includes('--with-office')
const BUNDLE_ID = 'io.github.taliesinb.dsh-app'
/** GitHub owner/repo whose Releases the app polls for updates (Updater.swift). */
const REPO_SLUG = opt('--update-repo', 'taliesinb/dsh-plugins')

const dockApp = await import(pathToFileURL(join(REPO, 'plugins', 'dsh-tailscale-remote', 'dock-app.mjs')).href)

function log(msg) { process.stderr.write(`[build-app] ${msg}\n`) }
const readJson = async p => JSON.parse(await readFile(p, 'utf8'))

/**
 * App identity: a BUILD number (integer, CFBundleVersion, what the updater
 * compares — `--build 2026092401`, default 0 = "dev build, every release is
 * newer") and a calver display version derived from it (`2026.9.24`, or
 * `2026.9.24.2` for the day's second build; `--version` overrides). The fork's
 * own version and the repo SHA go into the release manifest and
 * CFBundleGetInfoString, not into the comparison.
 */
async function version() {
  const build = Number(opt('--build', '0'))
  if (!Number.isSafeInteger(build) || build < 0) throw new Error(`--build must be a non-negative integer, got ${opt('--build')}`)
  const stage = await readJson(join(STAGE, 'package.json'))
  const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO })
  let short = opt('--version')
  if (!short) {
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})$/.exec(String(build))
    short = m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}${Number(m[4]) > 1 ? `.${Number(m[4])}` : ''}` : '0.0.0'
  }
  return { build, short, full: `${short} (build ${build}, dsh ${stage.version}, ${stdout.trim()})` }
}

/** Every Mach-O inside the resources that must carry a signature of its own. */
async function machOFiles(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) out.push(...await machOFiles(path))
    else if (entry.name.endsWith('.node') || entry.name.endsWith('.dylib') || path.endsWith('/bin/node')
      || path.endsWith('/rg') || path.endsWith('/spawn-helper') || path.endsWith('/landlock-run')) out.push(path)
  }
  return out
}

/**
 * Drop what the runtime never reads (measured 2026-09-23 on the 640 MB tree):
 * declarations 41 MB, source maps 46 MB, TypeScript sources 42 MB, READMEs
 * 8 MB, test dirs 10 MB, node-pty's other-platform prebuilds 24 MB, three.js
 * examples/src 29 MB (the wolfram client bundle inlines its own copy), and —
 * unless --with-office — the 259 MB native LibreOffice engine behind Office →
 * PDF previews (dsh-office-to-pdf creates its converter lazily on first use,
 * so boot is unaffected; a preview then reports the engine as unavailable).
 * Mirrors upstream's apps/desktop/scripts/runtime-file-policy.ts in spirit.
 */
async function prune(root) {
  let files = 0, bytes = 0
  const dropFile = async (path) => { bytes += (await stat(path)).size; files++; await rm(path, { force: true }) }
  const dropDir = async (path) => {
    const out = await execFileAsync('du', ['-sk', path]).catch(() => null)
    if (!out) return
    bytes += Number(out.stdout.split('\t')[0]) * 1024; files++
    await rm(path, { recursive: true, force: true })
  }
  const platform = `${process.platform}-${process.arch}`
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (/^(?:test|tests|__tests__|testdata|\.github)$/.test(entry.name)) { await dropDir(path); continue }
        if (dir.endsWith('/node-pty/prebuilds') && entry.name !== platform) { await dropDir(path); continue }
        if (dir.endsWith('/node_modules/three') && (entry.name === 'examples' || entry.name === 'src')) { await dropDir(path); continue }
        await walk(path)
        continue
      }
      if (/\.(?:d\.[mc]?ts|map|tsbuildinfo)$/.test(entry.name)) { await dropFile(path); continue }
      // Only documentation by name: SKILL.md, preset guides and chrome-devtools-mcp's
      // issue descriptions are runtime data (measured), so `*.md` wholesale is wrong.
      if (/^(?:README|CHANGELOG|CHANGES|HISTORY|CONTRIBUTING|SECURITY|CODE_OF_CONDUCT|UPGRADING|MIGRATION)[^/]*\.md$/i.test(entry.name)) { await dropFile(path); continue }
      // Plain .ts sources (never .d.ts, handled above): the runtime is built JavaScript throughout.
      if (/\.[mc]?ts$/.test(entry.name) && !dir.includes('/node_modules/typescript/')) { await dropFile(path); continue }
    }
  }
  await walk(root)
  if (!WITH_OFFICE) {
    for (const name of await readdir(join(root, '@deepseek-ai'))) {
      if (/^libreoffice-kit-(?:darwin|win32|linux)-|^libreoffice-kit-wasm$/.test(name)) await dropDir(join(root, '@deepseek-ai', name))
    }
  }
  log(`pruned ${files} entries, ${(bytes / 1024 / 1024).toFixed(0)} MB`)
}

async function main() {
  const stagePkg = await readJson(join(STAGE, 'package.json'))
  const nodeInfo = await readJson(join(OUT, 'node', 'current.json'))
  const ver = await version()
  const app = join(OUT, `${NAME}.app`)
  const contents = join(app, 'Contents')
  const resources = join(contents, 'Resources')
  log(`building ${app} (dsh ${ver.full}, node ${nodeInfo.version}, ${stagePkg.dshBundle.plugins.length} plugins)`)

  const { executable, icns } = await dockApp.buildDockApp({ log, glyphColor: GLYPH })

  await rm(app, { recursive: true, force: true })
  await mkdir(join(contents, 'MacOS'), { recursive: true })
  await mkdir(resources, { recursive: true })
  await cp(executable, join(contents, 'MacOS', 'DSH'))
  await chmod(join(contents, 'MacOS', 'DSH'), 0o755)
  await cp(icns, join(resources, 'AppIcon.icns'))

  log('copying node')
  await mkdir(join(resources, 'node', 'bin'), { recursive: true })
  await cp(join(OUT, 'node', nodeInfo.dir, 'bin', 'node'), join(resources, 'node', 'bin', 'node'))
  await cp(join(OUT, 'node', nodeInfo.dir, 'LICENSE'), join(resources, 'node', 'LICENSE'))
  if (PRUNE) {
    // The official binary carries local symbols (121 → 97 MB). Stripping invalidates its
    // signature (SIGKILL on launch) — it is re-signed with everything else below.
    await execFileAsync('/usr/bin/strip', ['-x', join(resources, 'node', 'bin', 'node')])
  }

  log('copying the staged installation')
  await mkdir(join(resources, 'dsh'), { recursive: true })
  await cp(join(STAGE, 'package.json'), join(resources, 'dsh', 'package.json'))
  // node_modules is hoisted (no links out of the tree); copy dereferences the few pnpm-internal symlinks.
  await cp(join(STAGE, 'node_modules'), join(resources, 'dsh', 'node_modules'), { recursive: true, dereference: true, verbatimSymlinks: false })
  if (PRUNE) await prune(join(resources, 'dsh', 'node_modules'))

  const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...stagePkg.dshBundle.plugins.map(p => p.name)]
  await mkdir(join(resources, 'profile-template'), { recursive: true })
  await writeFile(join(resources, 'profile-template', 'package.json'), JSON.stringify({
    name: 'dsh-profile-app', private: true, dependencies: {}, dsh: { profile: { bundles } },
  }, null, 2) + '\n')
  await writeFile(join(resources, 'profile-template', 'cordis.patch.yml'), '# Your overrides for the bundled DSH app (applied after every bundle layer).\n[]\n')

  const config = {
    name: NAME,
    url: `http://127.0.0.1:${PORT}/`,
    glyphColor: GLYPH,   // the page's sidebar whale follows the Dock icon (main.swift identityScript)
    embedded: {
      node: 'node/bin/node',
      dsh: 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
      profile: 'app',
      port: PORT,
      profileTemplate: 'profile-template',
      dshHome: null,
    },
    update: { repo: REPO_SLUG, intervalHours: 6, feed: opt('--update-feed') ?? null },
  }
  await writeFile(join(resources, 'dsh-dock-app.json'), JSON.stringify(config, null, 2) + '\n')
  await writeFile(join(resources, 'dsh-app-release.json'), JSON.stringify({
    build: ver.build, version: ver.short, dsh: stagePkg.version, node: nodeInfo.version, plugins: stagePkg.dshBundle.plugins, builtAt: new Date().toISOString(),
  }, null, 2) + '\n')

  let plist = dockApp.infoPlist({ name: NAME, version: ver.short, bundleId: BUNDLE_ID })
  plist = plist.replace(`<key>CFBundleVersion</key><string>${ver.short}</string>`, `<key>CFBundleVersion</key><string>${ver.build}</string>`)
  plist = plist.replace('<key>NSHighResolutionCapable</key>',
    `<key>LSMultipleInstancesProhibited</key><true/>\n  <key>CFBundleGetInfoString</key><string>${ver.full}</string>\n  <key>NSHighResolutionCapable</key>`)
  if (!plist.includes(`<string>${ver.build}</string>`)) throw new Error('CFBundleVersion substitution failed; infoPlist() changed shape')
  await writeFile(join(contents, 'Info.plist'), plist)
  await writeFile(join(contents, 'PkgInfo'), 'APPL????')

  log(`signing (${SIGN === '-' ? 'ad-hoc' : SIGN})`)
  const inner = await machOFiles(resources)
  for (const file of inner) {
    await execFileAsync('/usr/bin/codesign', ['--force', '--sign', SIGN, ...(SIGN === '-' ? [] : ['--options', 'runtime', '--timestamp']), file])
  }
  await execFileAsync('/usr/bin/codesign', ['--force', '--sign', SIGN, '--identifier', BUNDLE_ID, ...(SIGN === '-' ? [] : ['--options', 'runtime', '--timestamp']), app])
  await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
  const size = (await execFileAsync('du', ['-sh', app])).stdout.split('\t')[0]
  log(`app ready: ${app} (${size}, ${inner.length} inner Mach-O files signed)`)

  if (DMG) {
    const dmg = join(OUT, `${NAME.replace(/\s+/g, '-')}-${ver.short}${ver.build ? `-${ver.build}` : ''}.dmg`)
    const staging = join(OUT, 'dmg-root')
    await rm(staging, { recursive: true, force: true })
    await rm(dmg, { force: true })
    await mkdir(staging, { recursive: true })
    await cp(app, join(staging, `${NAME}.app`), { recursive: true, verbatimSymlinks: true })
    await symlink('/Applications', join(staging, 'Applications'))
    log('creating the DMG')
    await execFileAsync('/usr/bin/hdiutil', ['create', '-volname', NAME, '-srcfolder', staging, '-ov', '-format', 'ULMO', '-fs', 'APFS', dmg], { maxBuffer: 16 * 1024 * 1024 })
    await rm(staging, { recursive: true, force: true })
    const dmgSize = (await stat(dmg)).size
    log(`dmg ready: ${dmg} (${(dmgSize / 1024 / 1024).toFixed(0)} MB)`)
    process.stdout.write(dmg + '\n')
  } else {
    process.stdout.write(app + '\n')
  }
}

main().catch(err => { console.error(err); process.exit(1) })

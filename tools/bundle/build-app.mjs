#!/usr/bin/env node
/**
 * Assemble the self-contained macOS app and its DMG from the staged pieces:
 *
 *   dist/bundle/stage/     tools/bundle/stage-dsh.mjs   (fork + plugins, production closure)
 *   dist/bundle/node/      tools/bundle/fetch-node.mjs  (official Node LTS build)
 *   dock-app/build/DSH     dsh-tailscale-remote's Swift wrapper (compiled here if stale)
 *
 *   node tools/bundle/build-app.mjs [--build N] [--name "DSH"] [--glyph-color "#000000"] [--port 3090]
 *                                   [--sign IDENTITY] [--update-repo owner/name] [--update-feed URL] [--no-update]
 *                                   [--dsh-home DIR] [--bundle-id ID] [--out DIR] [--inputs DIR] [--no-dmg]
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
/** Where the .app (and DMG) land; the staged inputs default to dist/bundle regardless (`--inputs DIR` to move them). */
const OUT = resolve(opt('--out', join(REPO, 'dist', 'bundle')))
const INPUTS = resolve(opt('--inputs', join(REPO, 'dist', 'bundle')))
const STAGE = join(INPUTS, 'stage')
const NODE_DIR = join(INPUTS, 'node')
// "DSH Canary" with the red whale: the bundled build is the pre-release channel
// beside a checkout-run DSH (stock black) and DSH Preview (the same red, but
// a different bundle id and Dock name, so the two never collide).
/** Plain `DSH` for the release; `pnpm canary --app` passes its own label. Tags stay `canary-N` (release.mjs). */
const NAME = opt('--name', 'DSH')
/** Black whale for the plain `DSH` release, like the shipped GUI; `pnpm canary --app` passes the red. */
const GLYPH = opt('--glyph-color', '#000000')
const PORT = Number(opt('--port', '3090'))
const SIGN = opt('--sign', '-')
const DMG = !args.includes('--no-dmg')
const PRUNE = !args.includes('--no-prune')
const WITH_OFFICE = args.includes('--with-office')
/** `--bundle-id` lets a canary app coexist with the release app (separate WebKit store, no LSMultipleInstances clash). */
const BUNDLE_ID = opt('--bundle-id', 'io.github.taliesinb.dsh-app')
/** `--dsh-home DIR` pins the app to that DSH home (a canary's throwaway home); default: `$DSH_HOME` / `~/.dsh` at run time. */
const DSH_HOME = opt('--dsh-home') ?? null
/** `--no-update` leaves the update block out (a canary must not replace itself with the release). */
const UPDATES = !args.includes('--no-update')
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

/** Compile a dock-app/Tools/*.swift helper on demand (cached by mtime), like buildDockApp does for the icon renderer. */
async function swiftTool(name) {
  const toolsDir = join(REPO, 'plugins', 'dsh-tailscale-remote', 'dock-app')
  const source = join(toolsDir, 'Tools', `${name}.swift`)
  const binary = join(toolsDir, 'build', name)
  const mtime = async p => (await stat(p).catch(() => null))?.mtimeMs ?? 0
  if (await mtime(binary) < await mtime(source)) {
    log(`compiling ${name}`)
    await mkdir(join(toolsDir, 'build'), { recursive: true })
    await execFileAsync('/usr/bin/xcrun', ['swiftc', '-O', '-o', binary, source, '-framework', 'Cocoa'], { maxBuffer: 8 * 1024 * 1024 })
  }
  return binary
}

/**
 * Finder writes the volume's .DS_Store: icon view, backdrop, positions. Runs
 * through osascript against the mounted read-write image; Finder must be
 * running (it always is on a logged-in desktop). Positions are icon centres
 * in the 660×400 content area, matching the backdrop's arrow and caption.
 */
async function layoutDmgWindow(mount, appName) {
  const volume = mount.split('/').pop()
  const script = `
    tell application "Finder"
      tell disk "${volume}"
        open
        set current view of container window to icon view
        set toolbar visible of container window to false
        set statusbar visible of container window to false
        set pathbar visible of container window to false
        set sidebar width of container window to 0
        set the bounds of container window to {200, 120, 860, 520}
        set theOptions to the icon view options of container window
        set arrangement of theOptions to not arranged
        set icon size of theOptions to 128
        set text size of theOptions to 13
        set background picture of theOptions to file ".background:backdrop.png"
        set position of item "${appName}" of container window to {180, 190}
        set position of item "Applications" of container window to {480, 190}
        close
        open
        update without registering applications
        delay 2
        close
      end tell
    end tell`
  await execFileAsync('/usr/bin/osascript', ['-e', script], { timeout: 60000 })
}

/**
 * The .dmg FILE's own icon — what Downloads and the Desktop show before the
 * double-click. Embedded INSIDE the UDIF container with `hdiutil udifrez`
 * (the slot license agreements live in), as resource type `icns` id -16455,
 * which Finder reads as the file's custom icon. Being file bytes it survives
 * HTTP downloads, VirtioFS shares and every copy — unlike a resource-fork
 * icon (`NSWorkspace.setIcon`), which is an xattr and is stripped by all of
 * those (measured 2026-09-29: xattr -c + byte copy, icon stays).
 */
async function embedDmgIcon(dmg, icns) {
  const plist = join(OUT, 'dmg-icon-rez.plist')
  const data = await readFile(icns)
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>icns</key><array><dict>
<key>Attributes</key><string>0x0000</string>
<key>Data</key><data>${data.toString('base64')}</data>
<key>ID</key><string>-16455</string>
<key>Name</key><string>${NAME}</string>
</dict></array></dict></plist>
`
  await writeFile(plist, xml)
  await execFileAsync('/usr/bin/hdiutil', ['udifrez', '-xml', plist, '', '-quiet', dmg], { maxBuffer: 16 * 1024 * 1024 })
  await rm(plist, { force: true })
}

/** SetFile is Xcode's (CLT lacks it); without it the icon file is still there, just not shown on the volume. */
async function setVolumeIconFlag(mount) {
  const setFile = await execFileAsync('/usr/bin/xcrun', ['--find', 'SetFile']).then(r => r.stdout.trim()).catch(() => null)
  if (!setFile) { log('SetFile not found (needs Xcode): the volume icon flag is not set'); return }
  await execFileAsync(setFile, ['-t', 'icns', '-c', 'MACS', join(mount, '.VolumeIcon.icns')])
  await execFileAsync(setFile, ['-a', 'C', mount])                       // custom icon on the volume root
  await execFileAsync(setFile, ['-a', 'V', join(mount, '.background')])  // invisible in older Finders too
}

async function main() {
  const stagePkg = await readJson(join(STAGE, 'package.json'))
  const nodeInfo = await readJson(join(NODE_DIR, 'current.json'))
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
  // main.swift's identityScript() loads this from Resources: without it the page keeps the stock whale and 'DSH'.
  await cp(dockApp.BRANDING_SCRIPT, join(resources, 'desktop-branding.js'))

  log('copying node')
  await mkdir(join(resources, 'node', 'bin'), { recursive: true })
  await cp(join(NODE_DIR, nodeInfo.dir, 'bin', 'node'), join(resources, 'node', 'bin', 'node'))
  await cp(join(NODE_DIR, nodeInfo.dir, 'LICENSE'), join(resources, 'node', 'LICENSE'))
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
    // `dependencies` lists the bundled plugins by version (never installed by pnpm: they resolve
    // from the installation anchor) so the Plugins page shows them and their cards.
    name: 'dsh-profile-app', private: true, dependencies: Object.fromEntries(stagePkg.dshBundle.plugins.map(p => [p.name, p.version])), dsh: { profile: { bundles }, app: { templateBundles: bundles } },
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
      dshHome: DSH_HOME,
    },
    ...(UPDATES ? { update: { repo: REPO_SLUG, intervalHours: 6, feed: opt('--update-feed') ?? null } } : {}),
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
    // Window dressing: a rendered backdrop (whale watermark, arrow, caption) in
    // a hidden folder, and Finder's view settings — icon size, the two icon
    // positions, no sidebar/toolbar, 660×400 — written into the volume's .DS_Store
    // by Finder itself while a read-write image is mounted. Then the image is
    // converted to the compressed read-only DMG. The coordinates match
    // Tools/make-dmg-background.swift.
    await mkdir(join(staging, '.background'), { recursive: true })
    await execFileAsync(await swiftTool('make-dmg-background'), [join(REPO, 'plugins', 'dsh-tailscale-remote', 'dock-app', 'icon.svg'), join(staging, '.background', 'backdrop.png'), '--glyph-color', GLYPH, '--name', NAME])
    // The disk-image icon (a drive slab wearing the app tile): the volume's icon and,
    // stamped as a Finder custom icon, the .dmg file's own — what Downloads shows.
    const dmgIcon = join(OUT, 'dmg-icon.icns')
    await execFileAsync(await swiftTool('make-dmg-icon'), ['render', icns, dmgIcon])
    log('creating the DMG')
    const rw = join(OUT, 'dmg-rw.dmg')
    await rm(rw, { force: true })
    // Volume name carries the version so a mounted image is never confused with the installed app.
    const volume = `${NAME} ${ver.short}`
    await execFileAsync('/usr/bin/hdiutil', ['create', '-volname', volume, '-srcfolder', staging, '-ov', '-format', 'UDRW', '-fs', 'APFS', rw], { maxBuffer: 16 * 1024 * 1024 })
    const attach = await execFileAsync('/usr/bin/hdiutil', ['attach', '-readwrite', '-noverify', '-nobrowse', rw])
    const mount = attach.stdout.split('\n').map(l => l.split('\t').pop()?.trim()).find(p => p?.startsWith('/Volumes/'))
    if (!mount) throw new Error(`hdiutil attach: no mount point in\n${attach.stdout}`)
    try {
      await layoutDmgWindow(mount, `${NAME}.app`)
      // The mounted volume (Desktop, sidebar, and the .dmg file once Finder has seen
      // it) wears the app icon. Copied onto the mounted image AFTER the Finder layout:
      // both `hdiutil create -srcfolder` and Finder's view-settings pass drop a
      // root-level .VolumeIcon.icns (measured 2026-09-29, in that order).
      await cp(dmgIcon, join(mount, '.VolumeIcon.icns'))
      // Finder ignores the icon while the file carries com.apple.provenance (added by
      // the copy) — strip xattrs, then the classic type/creator on the file and the
      // custom-icon flag on the root. Measured 2026-09-29: with provenance → generic
      // drive; without → the whale.
      await execFileAsync('/usr/bin/xattr', ['-c', join(mount, '.VolumeIcon.icns')])
      await setVolumeIconFlag(mount)
      if (!(await stat(join(mount, '.VolumeIcon.icns')).catch(() => null))) throw new Error('.VolumeIcon.icns did not survive on the mounted image')
    } finally {
      await execFileAsync('/usr/bin/hdiutil', ['detach', mount, '-quiet']).catch(async () => { await new Promise(r => setTimeout(r, 2000)); await execFileAsync('/usr/bin/hdiutil', ['detach', mount, '-force', '-quiet']) })
    }
    await execFileAsync('/usr/bin/hdiutil', ['convert', rw, '-format', 'ULMO', '-o', dmg, '-ov'], { maxBuffer: 16 * 1024 * 1024 })
    await rm(rw, { force: true })
    await embedDmgIcon(dmg, dmgIcon)
    await rm(staging, { recursive: true, force: true })
    const dmgSize = (await stat(dmg)).size
    log(`dmg ready: ${dmg} (${(dmgSize / 1024 / 1024).toFixed(0)} MB)`)
    process.stdout.write(dmg + '\n')
  } else {
    process.stdout.write(app + '\n')
  }
}

main().catch(err => { console.error(err); process.exit(1) })

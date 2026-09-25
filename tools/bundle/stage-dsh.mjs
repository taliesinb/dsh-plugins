#!/usr/bin/env node
/**
 * Stage a self-contained production tree of the DSH fork for the bundled app.
 *
 * Why not `pnpm deploy`: the CLI package (`@deepseek-ai/dsh`) reaches half the
 * workspace through `workspace:^` PEER dependencies (e.g. dsh-app-boot →
 * cordis-plugin-group) that only resolve from the monorepo root's
 * devDependencies; `deploy --prod` silently drops them and the built `bin.js`
 * dies with ERR_MODULE_NOT_FOUND. `pnpm deploy --legacy` rejects the same specs
 * outright ("@deepseek-ai/cordis-plugin-group@^ isn't supported by any
 * resolver"). Upstream's Electron shell solves it the same way this does:
 * pack every first-party package to a tarball, then install a staging project
 * whose `pnpm.overrides` pin every first-party name to its tarball, so the
 * whole closure — peers included — comes from the checkout, and third-party
 * packages come from the registry (or the local store).
 *
 *   node tools/bundle/stage-dsh.mjs [--checkout DIR] [--out DIR] [--skip-pack] [--no-plugins]
 *                                   [--plugin DIR]... [--node-linker hoisted|isolated]
 *   (plugins default to tools/bundle/plugins.txt)
 *
 * Output: <out>/tarballs/*.tgz, <out>/package.json, <out>/pnpm-workspace.yaml,
 * <out>/node_modules (production closure, hoisted by default so the app-boot
 * two-anchor resolution finds bundled plugins beside `@deepseek-ai/dsh`).
 *
 * Requires: a BUILT checkout (`pnpm run build` — pack ships `lib/`), pnpm on
 * PATH. Never pack into a path under a symlink (/tmp on macOS): pnpm resolves
 * the checkout's `patches/` relative to the target and loses the symlink.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : args[i + 1]
}
const CHECKOUT = resolve(opt('--checkout', join(REPO, 'deepseek-harness')))
const OUT = resolve(opt('--out', join(REPO, 'dist', 'bundle', 'stage')))
const SKIP_PACK = args.includes('--skip-pack')
const NODE_LINKER = opt('--node-linker', 'hoisted')
/** `--plugin DIR` (repeatable), else every non-comment line of tools/bundle/plugins.txt as plugins/<name>. */
const PLUGIN_DIRS = args.includes('--plugin')
  ? args.flatMap((a, i) => (a === '--plugin' ? [resolve(args[i + 1])] : []))
  : args.includes('--no-plugins') ? [] : readFileSync(join(HERE, 'plugins.txt'), 'utf8').split('\n')
    .map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => join(REPO, 'plugins', l))
const TARBALLS = join(OUT, 'tarballs')

/** Bundles the staged installation must carry directly (everything else arrives as their closure). */
const ROOT_PACKAGES = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless']
/** Workspace packages never shipped (Electron shell, docs site, benchmarks, Python closure). */
const EXCLUDE = /^(?:@deepseek-ai\/dsh-desktop(?:-host)?|@deepseek-ai\/website|@deepseek-ai\/dsh-benchmarks|dsh-python-runtime-closure|@deepseek-ai\/node-addon-system-workspace|@deepseek-ai\/dsh-root)$/

/** Native platform packages of OTHER platforms cannot be packed here (their prepack verifies a binary this host never built). */
const HOST_PLATFORM = `${process.platform}-${process.arch}`
const OTHER_PLATFORM = /-(?:darwin|linux|win32)-(?:arm64|x64|ia32)$/

const PNPM_ENV = { ...process.env, npm_config_manage_package_manager_versions: 'false', CI: 'true' }

function log(msg) { process.stderr.write(`[stage-dsh] ${msg}\n`) }

async function pnpm(cwd, argv, { capture = false } = {}) {
  if (capture) {
    const { stdout } = await execFileAsync('pnpm', argv, { cwd, env: PNPM_ENV, maxBuffer: 64 * 1024 * 1024 })
    return stdout
  }
  await new Promise((res, rej) => {
    const child = spawn('pnpm', argv, { cwd, env: PNPM_ENV, stdio: 'inherit' })
    child.on('close', code => (code === 0 ? res() : rej(new Error(`pnpm ${argv.join(' ')} exited ${code}`))))
  })
}

/** @returns {Promise<{name:string,path:string,private?:boolean}[]>} */
async function workspacePackages() {
  const json = await pnpm(CHECKOUT, ['-r', 'ls', '--depth', '-1', '--json'], { capture: true })
  return JSON.parse(json)
}

/** `pnpm pack --json` output with lifecycle-script noise (prepack lines) stripped: the JSON object is the tail. */
function parsePackJson(out) {
  const start = out.lastIndexOf('\n{')
  return JSON.parse(start === -1 ? out : out.slice(start + 1))
}

async function packAll(pkgs) {
  rmSync(TARBALLS, { recursive: true, force: true })
  mkdirSync(TARBALLS, { recursive: true })
  const records = []
  const queue = [...pkgs]
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      const out = await pnpm(p.path, ['pack', '--pack-destination', TARBALLS, '--json'], { capture: true })
      const info = parsePackJson(out)
      records.push({ name: info.name, version: info.version, file: info.filename.split('/').pop() })
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker))
  records.sort((a, b) => a.name.localeCompare(b.name))
  return records
}

function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')) }

/**
 * A plugin with a `build` script needs its devDependencies (esbuild) and, for
 * a client plugin, a current `lib/client.js`: `pnpm install` when node_modules
 * is missing or older than package.json, `pnpm build` when the bundle is
 * missing or older than any source file. A `prepack` hook that builds would
 * otherwise fail here with ERR_MODULE_NOT_FOUND esbuild on a fresh checkout.
 */
async function ensurePluginBuilt(dir) {
  const pkg = readJson(join(dir, 'package.json'))
  if (!pkg.scripts?.build) return
  const mtime = p => { try { return statSync(p).mtimeMs } catch { return 0 } }
  const needsInstall = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0
    && mtime(join(dir, 'node_modules')) < mtime(join(dir, 'package.json'))
  if (needsInstall) { log(`installing ${pkg.name} devDependencies`); await pnpm(dir, ['install', '--silent', '--no-frozen-lockfile']) }
  const bundle = join(dir, 'lib', 'client.js')
  const newestSource = Math.max(...['src', 'index.js', 'build.mjs', 'package.json'].map(p => newestUnder(join(dir, p))))
  if (pkg.dsh?.client && mtime(bundle) < newestSource) { log(`building ${pkg.name}`); await pnpm(dir, ['build']) }
}

function newestUnder(path) {
  let st
  try { st = statSync(path) } catch { return 0 }
  if (!st.isDirectory()) return st.mtimeMs
  let newest = st.mtimeMs
  for (const entry of readdirSync(path)) newest = Math.max(newest, newestUnder(join(path, entry)))
  return newest
}

/** allowBuilds from the checkout, rekeyed so the `file:` spec form does not defeat the subprocess-local entry. */
function allowBuilds() {
  const text = readFileSync(join(CHECKOUT, 'pnpm-workspace.yaml'), 'utf8')
  const block = text.split(/^allowBuilds:\s*$/m)[1]?.split(/^\S/m)[0] ?? ''
  const map = {}
  for (const line of block.split('\n')) {
    const m = /^\s+(?:'([^']+)'|([^:'#\s]+)):\s*(true|false)\s*$/.exec(line)
    if (m) map[(m[1] ?? m[2]).replace(/@file:.*$/, '')] = m[3] === 'true'
  }
  return map
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  let records
  const recordsFile = join(OUT, 'tarballs.json')
  if (SKIP_PACK && existsSync(recordsFile)) {
    records = readJson(recordsFile)
    log(`reusing ${records.length} tarballs from ${recordsFile}`)
  } else {
    const pkgs = (await workspacePackages()).filter(p => !p.private && !EXCLUDE.test(p.name)
      && !(OTHER_PLATFORM.test(p.name) && !p.name.endsWith(`-${HOST_PLATFORM}`)))
    log(`packing ${pkgs.length} workspace packages from ${CHECKOUT}`)
    const t0 = Date.now()
    records = await packAll(pkgs)
    writeFileSync(recordsFile, JSON.stringify(records, null, 2) + '\n')
    log(`packed in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  }
  const byName = new Map(records.map(r => [r.name, r]))
  for (const root of ROOT_PACKAGES) if (!byName.has(root)) throw new Error(`root package ${root} was not packed`)

  const dependencies = {}
  for (const root of ROOT_PACKAGES) dependencies[root] = `file:tarballs/${byName.get(root).file}`
  const overrides = {}
  for (const r of records) overrides[r.name] = `file:tarballs/${r.file}`

  // Out-of-tree plugins: packed too, so their `link:` devDependencies into the
  // checkout never enter the tree and their runtime deps come from the registry.
  const plugins = []
  for (const dir of PLUGIN_DIRS) {
    await ensurePluginBuilt(dir)
    const out = await pnpm(dir, ['pack', '--pack-destination', TARBALLS, '--json'], { capture: true })
    const info = parsePackJson(out)
    const file = info.filename.split('/').pop()
    dependencies[info.name] = `file:tarballs/${file}`
    plugins.push({ name: info.name, version: info.version, file })
    log(`packed plugin ${info.name}@${info.version}`)
  }

  const fork = readJson(join(CHECKOUT, 'package.json'))
  writeFileSync(join(OUT, 'package.json'), JSON.stringify({
    name: 'dsh-app-runtime',
    private: true,
    version: fork.version,
    description: 'Self-contained DSH installation staged for the bundled macOS app (generated by tools/bundle/stage-dsh.mjs)',
    dependencies,
    dshBundle: { fork: fork.version, plugins },
  }, null, 2) + '\n')

  // Plugin dependencies with install scripts the bundle needs to run:
  // @vscode/ripgrep downloads the rg binary (fs-tools' `search`).
  // A tarball-resolved package is keyed `name@file:tarballs/x.tgz` in pnpm's
  // build check, so every allowed first-party name gets that form as well.
  const builds = { ...allowBuilds(), '@vscode/ripgrep': true }
  for (const [name, allowed] of Object.entries(builds)) {
    if (allowed && byName.has(name)) builds[`${name}@file:tarballs/${byName.get(name).file}`] = true
  }
  // pnpm 12 reads overrides from pnpm-workspace.yaml ONLY; a `pnpm.overrides`
  // block in package.json is ignored with a warning — and then every
  // first-party `^0.1.6-alpha.2` spec silently resolves to UPSTREAM's npm
  // release instead of the fork's tarball (measured: 125 tarball resolutions,
  // the rest from registry.npmjs.org). verifyFirstParty() guards against it.
  const yaml = [
    `nodeLinker: ${NODE_LINKER}`,
    'overrides:',
    ...Object.entries(overrides).map(([k, v]) => `  '${k}': '${v}'`),
    'allowBuilds:',
    ...Object.entries(builds).map(([k, v]) => `  '${k}': ${v}`),
    '',
  ].join('\n')
  writeFileSync(join(OUT, 'pnpm-workspace.yaml'), yaml)
  writeFileSync(join(OUT, '.npmrc'), 'manage-package-manager-versions=false\n')

  log(`installing production closure (${NODE_LINKER}) into ${OUT}`)
  rmSync(join(OUT, 'node_modules'), { recursive: true, force: true })
  await pnpm(OUT, ['install', '--prod', '--no-frozen-lockfile'])
  verifyFirstParty(new Set([...records.map(r => r.name), ...plugins.map(p => p.name)]))
  anchorPlugins(plugins.map(p => p.name))
  log('done')
}

/**
 * Make the bundled plugins part of the INSTALLATION graph. app-boot computes
 * the package-resolution generation by BFS over the dependency graph rooted at
 * the launcher's own manifest (`@deepseek-ai/dsh/package.json`, see
 * profile.ts resolveModuleFallbackEntries); a package merely present in
 * node_modules is invisible to it, and every plugin row then reports "failed
 * to import". Declaring the plugins as dependencies of the dsh package is what
 * lets an empty profile (`dependencies: {}`) list them as bundles. The file is
 * unlinked first: with the hoisted linker it is a hard link into pnpm's store.
 */
function anchorPlugins(names) {
  const manifestPath = join(OUT, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const manifest = readJson(manifestPath)
  manifest.dependencies = { ...manifest.dependencies }
  for (const name of names) manifest.dependencies[name] = '*'
  manifest.dshBundle = { anchoredPlugins: names }
  rmSync(manifestPath)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  log(`anchored ${names.length} plugins in ${manifestPath}`)
}

/** Every first-party package in the lockfile must resolve to a staged tarball, never to the registry. */
function verifyFirstParty(names) {
  const lock = readFileSync(join(OUT, 'pnpm-lock.yaml'), 'utf8')
  const offenders = []
  for (const m of lock.matchAll(/^  '?((?:@[^/'@]+\/)?[^@'\s]+)@([^'(\s]+)(?:\([^']*\))?'?:\n    resolution: \{([^}]*)\}/gm)) {
    const [, name, , resolution] = m
    if (names.has(name) && !/tarball: file:tarballs\//.test(resolution)) offenders.push(`${name}: ${resolution}`)
  }
  if (offenders.length) throw new Error(`first-party packages resolved outside the staged tarballs:\n  ${offenders.join('\n  ')}`)
  log(`verified: all ${names.size} first-party packages resolve to tarballs`)
}

main().catch(err => { console.error(err); process.exit(1) })

#!/usr/bin/env node
/**
 * Cut a DSH Canary release: build number → DMG → sha256 → GitHub Release.
 *
 *   node tools/bundle/release.mjs [--repo owner/name] [--notes "text"] [--draft] [--dry-run]
 *                                 [--skip-pack] [--no-build] [--build N]
 *
 * Build number: `YYYYMMDDnn` in UTC, nn = 01 + the number of `canary-YYYYMMDD*`
 * tags already on the repo (so two releases a day give …01 and …02; it is what
 * Updater.swift compares as an integer against CFBundleVersion). The tag is
 * `canary-<build>`, the release is NOT a prerelease and IS marked latest, so
 * `GET /repos/<repo>/releases/latest` (the app's feed) returns it.
 *
 * Assets: `DSH-Canary-<version>-<build>.dmg` and `<same>.sha256` (hex digest +
 * two spaces + filename, `shasum -a 256` format; Updater reads the first word).
 * Notes: --notes, else the subject lines since the previous canary tag.
 *
 * Needs `gh` logged in with push rights, a built fork checkout, the network.
 * --dry-run builds everything and prints the `gh release create` command
 * instead of running it. hdiutil cannot run inside the DSH file sandbox.
 */
import { execFile, spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_DIR = resolve(HERE, '..', '..')
const args = process.argv.slice(2)
const opt = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1] }
const REPO = opt('--repo', 'taliesinb/dsh-plugins')
const DRY = args.includes('--dry-run')
const DRAFT = args.includes('--draft')
const OUT = join(REPO_DIR, 'dist', 'bundle')

function log(msg) { process.stderr.write(`[release] ${msg}\n`) }
async function sh(cmd, argv, opts = {}) {
  const { stdout } = await execFileAsync(cmd, argv, { cwd: REPO_DIR, maxBuffer: 64 * 1024 * 1024, ...opts })
  return stdout.trim()
}
async function run(cmd, argv) {
  await new Promise((res, rej) => {
    const child = spawn(cmd, argv, { cwd: REPO_DIR, stdio: 'inherit', env: { ...process.env, npm_config_manage_package_manager_versions: 'false' } })
    child.on('close', code => (code === 0 ? res() : rej(new Error(`${cmd} ${argv.join(' ')} exited ${code}`))))
  })
}
async function existingTags() {
  await sh('git', ['fetch', '--tags', '--quiet']).catch(() => log('git fetch --tags failed; using local tags'))
  return (await sh('git', ['tag', '--list', 'canary-*'])).split('\n').filter(Boolean)
}

async function main() {
  const tags = await existingTags()
  let build = Number(opt('--build', '0'))
  if (!build) {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const today = tags.filter(t => t.startsWith(`canary-${day}`)).length
    build = Number(`${day}${String(today + 1).padStart(2, '0')}`)
  }
  const tag = `canary-${build}`
  if (tags.includes(tag)) throw new Error(`tag ${tag} already exists`)
  const previous = tags.map(t => Number(t.slice('canary-'.length))).filter(n => n < build).sort((a, b) => b - a)[0]
  log(`build ${build} (tag ${tag}${previous ? `, previous canary-${previous}` : ', first release'})`)

  if (!args.includes('--no-build')) {
    await run('node', [join(HERE, 'fetch-node.mjs')])
    await run('node', [join(HERE, 'stage-dsh.mjs'), ...(args.includes('--skip-pack') ? ['--skip-pack'] : [])])
    await run('node', [join(HERE, 'build-app.mjs'), '--build', String(build), '--update-repo', REPO])
  }
  const manifest = JSON.parse(await readFile(join(OUT, 'DSH Canary.app', 'Contents', 'Resources', 'dsh-app-release.json'), 'utf8'))
  if (manifest.build !== build) throw new Error(`built app carries build ${manifest.build}, expected ${build} (pass --no-build only after building with --build ${build})`)
  const dmg = join(OUT, `DSH-Canary-${manifest.version}-${build}.dmg`)
  const digest = createHash('sha256').update(await readFile(dmg)).digest('hex')
  const shaFile = `${dmg}.sha256`
  await writeFile(shaFile, `${digest}  ${basename(dmg)}\n`)
  log(`dmg ${basename(dmg)} sha256 ${digest}`)

  let notes = opt('--notes')
  if (!notes) {
    const range = previous ? `canary-${previous}..HEAD` : 'HEAD~20..HEAD'
    const subjects = await sh('git', ['log', '--no-merges', '--format=- %s', range]).catch(() => '')
    notes = [
      `DSH Canary ${manifest.version} — build ${build}`,
      '',
      `dsh ${manifest.dsh} · node ${manifest.node} · ${manifest.plugins.length} plugins · ad-hoc signed (first launch: right-click → Open)`,
      '',
      subjects || '- (no commits since the previous release)',
    ].join('\n')
  }
  // The tag must point at the commit that was built, which `gh` only does with
  // --target; and that commit must already be on the remote (the run is on
  // whatever branch is checked out, not necessarily the default one).
  const head = await sh('git', ['rev-parse', 'HEAD'])
  const onRemote = await sh('git', ['branch', '-r', '--contains', head]).catch(() => '')
  if (!onRemote && !DRY) throw new Error(`HEAD ${head.slice(0, 7)} is not on any remote branch; git push first so the release tag can point at it`)
  const title = `DSH Canary ${manifest.version}`
  const ghArgs = ['release', 'create', tag, dmg, shaFile, '--repo', REPO, '--target', head, '--title', title, '--notes', notes, '--latest', ...(DRAFT ? ['--draft'] : [])]
  if (DRY) {
    log(`dry run — would execute:\n  gh ${ghArgs.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`)
    return
  }
  log(`publishing ${tag} to ${REPO}`)
  await run('gh', ghArgs)
  const url = await sh('gh', ['release', 'view', tag, '--repo', REPO, '--json', 'url', '--jq', '.url'])
  log(`released: ${url}`)
  process.stdout.write(url + '\n')
}

main().catch(err => { console.error(err.message ?? err); process.exit(1) })

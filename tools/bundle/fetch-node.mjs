#!/usr/bin/env node
/**
 * Download an official Node.js macOS build for the bundled app and verify it
 * against nodejs.org's SHASUMS256.txt.
 *
 *   node tools/bundle/fetch-node.mjs [--version v24.21.0] [--arch arm64|x64] [--out DIR]
 *
 * Output: <out>/node-<version>-darwin-<arch>/{bin/node,LICENSE,...} plus the
 * cached tarball beside it (re-runs are no-ops when the tarball verifies).
 * Default: the newest v24 LTS from https://nodejs.org/dist/index.json — the
 * fork's engines range is `^22.19.0 || >=24.0.0`; the LTS line keeps the
 * bundled runtime off the odd-numbered churn the dev machines run.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const args = process.argv.slice(2)
const opt = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1] }
const ARCH = opt('--arch', process.arch)
const OUT = resolve(opt('--out', join(REPO, 'dist', 'bundle', 'node')))
const DIST = 'https://nodejs.org/dist'

function log(msg) { process.stderr.write(`[fetch-node] ${msg}\n`) }

async function latestLts(major) {
  const index = await (await fetch(`${DIST}/index.json`)).json()
  const hit = index.find(v => v.lts && v.version.startsWith(`v${major}.`))
  if (!hit) throw new Error(`no LTS release for Node ${major}`)
  return hit.version
}

async function main() {
  const version = opt('--version', await latestLts(24))
  const name = `node-${version}-darwin-${ARCH}`
  const tarball = join(OUT, `${name}.tar.gz`)
  const dir = join(OUT, name)
  mkdirSync(OUT, { recursive: true })

  const sums = await (await fetch(`${DIST}/${version}/SHASUMS256.txt`)).text()
  const expected = sums.split('\n').find(l => l.endsWith(`  ${name}.tar.gz`))?.split(/\s+/)[0]
  if (!expected) throw new Error(`${name}.tar.gz not in SHASUMS256.txt`)

  const verify = () => existsSync(tarball) && createHash('sha256').update(readFileSync(tarball)).digest('hex') === expected
  if (!verify()) {
    log(`downloading ${DIST}/${version}/${name}.tar.gz`)
    const res = await fetch(`${DIST}/${version}/${name}.tar.gz`)
    if (!res.ok) throw new Error(`download failed: ${res.status}`)
    writeFileSync(tarball, Buffer.from(await res.arrayBuffer()))
    if (!verify()) throw new Error('sha256 mismatch after download')
  }
  log(`sha256 ok: ${expected}`)

  if (!existsSync(join(dir, 'bin', 'node'))) {
    rmSync(dir, { recursive: true, force: true })
    execFileSync('tar', ['-xzf', tarball, '-C', OUT])
  }
  // The npm/corepack trees are never used by the app (pnpm is not shipped either):
  // drop them so the bundle carries the bare runtime (~120 MB → ~95 MB).
  rmSync(join(dir, 'lib', 'node_modules'), { recursive: true, force: true })
  rmSync(join(dir, 'bin', 'npm'), { force: true })
  rmSync(join(dir, 'bin', 'npx'), { force: true })
  rmSync(join(dir, 'bin', 'corepack'), { force: true })
  rmSync(join(dir, 'include'), { recursive: true, force: true })
  rmSync(join(dir, 'share'), { recursive: true, force: true })
  const reported = execFileSync(join(dir, 'bin', 'node'), ['-v']).toString().trim()
  if (reported !== version) throw new Error(`extracted node reports ${reported}, expected ${version}`)
  writeFileSync(join(OUT, 'current.json'), JSON.stringify({ version, arch: ARCH, dir: name }, null, 2) + '\n')
  log(`ready: ${dir} (${reported})`)
  process.stdout.write(dir + '\n')
}

main().catch(err => { console.error(err); process.exit(1) })

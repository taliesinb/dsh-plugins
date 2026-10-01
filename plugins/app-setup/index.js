/**
 * tali-app-setup — host half.
 *
 * The bundled macOS app (DSH Canary) installs nothing outside itself, so the
 * things it can only *use* — Tailscale for remote access, Safari Technology
 * Preview / Chrome for browser automation, afm for the on-device Apple model,
 * Dash and Mathematica for their plugins — are detected here and offered to
 * the user by the browser half as a checklist dialog on the first launch (and
 * later from its Plugins-panel card). Nothing is downloaded or installed
 * without a click; paid apps (Dash, Mathematica) are never offered, only
 * reported when present.
 *
 * Armed only inside the bundled app (`DSH_APP_BUNDLE` set by the wrapper) —
 * elsewhere the plugin registers nothing, so the row is harmless in a
 * checkout-run profile.
 *
 * Route `API_PATH`:
 *   GET  ?action=state             { firstRun, items: Item[], remote: {...}, port }
 *   POST ?action=dismiss           first-run seen (state.json under $DSH_HOME/app-setup/)
 *   POST ?action=open&item=<id>    `open` the item's download page (free apps only)
 *   POST ?action=launch&item=<id>  `open -a` an installed app (Tailscale after install: log in)
 *   POST ?action=install&item=<id> best-effort install (install.mjs); progress in `state.jobs`
 *   POST ?action=refresh           re-detect
 *
 * Item = { id, label, kind: 'required'|'optional'|'paid', installed: bool,
 *          detail?: string, action?: 'open'|'launch'|null, url?: string }
 *
 * Tailnet access itself (proxy + `tailscale serve` route + the relay
 * LaunchAgent) stays with dsh-tailscale-remote's Settings section; this
 * dialog only gets Tailscale onto the machine and reports its state.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { INSTALLERS, firstLine, runInstaller } from './install.mjs'

const execFileAsync = promisify(execFile)

export const name = 'app-setup'
export const inject = ['connection']
export const API_PATH = '/api/app-setup'

const TS_BIN = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'

/** What is looked for, in the order the dialog lists it. */
const CATALOG = [
  { id: 'tailscale', label: 'Tailscale', kind: 'optional', apps: ['/Applications/Tailscale.app'], url: 'https://tailscale.com/download/mac' },
  { id: 'stp', label: 'Safari Technology Preview', kind: 'optional', apps: ['/Applications/Safari Technology Preview.app'], url: 'https://developer.apple.com/safari/technology-preview/' },
  { id: 'chrome', label: 'Google Chrome', kind: 'optional', apps: ['/Applications/Google Chrome.app', `${homedir()}/Applications/Google Chrome.app`], url: 'https://www.google.com/chrome/' },
  { id: 'afm', label: 'afm (Apple Foundation model server)', kind: 'optional', commands: ['afm'], url: 'https://github.com/scouzi1966/maclocal-api' },
  { id: 'dash', label: 'Dash', kind: 'paid', apps: ['/Applications/Dash.app', `${homedir()}/Applications/Dash.app`, '/Applications/Setapp/Dash.app'] },
  { id: 'mathematica', label: 'Mathematica / Wolfram', kind: 'paid', apps: ['/Applications/Mathematica.app', '/Applications/Wolfram.app'], commands: ['wolframscript'] },
]

function which(command) {
  for (const dir of String(process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, command))) return join(dir, command)
  }
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin']) if (existsSync(join(dir, command))) return join(dir, command)
  return undefined
}

async function tailscaleDetail() {
  if (!existsSync(TS_BIN)) return undefined
  try {
    const { stdout } = await execFileAsync(TS_BIN, ['status', '--json'], { timeout: 4000 })
    const json = JSON.parse(stdout)
    const state = json.BackendState
    if (state === 'Running') {
      const dns = String(json.Self?.DNSName ?? '').replace(/\.$/, '')
      const login = json.User?.[json.Self?.UserID]?.LoginName
      return { detail: [dns, login].filter(Boolean).join(' · ') || 'connected', connected: true }
    }
    if (state === 'NeedsLogin') return { detail: 'installed, not logged in', connected: false }
    return { detail: `installed, ${String(state).toLowerCase()}`, connected: false }
  } catch {
    return { detail: 'installed, not running', connected: false }
  }
}

async function detect() {
  const items = []
  for (const entry of CATALOG) {
    const app = (entry.apps ?? []).find(p => existsSync(p))
    const command = (entry.commands ?? []).map(which).find(Boolean)
    const installed = app !== undefined || command !== undefined
    const item = { id: entry.id, label: entry.label, kind: entry.kind, installed, detail: undefined, action: null, url: entry.url }
    if (entry.id === 'tailscale' && installed) {
      const ts = await tailscaleDetail()
      item.detail = ts?.detail
      if (ts && !ts.connected) item.action = 'launch'
    }
    if (!installed && entry.kind !== 'paid' && entry.url) item.action = INSTALLERS[entry.id] ? 'install' : 'open'
    items.push(item)
  }
  return items
}

export function apply(ctx) {
  if (!process.env.DSH_APP_BUNDLE) return
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const stateFile = join(home, 'app-setup', 'state.json')

  async function readState() {
    try { return JSON.parse(await readFile(stateFile, 'utf8')) } catch { return {} }
  }
  async function writeState(patch) {
    await mkdir(join(home, 'app-setup'), { recursive: true })
    await writeFile(stateFile, JSON.stringify({ ...(await readState()), ...patch }, null, 2) + '\n')
  }

  /** Running / finished install jobs by item id: { step, fraction, error?, done? } */
  const jobs = new Map()
  function startInstall(id) {
    if (jobs.get(id) && !jobs.get(id).done) return
    const job = { step: 'download', fraction: 0, startedAt: Date.now() }
    jobs.set(id, job)
    runInstaller(id, {
      home,
      report: (step, fraction) => { job.step = step; job.fraction = fraction },
    }).then(result => {
      job.done = true; job.step = 'done'; job.fraction = 1; job.result = result
      setTimeout(() => { if (jobs.get(id) === job) jobs.delete(id) }, 60_000).unref()
    }).catch(error => {
      const full = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`app-setup: install ${id} failed: ${full}`)
      job.done = true; job.step = 'failed'; job.error = firstLine(full)
      setTimeout(() => { if (jobs.get(id) === job) jobs.delete(id) }, 60_000).unref()
    })
  }

  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

  ctx.on('webserver/index-inject', table => {
    table.push({ kind: 'global', name: '__DSH_APP_SETUP__', value: { bundle: process.env.DSH_APP_BUNDLE, version: process.env.DSH_APP_VERSION ?? '' } })
  })

  ctx.effect(() => {
    const dispose = ctx.connection.fetch.register({
      path: API_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const params = new URL(request.url).searchParams
        const action = params.get('action') ?? 'state'
        try {
          if (action === 'state' || action === 'refresh') {
            const state = await readState()
            return json({ firstRun: !state.dismissed, items: await detect(), version: process.env.DSH_APP_VERSION ?? '', jobs: Object.fromEntries(jobs) })
          }
          if (request.method !== 'POST') return json({ error: 'POST required' }, 405)
          if (action === 'dismiss') { await writeState({ dismissed: new Date().toISOString() }); return json({ ok: true }) }
          const entry = CATALOG.find(e => e.id === params.get('item'))
          if (!entry) return json({ error: 'unknown item' }, 404)
          if (action === 'open') {
            if (entry.kind === 'paid' || !entry.url) return json({ error: 'not offered' }, 403)
            await execFileAsync('/usr/bin/open', [entry.url])
            return json({ ok: true })
          }
          if (action === 'install') {
            if (!INSTALLERS[entry.id]) return json({ error: 'no installer' }, 404)
            startInstall(entry.id)
            return json({ ok: true })
          }
          if (action === 'launch') {
            const app = (entry.apps ?? []).find(p => existsSync(p))
            if (!app) return json({ error: 'not installed' }, 404)
            await execFileAsync('/usr/bin/open', ['-a', app])
            return json({ ok: true })
          }
          return json({ error: 'unknown action' }, 400)
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 500)
        }
      },
    })
    return () => { void dispose() }
  }, 'app-setup: route')
}

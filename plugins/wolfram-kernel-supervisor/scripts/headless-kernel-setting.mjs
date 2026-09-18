/**
 * Headless check of the kernel-location wiring in index.js without DSH:
 * a fake Cordis context with a fake `settings` provider. Verifies that
 *   - the namespace is registered with the schema + composition base,
 *   - auto-detection fills an empty setting (or leaves it empty when nothing is found),
 *   - GET /api/wolfram/kernel reports the resolved kernel; POST ?action=detect re-fills,
 *   - a setting that names no kernel makes every spawn fail with the configure-me message,
 *   - correcting the setting (watch) makes the launch spec usable again.
 * Run: node scripts/headless-kernel-setting.mjs   (exit 0 = pass)
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, KERNEL_PATH, SETTINGS_NS, apply } from '../index.js'
import { detectKernel } from '../kernel-locator.mjs'

const found = detectKernel().found
const cacheDir = mkdtempSync(join(tmpdir(), 'wks-headless-'))
const routes = new Map()
const logs = []

/** Minimal settings provider: one namespace, user layer in memory. */
function fakeSettings() {
  const namespaces = new Map()
  return {
    register(ns, schema, options = {}) {
      const entry = { schema, base: options.base ?? {}, user: {}, watchers: new Set() }
      namespaces.set(ns, entry)
      const resolve = () => schema({ ...entry.base, ...entry.user })
      return {
        get: resolve,
        watch(cb) { entry.watchers.add(cb); return () => entry.watchers.delete(cb) },
        async update(patch) {
          const prev = resolve()
          entry.user = { ...entry.user, ...patch }
          const next = resolve()
          for (const cb of entry.watchers) await cb(next, prev)
        },
        async replace(section) { entry.user = { ...section }; for (const cb of entry.watchers) await cb(resolve(), undefined) },
      }
    },
    userLayer: ns => namespaces.get(ns)?.user,
  }
}

function fakeCtx(settings) {
  const ctx = {
    logger: { info: m => logs.push(['info', m]), warn: m => logs.push(['warn', m]), error: m => logs.push(['error', m]) },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    inject(deps, cb) { if (deps.every(d => d in ctx)) cb(ctx); return ctx },
    on() { return () => {} },
    get(name) { return name === 'settings' ? settings : undefined },
    agents: { list: () => [] },
    tools: {},
    commands: { register: () => () => {} },
    connection: { fetch: { register: (route) => { routes.set(route.path, route) } } },
    settings,
  }
  return ctx
}

async function call(method, path, action) {
  const route = routes.get(path)
  const url = `http://dsh.local${path}${action ? `?action=${action}` : ''}`
  const response = await route.fetch(new Request(url, { method }))
  return { status: response.status, body: await response.json() }
}

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); console.error(logs.map(l => l.join(': ')).join('\n')); process.exit(1) } else console.log('ok  ', msg) }

// ---- scenario 1: empty setting, detection fills it in (or leaves it empty).
{
  const settings = fakeSettings()
  const ctx = fakeCtx(settings)
  apply(ctx, Config({ showDirectory: cacheDir, configureWolframscript: false, traceFile: '' }))
  await new Promise(r => setTimeout(r, 50))
  assert(routes.has(KERNEL_PATH), `route ${KERNEL_PATH} registered`)
  const { status, body } = await call('GET', KERNEL_PATH)
  assert(status === 200, 'GET status 200')
  if (found) {
    assert(body.kernel?.kernelPath === found.kernelPath, `resolved ${found.kernelPath}`)
    assert(body.source === 'detected', 'source = detected')
    assert(settings.userLayer(SETTINGS_NS)?.kernelPath === found.kernelPath, 'detected path persisted into the setting')
  } else {
    assert(body.kernel === undefined && typeof body.message === 'string' && /Settings ▸ Plugins/.test(body.message), 'nothing found → configure-me message')
    assert(settings.userLayer(SETTINGS_NS)?.kernelPath === undefined, 'setting left empty')
  }
  assert(body.settingsAvailable === true, 'settingsAvailable')
}

// ---- scenario 2: a setting naming no kernel refuses spawns; correcting it recovers.
{
  routes.clear()
  const settings = fakeSettings()
  const ctx = fakeCtx(settings)
  apply(ctx, Config({ showDirectory: cacheDir, configureWolframscript: false }))
  await new Promise(r => setTimeout(r, 50))
  // Write a bad value into the user layer (what a GUI save does), then re-resolve through the route.
  settings.userLayer(SETTINGS_NS).kernelPath = '/nowhere/Mathematica.app'
  const bad = await call('POST', KERNEL_PATH, 'refresh')
  assert(bad.body.kernel === undefined && /not a Wolfram kernel/.test(bad.body.error ?? ''), 'bad setting → error names the path')
  assert(/Settings ▸ Plugins ▸ Plugin configuration/.test(bad.body.message ?? ''), 'message tells the user where the setting is')
  // Correct it and check detect refills.
  const detected = await call('POST', KERNEL_PATH, 'detect')
  if (found) {
    assert(detected.body.kernel?.kernelPath === found.kernelPath, 'POST ?action=detect refilled the setting')
    assert(settings.userLayer(SETTINGS_NS)?.kernelPath === found.kernelPath, 'refilled value persisted')
  } else {
    assert(detected.body.kernel === undefined, 'detect found nothing (no Wolfram here)')
  }
  const unknown = await call('POST', KERNEL_PATH, 'bogus')
  assert(unknown.status === 400, 'unknown action → 400')
}

// ---- scenario 3: no settings provider at all → config + detection, nothing persisted.
{
  routes.clear()
  const ctx = fakeCtx(undefined)
  delete ctx.settings
  apply(ctx, Config({ showDirectory: cacheDir, configureWolframscript: false, kernel: found ? found.root : '' }))
  await new Promise(r => setTimeout(r, 3200)) // the 3 s fallback
  const { body } = await call('GET', KERNEL_PATH)
  assert(body.settingsAvailable === false, 'no settings provider reported')
  if (found) assert(body.kernel?.kernelPath === found.kernelPath && body.source === 'config', 'config kernel (bundle form) resolved without settings')
}

rmSync(cacheDir, { recursive: true, force: true })
console.log('headless kernel-setting checks passed')
process.exit(0)

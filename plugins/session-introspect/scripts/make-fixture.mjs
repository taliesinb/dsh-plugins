#!/usr/bin/env node
// Build tests/fixtures/<name>.json from a CURRENT-generation session log:
// every event is kept, but long strings are clipped and the request/header
// tool catalog (thousands of schema tokens) is dropped, so a real 400 KB log
// becomes a ~100 KB fixture that still exercises turns, calls, results,
// errors, images, injections and titles.
//   node scripts/make-fixture.mjs <session.v3.jsonl.zstd> <name> [maxStringChars=160]
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const [, , path, name, maxArg] = process.argv
if (!path || !name) { console.error('usage: make-fixture.mjs <log.zstd> <name> [maxStringChars]'); process.exit(2) }
const MAX = Number(maxArg ?? 160)

const text = execFileSync('zstd', ['-dc', path], { maxBuffer: 1 << 30 }).toString('utf8')
const lines = text.split('\n').filter(Boolean).map(l => JSON.parse(l))
const header = lines.find(l => l.type === 'session')
const events = lines.filter(l => l.type !== 'session')

const clipDeep = (v, key) => {
  if (typeof v === 'string') return v.length > MAX ? `${v.slice(0, MAX)}…[${v.length - MAX} more]` : v
  if (Array.isArray(v)) return v.map(x => clipDeep(x, key))
  if (v && typeof v === 'object') {
    const o = {}
    for (const [k, x] of Object.entries(v)) {
      if (key === 'header' && k === 'tools') { o[k] = []; continue } // request/header tool catalog
      if (key === 'data' && k === 'stream') continue // assistant stream chunk replay
      if (key === 'data' && k === 'meta') { o[k] = { fixture: 'meta dropped' }; continue } // tool-private presentation payloads
      o[k] = clipDeep(x, k)
    }
    return o
  }
  return v
}
const fixture = { session: header, events: events.map(e => clipDeep(e, '')) }
const dir = fileURLToPath(new URL('../tests/fixtures/', import.meta.url))
mkdirSync(dir, { recursive: true })
const out = `${dir}${name}.json`
writeFileSync(out, JSON.stringify(fixture))
console.log(`${out}: ${events.length} events, ${Math.round(JSON.stringify(fixture).length / 1024)} KB`)

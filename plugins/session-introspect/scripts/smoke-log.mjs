#!/usr/bin/env node
// Dev aid: render one CURRENT-generation log (session.v3.jsonl.zstd) through
// the pure model/render code, without Cordis. Historical generations are NOT
// handled here (the plugin gets them migrated by ctx.sessionQuery at runtime).
//   node scripts/smoke-log.mjs <session.v3.jsonl.zstd> [outline|read|stats|grep <pattern>] [args-json]
import { execFileSync } from 'node:child_process'
import { buildModel, sessionSummary, turnRows } from '../model.mjs'
import { renderOutline, renderRead, renderRow, renderStats } from '../render.mjs'
import { toolStats } from '../stats.mjs'

export function loadLog(path) {
  const text = execFileSync('zstd', ['-dc', path], { maxBuffer: 1 << 30 }).toString('utf8')
  const lines = text.split('\n').filter(Boolean).map(l => JSON.parse(l))
  const header = lines.find(l => l.type === 'session')
  const events = lines.filter(l => l.type !== 'session')
  return { session: header, events }
}

const [, , path, what = 'outline', ...rest] = process.argv
if (!path) { console.error('usage: smoke-log.mjs <log.zstd> [outline|read|stats|grep]'); process.exit(2) }
const m = buildModel(loadLog(path))
if (what === 'outline') console.log(renderOutline({ session: sessionSummary(m), turns: turnRows(m) }))
else if (what === 'read') {
  const turn = rest[0] ? Number(rest[0]) : undefined
  const t = turn ? m.turns.find(x => x.turn === turn) : undefined
  const rows = m.rows.filter(r => !t || (r.seq >= t.seqFrom && r.seq <= t.seqTo)).filter(r => !['reasoning', 'inject', 'instructions'].includes(r.kind))
  console.log(renderRead({ session: sessionSummary(m), range: { seqFrom: rows[0]?.seq, seqTo: rows.at(-1)?.seq }, events: rows.map(r => ({ ...r, call: undefined })), maxResultChars: 200 }))
} else if (what === 'stats') console.log(renderStats(toolStats([m], { tools: rest.length ? rest : undefined })))
else if (what === 'rows') for (const r of m.rows.slice(0, Number(rest[0] ?? 40))) console.log(renderRow(r, { maxResultChars: 120 }))

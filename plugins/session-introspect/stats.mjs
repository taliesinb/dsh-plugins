/**
 * stats.mjs — the ergonomics lens: per-tool call/error/latency aggregates and
 * "what did the agent do right after an error" bigrams, over one or many
 * normalized session models (see model.mjs). Pure.
 */

import { matchesTool } from './model.mjs'

/**
 * Normalize an error message so one bug groups as one row: digit runs, hex
 * ids, absolute paths, quoted values and UUID-ish tokens collapse.
 * @param {string} text
 */
export function normalizeError(text) {
  let s = String(text ?? '').split('\n').find(line => line.trim() !== '') ?? ''
  s = s.replace(/\[exit code: \d+\]/g, '[exit code: N]')
  s = s.replace(/(^|[\s"'`(=:])(~|\/)[^\s"'`),]*/g, '$1<path>')
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
  s = s.replace(/\b(?:0x)?[0-9a-f]{12,}\b/gi, '<hex>')
  s = s.replace(/\d+(\.\d+)?/g, '#')
  s = s.replace(/"[^"]{0,80}"/g, '"…"')
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > 160 ? `${s.slice(0, 159)}…` : s
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[idx]
}

/**
 * Aggregate tool usage over models.
 * @param {ReturnType<import('./model.mjs').buildModel>[]} models
 * @param {{ tools?: readonly string[], topErrors?: number }} [opts]
 */
export function toolStats(models, opts = {}) {
  const topErrors = opts.topErrors ?? 5
  const perTool = new Map()
  const after = new Map() // `${tool}→${next}` → { tool, next, count, retrySame }
  let totalCalls = 0
  let totalErrors = 0
  let earliest = null
  let latest = null

  for (const m of models) {
    if (m.createdAt !== null) {
      earliest = earliest === null ? m.createdAt : Math.min(earliest, m.createdAt)
      latest = latest === null ? m.createdAt : Math.max(latest, m.createdAt)
    }
    const calls = m.calls
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i]
      if (!matchesTool(c.tool, opts.tools)) continue
      totalCalls += 1
      let row = perTool.get(c.tool)
      if (!row) {
        row = { tool: c.tool, calls: 0, errors: 0, unanswered: 0, latencies: [], errorGroups: new Map(), sessions: new Set() }
        perTool.set(c.tool, row)
      }
      row.calls += 1
      row.sessions.add(m.id)
      if (c.ms !== null) row.latencies.push(c.ms)
      if (c.ok === null) row.unanswered += 1
      if (c.ok === false) {
        row.errors += 1
        totalErrors += 1
        const key = normalizeError(c.reason ?? c.text) || (c.code ?? '(no message)')
        const g = row.errorGroups.get(key) ?? { message: key, count: 0, codes: new Set(), example: null }
        g.count += 1
        if (c.code) g.codes.add(c.code)
        if (g.example === null) g.example = { session: m.id, seq: c.seq }
        row.errorGroups.set(key, g)
        // What happened next (same session, next tool call in seq order)?
        const next = calls[i + 1]
        if (next) {
          const retrySame = next.tool === c.tool
          const identical = retrySame && next.args === c.args
          const k = `${c.tool}\u0000${next.tool}\u0000${identical ? 'same-args' : retrySame ? 'retry' : 'switch'}`
          const a = after.get(k) ?? { tool: c.tool, next: next.tool, relation: identical ? 'same-args' : retrySame ? 'retry' : 'switch', count: 0 }
          a.count += 1
          after.set(k, a)
        } else {
          const k = `${c.tool}\u0000\u0000end`
          const a = after.get(k) ?? { tool: c.tool, next: null, relation: 'end', count: 0 }
          a.count += 1
          after.set(k, a)
        }
      }
    }
  }

  const tools = [...perTool.values()].map(row => {
    const sorted = [...row.latencies].sort((a, b) => a - b)
    return {
      tool: row.tool,
      calls: row.calls,
      errors: row.errors,
      errorRate: row.calls === 0 ? 0 : row.errors / row.calls,
      unanswered: row.unanswered,
      sessions: row.sessions.size,
      p50Ms: percentile(sorted, 0.5),
      p90Ms: percentile(sorted, 0.9),
      maxMs: sorted.length ? sorted[sorted.length - 1] : null,
      topErrors: [...row.errorGroups.values()].sort((a, b) => b.count - a.count).slice(0, topErrors)
        .map(g => ({ count: g.count, message: g.message, codes: [...g.codes], example: g.example })),
    }
  }).sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool))

  return {
    scope: { sessions: models.length, calls: totalCalls, errors: totalErrors, from: earliest, to: latest, tools: opts.tools ?? [] },
    tools,
    afterError: [...after.values()].sort((a, b) => b.count - a.count),
  }
}

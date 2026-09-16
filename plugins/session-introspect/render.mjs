/**
 * render.mjs — the `text` renderings (model-facing, compact) of every tool's
 * canonical value, plus the shared `json` / `jsonl` renderers. Pure functions
 * of the canonical value: no fact exists only in prose.
 */

import { clip } from './model.mjs'

/** @param {number | null | undefined} ms */
export function fmtMs(ms) {
  if (ms === null || ms === undefined) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

/** @param {number | null | undefined} n */
export function fmtBytes(n) {
  if (n === null || n === undefined) return '?'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Local `MM-DD HH:MM` (the machine's zone; the model reasons about relative order, not absolute time). */
export function fmtTime(t) {
  if (typeof t !== 'number') return '?'
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** `HH:MM:SS` for timeline rows. */
function fmtClock(t) {
  if (typeof t !== 'number') return '??:??:??'
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** `1.2k` / `130k` token counts. */
export function fmtTokens(n) {
  if (n === null || n === undefined) return '—'
  if (n < 1000) return String(n)
  if (n < 100_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${Math.round(n / 1000)}k`
}

/** Short session id: `session-2b810855` (enough for a prefix lookup). */
export function shortId(id) {
  const m = /^(session-)?([0-9a-f]{8})/i.exec(String(id))
  return m ? `${m[1] ?? ''}${m[2]}` : String(id).slice(0, 16)
}

/** Fixed-width table: `rows` are string arrays; `align` per column ('l' | 'r'). */
export function table(header, rows, align = []) {
  const all = [header, ...rows]
  const widths = header.map((_, i) => Math.max(...all.map(r => String(r[i] ?? '').length)))
  const fmt = (r) => r.map((cell, i) => {
    const s = String(cell ?? '')
    const last = i === r.length - 1
    if (align[i] === 'r') return s.padStart(widths[i])
    return last ? s : s.padEnd(widths[i])
  }).join('  ').trimEnd()
  return all.map(fmt).join('\n')
}

function imagesText(images) {
  if (!images || images.length === 0) return ''
  return images.map(im => `<image ${im.w ?? '?'}×${im.h ?? '?'} ${im.type}${im.bytes !== null && im.bytes !== undefined ? ` ${fmtBytes(im.bytes)}` : ''}>`).join(' ')
}

// ------------------------------------------------------------------ find

export function renderFind(value) {
  const rows = value.sessions
  if (rows.length === 0) return `No sessions matched${value.query ? ` "${value.query}"` : ''}.${value.hint ? ` ${value.hint}` : ''}`
  const lines = [table(
    ['id', 'workspace/title', 'created', 'live', ''],
    rows.map(s => [
      shortId(s.id),
      `${s.depth ? '↳ ' : ''}${s.workspace}/${s.title ?? '(untitled)'}`,
      fmtTime(s.createdAt),
      s.live ? 'yes' : 'no',
      s.self ? '(this session)' : s.depth ? `subagent depth ${s.depth}` : '',
    ]),
    ['l', 'l', 'l', 'l', 'l'],
  )]
  lines.push(`${value.total} session${value.total === 1 ? '' : 's'}${value.truncated ? `; ${value.truncated} more not shown — narrow with query/workspace/since or raise limit` : ''}.`)
  if (value.hint) lines.push(value.hint)
  return lines.join('\n')
}

// --------------------------------------------------------------- outline

function sessionLine(s) {
  const bits = [shortId(s.id), `${s.workspace}/${s.title ?? '(untitled)'}`]
  if (s.cwd) bits.push(`cwd ${s.cwd}`)
  if (s.model) bits.push(s.model)
  bits.push(`${s.events} events`, `${s.turns} turns`, `${s.calls} calls${s.errors ? ` (${s.errors} ✗)` : ''}`)
  if (s.live) bits.push('LIVE')
  return bits.join(' · ')
}

function endedText(ended) {
  if (!ended) return ''
  let s = ended.kind
  if (ended.code) s += ` ${ended.code}`
  if (ended.message) s += ` "${clip(ended.message, 100)}"`
  return s
}

export function renderOutline(value) {
  const lines = [sessionLine(value.session)]
  for (const t of value.turns) {
    const calls = t.calls.map(c => `${c.tool} ${c.count}${c.errors ? ` (✗${c.errors})` : ''}`).join(' · ')
    const head = [
      `T${t.turn}`.padEnd(4),
      `seq ${t.seqFrom}–${t.seqTo}`.padEnd(16),
      fmtTime(t.startedAt),
      fmtMs(t.ms).padStart(5),
      `${t.steps} step${t.steps === 1 ? '' : 's'}`.padStart(8),
      `${t.totalCalls} call${t.totalCalls === 1 ? '' : 's'}`.padStart(9),
      calls ? `  ${calls}` : '',
    ].join(' ')
    const flags = []
    if (t.tokens && (t.tokens.output || t.tokens.contextEnd)) flags.push(`out ${fmtTokens(t.tokens.output)} · ctx ${fmtTokens(t.tokens.contextEnd)}`)
    if (t.retries) flags.push(`${t.retries} llm retr${t.retries === 1 ? 'y' : 'ies'}`)
    lines.push(`${head}${flags.length ? `  [${flags.join(', ')}]` : ''}  ended: ${endedText(t.ended)}`)
    if (t.prompt) lines.push(`      "${t.prompt}"`)
  }
  if (value.omitted) lines.push(`… ${value.omitted.count} more turns (T${value.omitted.from}–T${value.omitted.to}); narrow with turns.`)
  return lines.join('\n')
}

// ------------------------------------------------------------------ read

/**
 * One timeline row → one (or a few) lines. Shared by `read` and `grep`.
 * @param {any} r - canonical event row
 * @param {{ maxResultChars?: number, includeArgs?: boolean }} [opts]
 */
export function renderRow(r, opts = {}) {
  const max = opts.maxResultChars ?? 400
  const tag = `[${r.seq}]`.padEnd(7)
  const ts = (r.turn !== null && r.turn !== undefined) ? ` T${r.turn}${r.step !== null && r.step !== undefined ? ` S${r.step}` : ''}` : ''
  switch (r.kind) {
    case 'turn-start': return `${tag} ── T${r.turn} start ${fmtClock(r.time)} ──`
    case 'turn-end': return `${tag} ── T${r.turn} end ${endedText(r.ended)} (${fmtMs(r.ms)}) ──`
    case 'user': return `${tag} USER${ts} ${quote(r.text, max)}${r.images?.length ? ` ${imagesText(r.images)}` : ''}`
    case 'inject': return `${tag} INJECT ${r.plugin ?? ''}${ts} ${quote(r.text, Math.min(max, 200))}`
    case 'instructions': return `${tag} INSTRUCTIONS${ts} ${quote(r.text, Math.min(max, 120))}`
    case 'checkpoint': return `${tag} CHECKPOINT (compaction)${ts} ${quote(r.text, Math.min(max, 200))}`
    case 'assistant': return `${tag} ASSISTANT${ts} ${quote(r.text, max)}`
    case 'reasoning': return `${tag} REASONING${ts} ${quote(r.text, max)}`
    case 'call': return `${tag} CALL   ${r.tool}${ts}${opts.includeArgs === false ? '' : ` ${clip(r.args, max)}`}`
    case 'result': {
      const status = r.ok === false ? '✗' : '✓'
      const bits = [`${tag} RESULT ${status} ${fmtMs(r.ms)}`]
      if (r.tool && r.tool !== '?') bits.push(r.tool)
      if (r.code) bits.push(`code=${r.code}`)
      const body = r.text ? quote(r.text, max) : ''
      const imgs = imagesText(r.images)
      if (body) bits.push(body)
      if (imgs) bits.push(imgs)
      if (r.reason && r.reason !== r.text) bits.push(`reason=${clip(r.reason, 160)}`)
      return bits.join(' ')
    }
    case 'title': return `${tag} TITLE "${clip(r.text, 100)}"`
    case 'approval': return `${tag} APPROVAL ${clip(r.text, 200)}`
    case 'retry': return `${tag} LLM-RETRY ${clip(r.text, 200)}`
    case 'command': return `${tag} COMMAND ${clip(r.text, 200)}`
    case 'other': return `${tag} ${r.type} ${clip(r.text, Math.min(max, 200))}`
    default: return `${tag} ${r.kind}`
  }
}

function quote(text, max) {
  const s = clip(text, max)
  return s === '' ? '""' : `"${s}"`
}

export function renderRead(value) {
  const lines = [sessionLine(value.session)]
  const range = value.range
  lines.push(`range: seq ${range.seqFrom}–${range.seqTo}${range.turn !== undefined ? ` (turn ${range.turn})` : ''}${value.filters ? ` · ${value.filters}` : ''} · ${value.events.length} rows shown`)
  for (const r of value.events) lines.push(renderRow(r, { maxResultChars: value.maxResultChars }))
  if (value.omitted) lines.push(`… ${value.omitted.count} more rows (seq ${value.omitted.seqFrom}–${value.omitted.seqTo}) not shown; continue with seq_from: ${value.omitted.seqFrom}, narrow with tools/turn/errors_only, or use out_file.`)
  return lines.join('\n')
}

// ----------------------------------------------------------------- stats

export function renderStats(value) {
  const s = value.scope
  const lines = []
  const one = s.sessions === 1 && value.sessions?.[0]
  const skipped = value.skipped?.length ? ` (${value.skipped.length} more skipped, see below)` : ''
  const scopeLabel = one ? `${shortId(one.id)} ${one.workspace}/${one.title ?? '(untitled)'}` : `${s.sessions} sessions read${skipped}${s.from ? `, created ${fmtTime(s.from)} → ${fmtTime(s.to)}` : ''}`
  lines.push(`${scopeLabel} · ${s.calls} calls · ${s.errors} errors${s.tools?.length ? ` · tools ${s.tools.join(', ')}` : ''}`)
  if (value.tools.length === 0) { lines.push('No tool calls matched.'); return lines.join('\n') }
  const rows = []
  for (const t of value.tools) {
    const first = t.topErrors[0]
    rows.push([t.tool, t.calls, t.errors, `${Math.round(t.errorRate * 100)}%`, fmtMs(t.p50Ms), fmtMs(t.p90Ms), first ? `×${first.count} ${first.message}` : ''])
    for (const e of t.topErrors.slice(1)) rows.push(['', '', '', '', '', '', `×${e.count} ${e.message}`])
  }
  lines.push(table(['tool', 'calls', 'err', 'err%', 'p50', 'p90', 'top errors (normalized; see fmt=json for example seqs)'], rows, ['l', 'r', 'r', 'r', 'r', 'r', 'l']))
  if (value.afterError.length) {
    lines.push('after an error, the next call was:')
    for (const a of value.afterError.slice(0, 12)) {
      const rel = a.relation === 'same-args' ? 'retry, identical args' : a.relation === 'retry' ? 'retry, changed args' : a.relation === 'end' ? 'nothing — session ended' : 'switch'
      lines.push(`  ${a.tool} ✗ → ${a.next ?? '(none)'} (${rel}) ×${a.count}`)
    }
  }
  lines.push(...skippedLines(value.skipped))
  return lines.join('\n')
}

// ------------------------------------------------------------------ grep

export function renderGrep(value) {
  const lines = [`${value.hits.length} hit${value.hits.length === 1 ? '' : 's'} for /${value.pattern}/${value.flags ?? ''} in ${value.sessions.length} session${value.sessions.length === 1 ? '' : 's'}${value.truncated ? ` (showing first ${value.hits.length}; narrow or raise limit)` : ''}`]
  const multi = value.sessions.length + (value.skipped?.length ?? 0) > 1
  let lastSession = null
  for (const h of value.hits) {
    if (h.session !== lastSession) {
      const s = value.sessions.find(x => x.id === h.session)
      lines.push(`— ${shortId(h.session)} ${s ? `${s.workspace}/${s.title ?? '(untitled)'}` : ''}`)
      lastSession = h.session
    }
    // In a multi-session search every hit names its session, so a seq is never paired with the wrong session downstream.
    const where = `${multi ? `${shortId(h.session)} ` : ''}[${h.seq}] ${h.kind}${h.tool ? ` ${h.tool}` : ''}${h.turn !== null && h.turn !== undefined ? ` T${h.turn}` : ''}`
    lines.push(`${where}: …${h.excerpt}…`)
  }
  lines.push(...skippedLines(value.skipped))
  return lines.join('\n')
}

function skippedLines(skipped) {
  if (!skipped || skipped.length === 0) return []
  return [`${skipped.length} session${skipped.length === 1 ? '' : 's'} could not be read by DSH's session reader and ${skipped.length === 1 ? 'was' : 'were'} skipped (fmt=json carries the full diagnostics):`,
    ...skipped.map(s => `  ${shortId(s.id)} ${clip(`${s.workspace}/${s.title ?? '(untitled)'}`, 48)}: ${shortReadError(s.error)}`)]
}

/** The reader's diagnostic without its `failed to read stored session "<id>":` prefix and `(raw log: …)` suffix. */
function shortReadError(error) {
  let e = String(error ?? '')
  e = e.replace(/^failed to read stored session "[^"]*":\s*/, '')
  e = e.replace(/;?\s*source v\d+ artifact remains unchanged/, '')
  e = e.replace(/\s*\(raw log: [^)]*\)?\s*$/, '')
  return clip(e, 140)
}

// ----------------------------------------------------------------- event

export function renderEvent(value) {
  const lines = [sessionLine(value.session)]
  for (const b of value.before ?? []) lines.push(`  ${renderRow(b, { maxResultChars: 120 })}`)
  lines.push(`event seq ${value.event.seq} type ${value.event.type} at ${fmtClock(value.event.time)}:`)
  lines.push(JSON.stringify(value.event, null, 1))
  for (const a of value.after ?? []) lines.push(`  ${renderRow(a, { maxResultChars: 120 })}`)
  return lines.join('\n')
}

// ------------------------------------------------------------ json/jsonl

export function toJson(value) {
  return JSON.stringify(value, null, 1)
}

/**
 * JSONL: a header object, then one object per row.
 * @param {object} header - `{ kind: 'header', ... }` facts
 * @param {readonly object[]} rows
 * @param {object} [trailer] - optional final object (e.g. `{ kind: 'omitted', ... }`)
 */
export function toJsonl(header, rows, trailer) {
  const lines = [JSON.stringify({ kind: 'header', ...header })]
  for (const r of rows) lines.push(JSON.stringify(r))
  if (trailer) lines.push(JSON.stringify(trailer))
  return lines.join('\n')
}

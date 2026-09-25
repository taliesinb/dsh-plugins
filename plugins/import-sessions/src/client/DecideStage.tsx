/**
 * Decide stage — the parts beside the tree table:
 *
 *   - `SessionCard`: the single-session shape (`scan.kind === 'session'`):
 *     title, dates, size, turns, ~tokens, badges and an "Import to" select
 *     with the same options a workspace row gets.
 *   - `LargeSection`: the follow-up step shown only when a SELECTED session is
 *     `large`; radio cards Compacted (keepTurns / resultCap inputs) vs Original, applied
 *     to the large ones only.
 */
import { fileSizeText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import type { ScanSession, ScanWorkspace, SourcesResult } from './protocol.ts'
import { DestinationLozenge, SessionBadges, type DestinationValue } from './TreeStage.tsx'
import { borderColor, brandColor, compactText, dateRangeText, hoverBg, plural, small, tildify, tokenText, warningColor } from './format.ts'

export type ModeKind = 'archive' | 'working'

/** The large-session choice as the user has it in the form. */
export interface LargeChoice { mode: ModeKind, keepTurns: number, resultCap: number }

export const MIN_KEEP_TURNS = 1
export const MIN_RESULT_CAP = 256

// ---------------------------------------------------------------------------
// Single-session card

/**
 * @param props.workspace - the scan's one workspace row (carries dir / default destination).
 * @param props.session - the scan's one session.
 * @param props.destination - current select value.
 */
export function SessionCard({ workspace, session, existing, destination, newBase, remoteDirs, onDestination }: {
  newBase: string
  /** The transcripts were uploaded from another machine: `dirExists` (checked on the server) says nothing about the recording directory. */
  remoteDirs?: { host: string | undefined }
  workspace: ScanWorkspace
  session: ScanSession
  existing: SourcesResult['workspaces']
  destination: DestinationValue
  onDestination: (value: DestinationValue) => void
}) {
  const facts: string[] = [
    dateRangeText(session.startedAt, session.endedAt),
    fileSizeText(session.bytes),
    plural(session.turns, 'turn'),
    `${String(session.toolCalls)} tool call${session.toolCalls === 1 ? '' : 's'}`,
    tokenText(session.estimatedTokens),
  ]
  return (
    <div style={{ border: `1px solid ${borderColor}`, borderRadius: 8, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }} title={session.file}>{session.title}</span>
        <SessionBadges session={session} />
      </div>
      <div style={{ ...small, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {facts.map((fact, index) => <span key={fact}>{index > 0 ? '· ' : ''}{fact}</span>)}
      </div>
      <div style={{ ...small, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={workspace.dir}>
        Recorded in {tildify(workspace.dir)}{remoteDirs !== undefined
          ? <span> on {remoteDirs.host ?? 'your device'}</span>
          : !workspace.dirExists ? <span style={{ color: warningColor }}> (directory no longer exists)</span> : null}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 2 }}>
        <span style={{ fontWeight: 600 }}>Import to</span>
        <DestinationLozenge value={destination} workspace={workspace} existing={existing} newBase={newBase} onChange={onDestination} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Large sessions

function ModeCard({ selected, title, children, onSelect }: { selected: boolean, title: string, children: ReactNode, onSelect: () => void }) {
  return (
    <label
      style={{
        display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 8, cursor: 'pointer', flex: 1, minWidth: 0,
        border: `1px solid ${selected ? brandColor : borderColor}`,
        boxShadow: selected ? `0 0 0 1px ${brandColor} inset` : undefined,
        background: selected ? hoverBg : undefined,
      }}
    >
      <input type="radio" name="tali-import-large-mode" checked={selected} onChange={onSelect} style={{ marginTop: 3, accentColor: 'var(--dsw-alias-brand-primary)' }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{title}</div>
        {children}
      </div>
    </label>
  )
}

/** Inline numeric field inside a sentence; clamps to `min` on every change. */
function InlineNumber({ label, value, min, step, onChange, disabled }: { label: string, value: number, min: number, step: number, onChange: (next: number) => void, disabled: boolean }) {
  return (
    <input
      type="number"
      aria-label={label}
      title={label}
      min={min}
      step={step}
      value={value}
      disabled={disabled}
      onClick={(event) => { event.stopPropagation() }}
      onChange={(event) => {
        const next = Number(event.target.value)
        if (Number.isFinite(next)) onChange(Math.max(min, Math.floor(next)))
      }}
      style={{ width: 72, fontSize: 12, padding: '1px 4px', margin: '0 2px', borderRadius: 6, border: `1px solid ${borderColor}`, background: 'var(--dsw-alias-bg-layer-1, transparent)', color: 'inherit' }}
    />
  )
}

/**
 * @param props.count - selected sessions that are `large`.
 * @param props.largeTokens - the host's threshold (`scan.largeTokens`).
 */
export function LargeSection({ count, largeTokens, choice, onChange }: {
  count: number
  largeTokens: number
  choice: LargeChoice
  onChange: (next: LargeChoice) => void
}) {
  const working = choice.mode === 'working'
  return (
    <section aria-label="Large sessions" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 13, lineHeight: 1.45 }}>
        {plural(count, 'selected session')} exceed{count === 1 ? 's' : ''} ~{compactText(largeTokens)} tokens of model-visible history — more than fits a model window. How should {count === 1 ? 'it' : 'they'} be imported?
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'stretch' }} className="tali-import-mode-cards">
        <style>{'@media (max-width: 640px) { .tali-import-mode-cards { flex-direction: column; } }'}</style>
        <ModeCard selected={working} title="Compacted" onSelect={() => { onChange({ ...choice, mode: 'working' }) }}>
          <div style={{ ...small, lineHeight: 1.7 }}>
            Keep the last
            <InlineNumber label="Turns kept visible to the model" value={choice.keepTurns} min={MIN_KEEP_TURNS} step={1} disabled={!working} onChange={(next) => { onChange({ ...choice, keepTurns: next }) }} />
            turns visible to the model; older turns stay in the log behind a checkpoint, so the session can be prompted. Cap tool results at
            <InlineNumber label="Tool result cap in characters" value={choice.resultCap} min={MIN_RESULT_CAP} step={256} disabled={!working} onChange={(next) => { onChange({ ...choice, resultCap: next }) }} />
            chars.
          </div>
        </ModeCard>
        <ModeCard selected={!working} title="Original" onSelect={() => { onChange({ ...choice, mode: 'archive' }) }}>
          <div style={{ ...small, lineHeight: 1.45 }}>
            Import everything as-is. The session reads, renders and searches in full, but cannot be prompted until it is compacted.
          </div>
        </ModeCard>
      </div>
      <div style={small}>Applies to the large {count === 1 ? 'session' : 'sessions'} only; the other selected sessions import in full.</div>
    </section>
  )
}

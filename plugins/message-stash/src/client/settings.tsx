/**
 * Settings → General row: the Ctrl+S double-tap window. A persisted
 * `createSnapshotStore` (localStorage) holds the choice; the row reads it
 * through the renderer-bound `useSettings` hook and writes through the
 * injected callback. Styled after the shipped "Enter behavior" row
 * (ui-conversation/settings/EnterBehaviorRow): title, one selector pill.
 */
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState, type CSSProperties, type ReactNode } from 'react'
import { DOUBLE_TAP_CHOICES } from './keys.ts'

export interface StashSettings {
  /** Second Ctrl+S within this many ms opens the view; 0 disables it. */
  readonly doubleTapMs: number
}

export interface SettingsRowInjected {
  hooks: { settings: SnapshotStore<StashSettings> }
  setDoubleTapMs: (ms: number) => void
}

type Props = PropsRuntime<'settings.general.item'> & InjectFace<SettingsRowInjected>

const row: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '16px 0',
  borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
}
const title: CSSProperties = {
  flex: 1, minWidth: 0, paddingRight: 48, fontSize: 14, lineHeight: '22px',
  color: 'var(--dsw-alias-label-primary)',
}
const selector: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 12, height: 36, padding: '0 14px',
  border: 'none', borderRadius: 18, background: 'var(--dsw-alias-bg-module-platform)',
  font: 'inherit', fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)',
  cursor: 'pointer',
}

/** "Off", "300 ms", "1 s", "1.5 s". */
export function windowLabel(ms: number): string {
  if (ms <= 0) return 'Off'
  if (ms < 1000) return `${String(ms)} ms`
  const seconds = ms / 1000
  return `${Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1)} s`
}

export function StashSettingsRow({ useSettings, setDoubleTapMs }: Props): ReactNode {
  const doubleTapMs = useSettings(state => state.doubleTapMs)
  const [open, setOpen] = useState(false)
  const choices = DOUBLE_TAP_CHOICES.includes(doubleTapMs as typeof DOUBLE_TAP_CHOICES[number])
    ? [...DOUBLE_TAP_CHOICES]
    : [doubleTapMs, ...DOUBLE_TAP_CHOICES]
  return (
    <div style={row}>
      <div style={title}>Stash view on Ctrl+S, S within</div>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={choices.map(ms => ({ id: String(ms), label: windowLabel(ms) }))}
        selectedId={String(doubleTapMs)}
        onSelect={(id: string) => { setOpen(false); setDoubleTapMs(Number(id)) }}
        align="end"
        portal
        anchor={(
          <button type="button" style={selector} aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
            {windowLabel(doubleTapMs)}
            <IconChevronDownOutline14 />
          </button>
        )}
      />
    </div>
  )
}

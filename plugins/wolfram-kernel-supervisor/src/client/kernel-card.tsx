/**
 * "Wolfram kernel" card in Settings ▸ Plugins ▸ Plugin configuration.
 *
 * Registered under the `settings.plugin.item` slot keyed by the Host settings
 * namespace `wolfram-kernel-supervisor` (index.js SETTINGS_NS): the tab pairs
 * the two and the card appears exactly when the Host serves that namespace.
 *
 * The one field, `kernelPath`, is edited through `ctx.settingsScope` with the
 * same staged draft → Save discipline as the in-tree cards (what is on screen
 * is what a save writes; an empty draft clears the override so the field
 * re-inherits the plugin config / auto-detection). Everything else on the card
 * is read from the plugin's own route, GET /api/wolfram/kernel: which kernel
 * resolved and how (setting / config / auto-detected), the version, what
 * auto-detection searched when nothing was found, and wolframscript's state.
 * POST ?action=detect|configure-wolframscript|probe-wolframscript drive the
 * three buttons. In-tree card chrome (PluginCard, ValueField) is not importable
 * across plugins, so the equivalent inline styles live here.
 */
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the `settings.plugin.item` SlotMap entry (declared by the tab that renders it).
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { Button, IconChevronDownOutline14, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CSSProperties, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'

/** Mirror of KernelLocator.status() (kernel-locator.mjs). */
export interface KernelStatus {
  platform?: string
  kernel?: { kernelPath: string; launcher: string; root: string; version?: string }
  source?: 'setting' | 'config' | 'detected'
  input?: string
  error?: string
  searched?: string[]
  settingsAvailable?: boolean
  manageWolframscript?: boolean
  wolframscript?: WolframscriptStatus
  checkedAt?: string
  message?: string
}

export interface WolframscriptStatus {
  state: 'unknown' | 'absent' | 'checking' | 'explicit' | 'explicit-broken' | 'implicit-ok' | 'implicit-broken' | 'implicit' | 'error'
  path?: string
  version?: string
  confPath?: string
  configuredKernel?: string
  matches?: boolean
  configuredByDsh?: { at: string; why: string }
  probe?: { ok: boolean; output: string; ms: number; at?: string; cached?: boolean }
  error?: string
}

/** The section the Host serves under SETTINGS_NS. */
export interface KernelSettings { kernelPath?: string }

/** Same-origin route (host: index.js KERNEL_PATH); document-relative so proxied mounts work. */
const KERNEL_ROUTE = './api/wolfram/kernel'

async function fetchStatus(action?: string): Promise<KernelStatus> {
  const response = await fetch(action === undefined ? KERNEL_ROUTE : `${KERNEL_ROUTE}?action=${encodeURIComponent(action)}`, {
    method: action === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
  })
  const body = await response.json() as KernelStatus & { error?: string }
  if (!response.ok && typeof body.error === 'string' && body.kernel === undefined && body.wolframscript === undefined) throw new Error(body.error)
  return body
}

// ---- styles (mirror of ui-settings-plugins PluginCard.module.css / fields.module.css)

const s = {
  card: { listStyle: 'none', border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: 16, background: 'var(--dsw-alias-bg-layer-3)', transition: 'border-color .16s, background .16s' } as CSSProperties,
  cardOpen: { background: 'var(--dsw-alias-bg-layer-2)', borderColor: 'var(--dsw-alias-label-dimmed)' } as CSSProperties,
  header: { width: '100%', appearance: 'none', border: 0, background: 'none', font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderRadius: 12 } as CSSProperties,
  headText: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 } as CSSProperties,
  name: { fontSize: 15, fontWeight: 600, lineHeight: 1.4, color: 'var(--dsw-alias-label-primary)' } as CSSProperties,
  description: { fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' } as CSSProperties,
  chevron: { flex: 'none', color: 'var(--dsw-alias-label-tertiary)', transition: 'transform .16s' } as CSSProperties,
  body: { borderTop: '0.5px solid var(--dsw-alias-border-l2)', margin: '0 16px', paddingBottom: 8 } as CSSProperties,
  field: { display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 0' } as CSSProperties,
  head: { display: 'flex', alignItems: 'center', gap: 8 } as CSSProperties,
  label: { flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)' } as CSSProperties,
  badges: { display: 'inline-flex', alignItems: 'center', gap: 8 } as CSSProperties,
  reset: { border: 'none', background: 'none', padding: 0, font: 'inherit', fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer' } as CSSProperties,
  input: { height: 34, padding: '0 12px', border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-3)', font: 'inherit', fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } as CSSProperties,
  hint: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' } as CSSProperties,
  error: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-error)' } as CSSProperties,
  status: { display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 0', borderTop: '0.5px solid var(--dsw-alias-border-l2)', fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' } as CSSProperties,
  row: { display: 'flex', alignItems: 'flex-start', gap: 8 } as CSSProperties,
  rowLabel: { flex: 'none', width: 92, color: 'var(--dsw-alias-label-tertiary)' } as CSSProperties,
  rowBody: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2, overflowWrap: 'anywhere' } as CSSProperties,
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11.5, color: 'var(--dsw-alias-label-primary)' } as CSSProperties,
  muted: { color: 'var(--dsw-alias-label-tertiary)' } as CSSProperties,
  footer: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '12px 0 4px', borderTop: '0.5px solid var(--dsw-alias-border-l2)' } as CSSProperties,
  footerLeft: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 } as CSSProperties,
  discard: { appearance: 'none', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '5px 14px', font: 'inherit', fontSize: 13, lineHeight: 1.5, cursor: 'pointer', background: 'none', color: 'var(--dsw-alias-label-secondary)' } as CSSProperties,
  save: { appearance: 'none', border: '1px solid transparent', borderRadius: 8, padding: '5px 14px', font: 'inherit', fontSize: 13, lineHeight: 1.5, cursor: 'pointer', background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-3)' } as CSSProperties,
}

const disabledStyle = (disabled: boolean): CSSProperties => (disabled ? { opacity: 0.4, cursor: 'default' } : {})

/** Reactive view of the bound settings scope. */
function useScope<T>(scope: SettingsScope<T>) {
  const [snapshot, setSnapshot] = useState(() => scope.getSnapshot())
  useEffect(() => scope.subscribe(() => { setSnapshot(scope.getSnapshot()) }), [scope])
  return snapshot
}

function Row({ label, dot, children }: { label: string; dot?: 'done' | 'warning' | 'ongoing' | 'error' | 'idle'; children: ReactNode }) {
  return (
    <div style={s.row}>
      <span style={s.rowLabel}>{label}</span>
      {dot !== undefined && <span style={{ flex: 'none', marginTop: 4 }}><StateDot state={dot} /></span>}
      <div style={s.rowBody}>{children}</div>
    </div>
  )
}

function sourceLabel(source: KernelStatus['source']): string {
  switch (source) {
    case 'detected': return 'auto-detected'
    case 'setting': return 'from this setting'
    case 'config': return 'from the plugin config (kernel:)'
    default: return ''
  }
}

function KernelRow({ status }: { status: KernelStatus | undefined }) {
  if (status === undefined) return <Row label="Kernel" dot="ongoing"><span style={s.muted}>checking…</span></Row>
  if (status.kernel !== undefined) {
    return (
      <Row label="Kernel" dot="done">
        <span style={s.mono}>{status.kernel.kernelPath}</span>
        <span style={s.muted}>
          {status.kernel.version !== undefined ? `Wolfram ${status.kernel.version} · ` : ''}{sourceLabel(status.source)}
          {status.kernel.launcher !== status.kernel.kernelPath ? ` · launched through ${status.kernel.launcher.split('/').pop() ?? 'wolfram'}` : ''}
        </span>
      </Row>
    )
  }
  return (
    <Row label="Kernel" dot="error">
      {status.error !== undefined
        ? <span style={s.error}>{status.error}</span>
        : (
          <>
            <span style={s.error}>No Wolfram kernel found — every wolfram_* tool and /wolfram command fails until one is set.</span>
            {status.searched !== undefined && status.searched.length > 0 && (
              <span style={s.muted}>Searched: {status.searched.join('; ')}</span>
            )}
          </>
        )}
    </Row>
  )
}

function WolframscriptRow({ ws, busy, kernelSet, onConfigure, onProbe }: { ws: WolframscriptStatus | undefined; busy: boolean; kernelSet: boolean; onConfigure: () => void; onProbe: () => void }) {
  if (ws === undefined || ws.state === 'unknown') return <Row label="wolframscript" dot="idle"><span style={s.muted}>not checked yet</span></Row>
  const where = ws.path !== undefined ? <span style={s.mono}>{ws.path}{ws.version !== undefined ? <span style={s.muted}> — {ws.version}</span> : null}</span> : null
  const byDsh = ws.configuredByDsh !== undefined ? ` (set by DSH ${new Date(ws.configuredByDsh.at).toLocaleString()}: ${ws.configuredByDsh.why})` : ''
  const actions = (
    <span style={{ display: 'inline-flex', gap: 6, marginTop: 4 }}>
      {kernelSet && ws.state !== 'explicit' && <Button size="sm" variant="outline" disabled={busy} onClick={onConfigure}>Point wolframscript at this kernel</Button>}
      {kernelSet && ws.state === 'explicit' && ws.matches !== true && <Button size="sm" variant="outline" disabled={busy} onClick={onConfigure}>Use this kernel instead</Button>}
      {(ws.state === 'implicit-ok' || ws.state === 'implicit-broken') && <Button size="sm" variant="ghost" disabled={busy} onClick={onProbe}>Re-check</Button>}
    </span>
  )
  switch (ws.state) {
    case 'absent':
      return <Row label="wolframscript" dot="idle"><span style={s.muted}>not on $PATH — bash `wolframscript` calls will fail; the wolfram_* tools do not need it.</span></Row>
    case 'checking':
      return <Row label="wolframscript" dot="ongoing">{where}<span style={s.muted}>checking whether it can find a kernel by itself (launches one, a few seconds)…</span></Row>
    case 'explicit':
      return (
        <Row label="wolframscript" dot={ws.matches === true ? 'done' : 'warning'}>
          {where}
          <span style={s.muted}>WOLFRAMSCRIPT_KERNELPATH = <span style={s.mono}>{ws.configuredKernel}</span>{ws.matches === true ? ' — same kernel' : ' — a different kernel than the one above'}{byDsh}</span>
          {actions}
        </Row>
      )
    case 'explicit-broken':
      return (
        <Row label="wolframscript" dot="error">
          {where}
          <span style={s.error}>Its configured kernel does not exist: {ws.configuredKernel}</span>
          {actions}
        </Row>
      )
    case 'implicit-ok':
      return (
        <Row label="wolframscript" dot="done">
          {where}
          <span style={s.muted}>finds a kernel by itself (no WOLFRAMSCRIPT_KERNELPATH needed){ws.probe !== undefined ? ` · checked ${ws.probe.cached === true ? 'earlier' : 'just now'}: ${ws.probe.output}` : ''}</span>
          {actions}
        </Row>
      )
    case 'implicit-broken':
      return (
        <Row label="wolframscript" dot="error">
          {where}
          <span style={s.error}>cannot find a kernel by itself{ws.probe !== undefined && ws.probe.output !== '' ? ` (${ws.probe.output})` : ''}.</span>
          {actions}
        </Row>
      )
    case 'implicit':
      return <Row label="wolframscript" dot="idle">{where}<span style={s.muted}>no explicit kernel path; checked once a kernel is set.</span></Row>
    case 'error':
      return <Row label="wolframscript" dot="error">{where}<span style={s.error}>{ws.error}</span>{actions}</Row>
    default:
      return null
  }
}

/** The card. `scope` is the bound `wolfram-kernel-supervisor` settings scope. */
export function WolframKernelCard({ scope }: { scope: SettingsScope<KernelSettings> }) {
  const snapshot = useScope(scope)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState<string | undefined>(undefined)
  const [status, setStatus] = useState<KernelStatus | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)

  const user = snapshot.user as Record<string, unknown> | undefined
  const stored = typeof snapshot.value?.kernelPath === 'string' ? snapshot.value.kernelPath : ''
  const overriddenNow = user !== undefined && Object.hasOwn(user, 'kernelPath')
  const text = draft ?? stored
  const dirty = draft !== undefined && draft.trim() !== stored
  const disabled = !snapshot.writable || saving

  const refresh = useCallback(async (action?: string) => {
    try {
      setStatus(await fetchStatus(action))
    } catch (error) {
      setStatus(prev => ({ ...prev, error: error instanceof Error ? error.message : String(error) }))
    }
  }, [])

  // Load the status when opened; poll while wolframscript is being probed (a kernel launch).
  useEffect(() => {
    if (!open) return
    void refresh()
  }, [open, refresh])
  useEffect(() => {
    if (!open || status?.wolframscript?.state !== 'checking') return
    const timer = setInterval(() => { void refresh() }, 2000)
    return () => clearInterval(timer)
  }, [open, status?.wolframscript?.state, refresh])
  // The Host re-resolves on every settings commit; re-read shortly after the mirror moves.
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => { void refresh() }, 400)
    return () => clearTimeout(timer)
  }, [open, snapshot.revision, refresh])

  const save = async () => {
    if (!dirty || saving) return
    setSaving(true)
    setFailed(undefined)
    const value = (draft ?? '').trim()
    try {
      if (value === '') await scope.unset('kernelPath')
      else await scope.set('kernelPath', value)
      const after = scope.getSnapshot()
      const landed = value === '' ? !(after.user !== undefined && Object.hasOwn(after.user as object, 'kernelPath')) : (after.user as Record<string, unknown> | undefined)?.kernelPath === value
      if (landed) setDraft(undefined)
      else setFailed('The Host did not accept that value.')
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const act = async (action: string) => {
    setBusy(action)
    try { await refresh(action) } finally { setBusy(undefined) }
  }

  if (snapshot.status !== 'ready') return null
  const kernelSet = status?.kernel !== undefined
  return (
    <li style={{ ...s.card, ...(open ? s.cardOpen : {}) }}>
      <button type="button" style={s.header} aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'}: Wolfram kernel`} onClick={() => { setOpen(!open) }}>
        <span style={s.headText}>
          <span style={s.name}>Wolfram kernel</span>
          <span style={s.description}>Where the Wolfram Language kernel behind the wolfram_* tools and /wolfram commands lives, and whether wolframscript can find it.</span>
        </span>
        {dirty && <Tag tone="neutral">Unsaved</Tag>}
        {status !== undefined && !kernelSet && <Tag tone="neutral">Not found</Tag>}
        <span style={{ ...s.chevron, display: 'inline-flex', transform: open ? 'rotate(180deg)' : undefined }}><IconChevronDownOutline14 /></span>
      </button>
      {open && (
        <div style={s.body}>
          {!snapshot.writable && <p style={{ ...s.hint, margin: '12px 0 0' }}>The settings document is read-only on this connection.</p>}
          <div style={s.field}>
            <div style={s.head}>
              <label style={s.label} htmlFor="plugin-config-wolfram-kernel-path">Kernel path</label>
              {(overriddenNow || (dirty && text.trim() !== '')) && (
                <span style={s.badges}>
                  <Tag tone="neutral">Overridden</Tag>
                  <button type="button" style={{ ...s.reset, ...disabledStyle(disabled) }} disabled={disabled} onClick={() => { setDraft('') }}>Reset</button>
                </span>
              )}
            </div>
            <input
              id="plugin-config-wolfram-kernel-path"
              style={s.input}
              type="text"
              spellCheck={false}
              value={text}
              placeholder={status?.platform === 'darwin' ? '/Applications/Wolfram.app' : status?.platform === 'win32' ? 'C:\\Program Files\\Wolfram Research\\Wolfram\\14.3' : '/usr/local/Wolfram/Wolfram/14.3'}
              disabled={disabled}
              onChange={(event) => { setDraft(event.target.value); setFailed(undefined) }}
              onKeyDown={(event) => { if (event.key === 'Enter') void save() }}
            />
            <p style={failed !== undefined ? s.error : s.hint}>
              {failed ?? 'The WolframKernel executable, the wolfram launcher, a Wolfram.app / Mathematica.app bundle, or an installation directory. Leave empty to auto-detect; a found kernel is filled in here. Applies to kernels started from now on.'}
            </p>
          </div>
          <div style={s.status}>
            <KernelRow status={status} />
            <WolframscriptRow
              ws={status?.wolframscript}
              busy={busy !== undefined}
              kernelSet={kernelSet}
              onConfigure={() => { void act('configure-wolframscript') }}
              onProbe={() => { void act('probe-wolframscript') }}
            />
          </div>
          <div style={s.footer}>
            <span style={s.footerLeft}>
              <Button size="sm" variant="outline" disabled={busy !== undefined || disabled} onClick={() => { void act('detect') }}>
                {busy === 'detect' ? 'Detecting…' : 'Auto-detect'}
              </Button>
              {busy === 'configure-wolframscript' && <span style={s.muted}>configuring wolframscript…</span>}
              {busy === 'probe-wolframscript' && <span style={s.muted}>probing wolframscript (launches a kernel)…</span>}
            </span>
            <button type="button" style={{ ...s.discard, ...disabledStyle(!dirty || saving) }} disabled={!dirty || saving} onClick={() => { setDraft(undefined); setFailed(undefined) }}>Discard</button>
            <button type="button" style={{ ...s.save, ...disabledStyle(!dirty || saving || !snapshot.writable) }} disabled={!dirty || saving || !snapshot.writable} onClick={() => { void save() }}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      )}
    </li>
  )
}

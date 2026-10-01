/**
 * tali-app-setup — browser half.
 *
 * A checklist dialog for the bundled app: what DSH can use on this Mac that
 * the app does not carry (Tailscale, Safari Technology Preview, Chrome, afm)
 * and whether it is there. Each missing free item has one button, **Get…**,
 * which opens its download page; installed-but-not-connected Tailscale has
 * **Open**. Paid apps (Dash, Mathematica) are listed only when present.
 *
 * Shown once on the app's first launch (`shell.overlay`, closed with "Done"
 * or Escape — either records the dismissal), and any time afterwards from the
 * bundle's card on the Plugins page (`plugins.bundle.config`) with the same
 * rows inline. Detection is the host half's (`../../index.js`); the dialog
 * re-polls every 5 s while open so an install made in the meantime shows up.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useRef, useState } from 'react'
import { DIALOG_DEFAULT, useDialogDefaultAction } from './dialog-keys.ts'

export const name = 'app-setup'
export const inject = ['slots']

const BUNDLE_NAME = 'tali-app-setup'
const API = './api/app-setup'

interface Item {
  id: string
  label: string
  kind: 'required' | 'optional' | 'paid'
  installed: boolean
  detail?: string
  action: 'open' | 'launch' | 'install' | null
  url?: string
}
interface Job { step: 'download' | 'install' | 'done' | 'failed', fraction: number, error?: string, done?: boolean }
interface State { firstRun: boolean, items: Item[], version: string, jobs: Record<string, Job> }

declare global {
  // eslint-disable-next-line no-var
  var __DSH_APP_SETUP__: { bundle: string, version: string } | undefined
  // eslint-disable-next-line no-var
  var __DSH_DOCK__: { name?: string } | undefined
}

/** The wrapper's app name (`DSH`, or a canary's `DSH <branch> <commit>`), published by its identity script. */
const appName = (): string => globalThis.__DSH_DOCK__?.name || 'DSH'

async function call(action: string, item?: string): Promise<State | { ok: true }> {
  const query = new URLSearchParams({ action })
  if (item) query.set('item', item)
  const response = await fetch(`${API}?${query}`, { method: action === 'state' ? 'GET' : 'POST', credentials: 'same-origin' })
  const body = await response.json() as { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body as State | { ok: true }
}

/** Shared by the dialog and the card: polls while mounted. */
function useSetupState(poll: boolean): { state: State | null, error: string | null, refresh: () => Promise<void> } {
  const [state, setState] = useState<State | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    try { setState(await call('state') as State); setError(null) } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
  }, [])
  const busy = Object.values(state?.jobs ?? {}).some(j => !j.done)
  useEffect(() => {
    void refresh()
    if (!poll && !busy) return
    const timer = setInterval(() => { void refresh() }, busy ? 400 : 5000)
    return () => clearInterval(timer)
  }, [refresh, poll, busy])
  return { state, error, refresh }
}

const row: React.CSSProperties = { display: 'grid', gridTemplateColumns: '18px 1fr auto', alignItems: 'center', gap: 10, padding: '7px 0', fontSize: 13 }
const dim: React.CSSProperties = { opacity: 0.55, fontSize: 12 }

const STEP_LABEL: Record<Job['step'], string> = { download: 'Downloading', install: 'Installing', done: 'Installed', failed: 'Failed' }

function Progress({ job }: { job: Job }) {
  const pct = Math.round(job.fraction * 100)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 160, justifyContent: 'flex-end' }}>
      <span style={dim}>{STEP_LABEL[job.step]}{job.step === 'download' ? ` ${pct}%` : ''}</span>
      <span style={{ width: 90, height: 4, borderRadius: 2, background: 'var(--dsw-color-border-subtle, #8883)', overflow: 'hidden', position: 'relative' }}>
        {job.step === 'install'
          // The install step (installer / ditto) reports no bytes: a sweeping segment, not a stuck number.
          ? <span style={{ position: 'absolute', top: 0, bottom: 0, width: '35%', borderRadius: 2, background: 'var(--dsw-alias-state-business-primary, #3b82f6)', animation: 'dsh-app-setup-sweep 1.1s ease-in-out infinite alternate' }} />
          : <span style={{ display: 'block', height: '100%', width: `${job.step === 'download' ? pct : 100}%`, background: job.step === 'failed' ? 'var(--dsh-color-danger, #d9534f)' : 'var(--dsw-alias-state-business-primary, #3b82f6)', transition: 'width .3s' }} />}
      </span>
      <style>{'@keyframes dsh-app-setup-sweep { from { left: 0 } to { left: 65% } }'}</style>
    </span>
  )
}

function Rows({ state, onAct, busy }: { state: State, onAct: (item: Item) => void, busy: string | null }) {
  const visible = state.items.filter(item => item.kind !== 'paid' || item.installed)
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {visible.map(item => {
        const job = state.jobs?.[item.id]
        const running = job !== undefined && !job.done
        return (
          <div key={item.id} style={{ ...row, borderTop: '1px solid var(--dsw-color-border-subtle, #8882)' }}>
            <span aria-hidden style={{ textAlign: 'center', color: item.installed ? 'var(--dsw-color-success, #2e9e57)' : 'var(--dsw-color-text-tertiary, #999)' }}>{item.installed ? '●' : '○'}</span>
            <span>
              <span>{item.label}</span>
              {item.detail && <span style={{ ...dim, marginLeft: 8 }}>{item.detail}</span>}
              {!item.installed && item.kind === 'paid' && <span style={{ ...dim, marginLeft: 8 }}>not installed</span>}
              {job?.error && <div role="alert" style={{ color: 'var(--dsh-color-danger, #d9534f)', fontSize: 12 }}>{job.error}</div>}
            </span>
            <span>
              {running && <Progress job={job} />}
              {!running && item.action === 'install' && <span style={{ display: 'inline-flex', gap: 6 }}>
                <Button variant="outline" disabled={busy !== null} onClick={() => onAct({ ...item, action: 'open' })}>Get…</Button>
                <Button variant="primary" disabled={busy !== null} onClick={() => onAct(item)}>Install</Button>
              </span>}
              {!running && item.action === 'open' && <Button variant="outline" disabled={busy !== null} onClick={() => onAct(item)}>Get…</Button>}
              {!running && item.action === 'launch' && <Button variant="outline" disabled={busy !== null} onClick={() => onAct(item)}>Open</Button>}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function useAct(refresh: () => Promise<void>): { act: (item: Item) => void, busy: string | null, error: string | null } {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const act = (item: Item): void => {
    if (!item.action) return
    setBusy(item.id)
    void call(item.action, item.id).then(() => refresh()).catch(failure => setError(failure instanceof Error ? failure.message : String(failure))).finally(() => setBusy(null))
  }
  return { act, busy, error }
}

/** First-run overlay. Mounted for the page's life; renders nothing once dismissed. */
function SetupDialog() {
  const { state, error, refresh } = useSetupState(true)
  const [dismissed, setDismissed] = useState(false)
  const [clear, setClear] = useState(false)
  const { act, busy, error: actError } = useAct(refresh)
  // The shipped onboarding steps ("Internal Testing Notice") make the app root
  // `inert` while they show; this dialog waits its turn behind them. Watched
  // for as long as the dialog can still appear: the notice mounts after this
  // component's first render, so a one-shot check would pass too early.
  useEffect(() => {
    if (dismissed) return
    const probe = (): void => { setClear(document.getElementById('root')?.inert !== true) }
    probe()
    const timer = setInterval(probe, 400)
    return () => clearInterval(timer)
  }, [dismissed])
  const open = clear && !dismissed && state?.firstRun === true
  useDialogDefaultAction(open)
  // WKWebView delivers a trusted click to whatever sits under the pointer when the
  // freshly centred window becomes key; twice that landed on Done ~4 s after launch
  // (recipe). A dismissal inside the first second of the dialog's life is ignored.
  const openedAt = useRef(0)
  useEffect(() => { if (open) openedAt.current = performance.now() }, [open])
  if (!open || !state) return null
  const close = (): void => {
    if (performance.now() - openedAt.current < 1000) return
    setDismissed(true); void call('dismiss')
  }
  const missing = state.items.filter(i => i.kind !== 'paid' && !i.installed).length
  return (
    <Modal open title={`Set up ${appName()}`} closeLabel="Done" onClose={close} width={520}
      footer={<Button variant="primary" {...DIALOG_DEFAULT} onClick={close}>Done</Button>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={dim}>{missing === 0 ? 'Everything DSH can use is installed.' : `${missing} optional ${missing === 1 ? 'app is' : 'apps are'} not installed.`}</div>
        <Rows state={state} onAct={act} busy={busy} />
        {(error ?? actError) && <div role="alert" style={{ color: 'var(--dsh-color-danger, #d9534f)', fontSize: 12 }}>{error ?? actError}</div>}
      </div>
    </Modal>
  )
}

/** The bundle's Plugins-page card: the same rows, always available. */
function SetupCard() {
  const { state, error, refresh } = useSetupState(false)
  const { act, busy, error: actError } = useAct(refresh)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>Companion apps</span>
        <Button variant="outline" onClick={() => { void refresh() }}>Refresh</Button>
      </div>
      {state && <Rows state={state} onAct={act} busy={busy} />}
      {globalThis.__DSH_APP_SETUP__?.version && <div style={dim}>{appName()} {globalThis.__DSH_APP_SETUP__.version}</div>}
      {(error ?? actError) && <div role="alert" style={{ color: 'var(--dsh-color-danger, #d9534f)', fontSize: 12 }}>{error ?? actError}</div>}
    </div>
  )
}

export function apply(ctx: Context): void {
  // Only the bundled app publishes the global; a checkout-run profile carrying the row shows nothing.
  if (globalThis.__DSH_APP_SETUP__ === undefined) return
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: BUNDLE_NAME,
  }, SetupDialog)), 'app-setup: first-run dialog')
  ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: BUNDLE_NAME,
  }, SetupCard)), 'app-setup: plugins card')
}

/**
 * Browser half of dsh-tailscale-remote: the "Tailscale remote" settings
 * section. English only, by design.
 *
 *   [Enable] / [Disable]          status line
 *   https://node.ts.net/dsh/  [Copy]
 *   Allowed Tailscale users: [alice@example.com, bob@example.com] [Save]
 *   QR code of the URL WITH the standing token (scanning it authenticates
 *   any device, regardless of its Tailscale user) + [Rotate token]
 *
 * Talks to the host half over the plugin's own RPC channel
 * (`/tailscale-remote/<endpoint>`) through `ctx.connection.rpc`, which is
 * document-relative on the patched DSH — but the proxy refuses to forward that
 * channel, so from a remote device the panel is read-only and says so.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only (erased at build): merges `ctx.slots` onto the Cordis Context.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { Button, Input, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'settings.section': {
      kind: 'list'
      scope: 'root'
      owner: { close: () => void }
    }
  }
}

/** Mirror of the host half's snapshot (index.js). */
export interface RemoteStatus {
  enabled: boolean
  proxyRunning: boolean
  proxyUrl?: string
  route: 'off' | 'active' | 'conflict' | 'unavailable'
  detail?: string
  dnsName?: string
  mappedTarget?: string
  url?: string
  tokenUrl?: string
  qrSvg?: string
  allowedUsers: string[]
  mountPath: string
  servePort: number
}

export interface RemoteApi {
  status(): Promise<RemoteStatus>
  enable(): Promise<RemoteStatus>
  disable(): Promise<RemoteStatus>
  setUsers(list: string): Promise<RemoteStatus>
  rotateToken(): Promise<RemoteStatus>
}

const CHANNEL = '/tailscale-remote'

/** Message a remote (proxied) page sees: the proxy answers the control channel with 403. */
const REMOTE_ONLY_MESSAGE = 'The Tailscale remote is controlled from the DSH host only.'

function createApi(rpc: ClientConnectionRpc): RemoteApi {
  const call = async (endpoint: string, args: Record<string, unknown> = {}): Promise<RemoteStatus> => {
    let result
    try {
      result = await rpc.call(CHANNEL, endpoint, { args })
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      throw new Error(/HTTP 403/.test(text) ? REMOTE_ONLY_MESSAGE : text)
    }
    if (!result.ok) throw new Error(result.error.message)
    return result.value as RemoteStatus
  }
  return {
    status: () => call('status'),
    enable: () => call('enable'),
    disable: () => call('disable'),
    setUsers: list => call('set-users', { allowedUsers: list }),
    rotateToken: () => call('rotate-token'),
  }
}

export const inject = ['slots', 'connection']

export function apply(ctx: Context): void {
  const rpc = (ctx as unknown as { connection: { rpc: ClientConnectionRpc } }).connection.rpc
  const api = createApi(rpc)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'tailscale-remote',
    order: 40,
    label: () => 'Tailscale remote',
    inject: () => ({ api }),
  }, TailscaleRemoteSection))
}

// ---- UI ------------------------------------------------------------------

type SectionProps = PropsRuntime<'settings.section'> & InjectFace<{ api: RemoteApi }>

const styles = {
  section: { display: 'flex', flexDirection: 'column', width: '100%' } as CSSProperties,
  group: { display: 'flex', flexDirection: 'column', gap: 8, padding: '16px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l2)' } as CSSProperties,
  row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } as CSSProperties,
  title: { fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' } as CSSProperties,
  caption: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary))' } as CSSProperties,
  url: {
    flex: '1 1 260px', minWidth: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13, lineHeight: '20px',
    padding: '6px 10px', borderRadius: 8, border: '0.5px solid var(--dsw-alias-border-l4)', background: 'var(--dsw-alias-bg-module-platform)',
    color: 'var(--dsw-alias-label-primary)', overflowWrap: 'anywhere', userSelect: 'all',
  } as CSSProperties,
  error: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' } as CSSProperties,
  dot: (color: string): CSSProperties => ({ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: color, marginRight: 8, verticalAlign: 'middle' }),
  qr: { width: 200, height: 200, borderRadius: 12, overflow: 'hidden', background: '#fff', border: '0.5px solid var(--dsw-alias-border-l4)' } as CSSProperties,
}

function describeRoute(status: RemoteStatus): { color: string; text: string } {
  if (status.route === 'active' && status.proxyRunning) return { color: '#3ba55c', text: `Enabled — serving at ${status.url ?? ''}` }
  if (status.route === 'active') return { color: '#e5a50a', text: 'Route is published but the proxy is not running (enable again)' }
  if (status.route === 'conflict') return { color: '#e5a50a', text: `${status.mountPath} on this node already points at ${status.mappedTarget ?? 'another service'}` }
  if (status.route === 'unavailable') {
    const why = status.detail === 'binary-missing' ? 'the tailscale CLI was not found'
      : status.detail === 'not-running' ? 'Tailscale is not connected'
        : 'tailscaled is unreachable'
    return { color: '#d0342c', text: `Tailscale unavailable: ${why}` }
  }
  return { color: 'var(--dsw-alias-label-tertiary)', text: status.enabled ? 'Enabled, but the route is off (enable again)' : 'Disabled' }
}

export function TailscaleRemoteSection({ api }: SectionProps) {
  const [status, setStatus] = useState<RemoteStatus | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [users, setUsers] = useState('')
  const [usersDirty, setUsersDirty] = useState(false)
  const [copied, setCopied] = useState(false)
  const alive = useRef(true)

  const applyStatus = useCallback((next: RemoteStatus) => {
    if (!alive.current) return
    setStatus(next)
    setError(undefined)
    if (!usersDirty) setUsers(next.allowedUsers.join(', '))
  }, [usersDirty])

  const run = useCallback(async (action: () => Promise<RemoteStatus>) => {
    setBusy(true)
    try {
      applyStatus(await action())
    } catch (caught) {
      if (alive.current) setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [applyStatus])

  useEffect(() => {
    alive.current = true
    void run(api.status)
    const timer = setInterval(() => { if (!busy) void api.status().then(applyStatus).catch(() => {}) }, 15_000)
    return () => {
      alive.current = false
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])

  const saveUsers = async (): Promise<RemoteStatus> => {
    const next = await api.setUsers(users)
    if (alive.current) setUsersDirty(false)
    return next
  }

  const copy = async () => {
    if (status?.url === undefined) return
    setCopied(await writeClipboard(status.url))
    setTimeout(() => { if (alive.current) setCopied(false) }, 1500)
  }

  if (status === undefined) {
    return (
      <div style={styles.section}>
        <div style={styles.group}>
          <div style={styles.title}>Tailscale remote</div>
          <div style={error === undefined ? styles.caption : styles.error}>{error ?? 'Loading…'}</div>
        </div>
      </div>
    )
  }

  const route = describeRoute(status)
  const live = status.enabled && status.route === 'active' && status.proxyRunning

  return (
    <div style={styles.section}>
      <div style={styles.group}>
        <div style={styles.row}>
          <div style={{ ...styles.title, flex: 1 }}>
            <span style={styles.dot(route.color)} />
            {route.text}
          </div>
          <Button
            variant={live ? 'outline' : 'primary'}
            size="sm"
            disabled={busy || (!live && status.route === 'unavailable')}
            onClick={() => { void run(live ? api.disable : api.enable) }}
          >
            {busy ? 'Working…' : live ? 'Disable' : 'Enable'}
          </Button>
        </div>
        <div style={styles.caption}>
          Publishes this DSH on your tailnet with <code>tailscale serve</code> at {status.mountPath} (HTTPS, port {status.servePort}),
          behind an authenticating proxy{status.proxyUrl === undefined ? '' : ` on ${status.proxyUrl}`}. Only devices on the tailnet can reach it.
        </div>
        {error !== undefined && <div style={styles.error}>{error}</div>}
      </div>

      <div style={styles.group}>
        <div style={styles.title}>Address</div>
        <div style={styles.row}>
          <span style={styles.url}>{status.url ?? '(Tailscale hostname unknown)'}</span>
          <Button variant="outline" size="sm" disabled={status.url === undefined} onClick={() => { void copy() }}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <div style={styles.caption}>Keep the trailing slash: Tailscale strips the mount before forwarding, so the page needs it to find its assets.</div>
      </div>

      <div style={styles.group}>
        <div style={styles.title}>Allowed Tailscale users</div>
        <div style={styles.row}>
          <Input
            style={{ flex: '1 1 260px' }}
            value={users}
            placeholder="alice@example.com, bob@github"
            spellCheck={false}
            autoCapitalize="off"
            onChange={(event) => {
              setUsers(event.currentTarget.value)
              setUsersDirty(true)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void run(saveUsers)
            }}
          />
          <Button variant="outline" size="sm" disabled={busy || !usersDirty} onClick={() => { void run(saveUsers) }}>
            Save
          </Button>
        </div>
        <div style={styles.caption}>
          Comma-separated tailnet logins (as shown by <code>tailscale whois</code>). A device whose verified Tailscale login is listed enters without a token;
          anyone else needs the QR code below. Leave empty to require the QR code for everyone.
        </div>
      </div>

      <div style={styles.group}>
        <div style={styles.title}>QR code (includes the access token)</div>
        <div style={{ ...styles.row, alignItems: 'flex-start' }}>
          {status.qrSvg === undefined
            ? <div style={{ ...styles.qr, display: 'grid', placeItems: 'center', color: '#888', fontSize: 12 }}>unavailable</div>
            : <div style={styles.qr} dangerouslySetInnerHTML={{ __html: status.qrSvg }} />}
          <div style={{ flex: '1 1 220px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={styles.caption}>
              Scanning this code opens <span style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{status.url}?token=…</span> and signs the device in for good,
              whatever its Tailscale user. Treat it like a password: whoever scans it can run commands on this machine.
            </div>
            <div>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => { void run(api.rotateToken) }}>Rotate token</Button>
            </div>
            <div style={styles.caption}>Rotating signs out every device that used the QR code; allowed Tailscale users are unaffected.</div>
          </div>
        </div>
      </div>
    </div>
  )
}

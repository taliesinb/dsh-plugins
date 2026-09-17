/**
 * Browser half of dsh-tailscale-remote: the "Tailscale remote" settings
 * section. English only, by design.
 *
 *   [Enable] / [Disable]          status line
 *   https://node.ts.net/dsh/  [Copy]
 *   Allowed Tailscale users: [alice@example.com, bob@example.com] [Save]
 *   QR code of the URL WITH the standing token (scanning it authenticates
 *   any device, regardless of its Tailscale user) + [Rotate token]
 *   This Mac: your own login is always allowed; Dock app [Install/Reinstall]
 *   (the WKWebView wrapper under ~/Applications) and the relay LaunchAgent
 *   [Install/Remove] that starts DSH when the Dock app is opened cold.
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
  /** This node's own Tailscale login (always admitted); undefined on a tagged node. */
  selfLogin?: string
  mountPath: string
  servePort: number
  /** Port `tailscale serve` targets; 0 = the proxy itself (no relay). Absent on an older host. */
  publishPort?: number
  /** '' for the main install, e.g. 'preview' for a second DSH's remote. */
  instance?: string
  relay?: RelayStatus
  /** Absent on a host half older than this bundle. */
  dockApp?: DockAppStatus
}

export interface RelayStatus {
  supported: boolean
  installed: boolean
  loaded: boolean
  pid?: number
  listening: boolean
  plist: string
  label?: string
  logDir?: string
  command?: string
  spec: { listen: string; backend: string; dsh: string; cwd: string; start: string; logDir: string }
}

export interface DockAppStatus {
  supported: boolean
  name: string
  path: string
  kind: 'none' | 'wrapper' | 'safari-webapp' | 'other'
  url?: string
  current: boolean
  toolchain: boolean
  fallbackUrl: string
}

export interface RemoteApi {
  status(): Promise<RemoteStatus>
  enable(): Promise<RemoteStatus>
  disable(): Promise<RemoteStatus>
  setUsers(list: string): Promise<RemoteStatus>
  rotateToken(): Promise<RemoteStatus>
  installDockApp(): Promise<RemoteStatus>
  uninstallDockApp(): Promise<RemoteStatus>
  installRelay(): Promise<RemoteStatus>
  uninstallRelay(): Promise<RemoteStatus>
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
    installDockApp: () => call('install-dock-app'),
    uninstallDockApp: () => call('uninstall-dock-app'),
    installRelay: () => call('install-relay'),
    uninstallRelay: () => call('uninstall-relay'),
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
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 } as CSSProperties,
  sub: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))' } as CSSProperties,
}

function describeDockApp(dock: DockAppStatus, url: string | undefined): { color: string; text: string; action: 'install' | 'reinstall' | 'replace' | undefined } {
  if (!dock.supported) return { color: 'var(--dsw-alias-label-tertiary)', text: 'Dock app: macOS only', action: undefined }
  if (!dock.toolchain) return { color: '#e5a50a', text: 'Dock app: needs the Xcode Command Line Tools (xcode-select --install)', action: undefined }
  if (dock.kind === 'wrapper' && dock.current) return { color: '#3ba55c', text: `Dock app installed — ${dock.path}`, action: 'reinstall' }
  if (dock.kind === 'wrapper') return { color: '#e5a50a', text: `Dock app points at ${dock.url ?? 'an unknown address'}, not ${url ?? 'the current route'}`, action: 'reinstall' }
  if (dock.kind === 'safari-webapp') return { color: '#e5a50a', text: `${dock.path} is a Safari web app for ${dock.url ?? '?'} — it signs in with a 30-day cookie it cannot renew`, action: 'replace' }
  if (dock.kind === 'other') return { color: '#d0342c', text: `${dock.path} exists and is not a DSH app — change dockAppName or remove it`, action: undefined }
  return { color: 'var(--dsw-alias-label-tertiary)', text: 'Dock app not installed', action: 'install' }
}

function describeRelay(relay: RelayStatus, enabled: boolean): { color: string; text: string } {
  if (!relay.supported) return { color: 'var(--dsw-alias-label-tertiary)', text: 'Relay: macOS only' }
  if (relay.loaded && relay.listening) return { color: '#3ba55c', text: `Relay running (pid ${String(relay.pid ?? '?')}) on ${relay.spec.listen}` }
  if (relay.loaded) return { color: '#e5a50a', text: `Relay LaunchAgent loaded but ${relay.spec.listen} is not answering — see ${relay.logDir ?? ''}/relay.log` }
  if (relay.listening) return { color: '#e5a50a', text: `Something else listens on ${relay.spec.listen} (an older proxy config?) — the relay is not installed` }
  if (relay.installed) return { color: '#e5a50a', text: 'Relay LaunchAgent written but not loaded' }
  return { color: enabled ? '#e5a50a' : 'var(--dsw-alias-label-tertiary)', text: enabled ? `Relay not installed: tailscale serve targets ${relay.spec.listen} but nothing answers there` : 'Relay not installed' }
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

      {status.dockApp !== undefined && <div style={styles.group}>
        <div style={styles.title}>This Mac{status.instance ? ` — ${status.instance} instance` : ''}</div>
        <div style={styles.caption}>
          {status.selfLogin === undefined
            ? 'This node has no Tailscale user (tagged device): its own requests carry no identity, so the Dock app would need the QR token.'
            : <>Your own login <code>{status.selfLogin}</code> is always allowed: requests this Mac makes to {status.url ?? 'the tailnet address'} are signed in by Tailscale itself — no token, no cookie, nothing to expire.</>}
        </div>
        {(() => {
          const dockApp = status.dockApp
          const dock = describeDockApp(dockApp, status.url)
          return (
            <>
              <div style={styles.row}>
                <div style={{ ...styles.sub, flex: 1 }}>
                  <span style={styles.dot(dock.color)} />
                  {dock.text}
                </div>
                {dock.action !== undefined && (
                  <Button variant={dock.action === 'reinstall' ? 'outline' : 'primary'} size="sm" disabled={busy || status.url === undefined} onClick={() => { void run(api.installDockApp) }}>
                    {busy ? 'Working…' : dock.action === 'install' ? 'Install Dock app' : dock.action === 'replace' ? 'Replace with Dock app' : 'Reinstall Dock app'}
                  </Button>
                )}
                {dockApp.kind === 'wrapper' && (
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => { void run(api.uninstallDockApp) }}>Remove</Button>
                )}
              </div>
              <div style={styles.caption}>
                A small native app (<span style={styles.mono}>{dockApp.name}.app</span>, WKWebView) that opens {status.url ?? 'the tailnet address'} and falls back to <span style={styles.mono}>{dockApp.fallbackUrl}</span> with the token when Tailscale is off.
                Links leaving DSH open in your browser. Building it compiles with <span style={styles.mono}>swiftc</span> (a few seconds the first time).
              </div>
            </>
          )
        })()}
        {status.relay !== undefined && (() => {
          const relay = describeRelay(status.relay, status.enabled)
          return (
            <>
              <div style={styles.row}>
                <div style={{ ...styles.sub, flex: 1 }}>
                  <span style={styles.dot(relay.color)} />
                  {relay.text}
                </div>
                <Button variant={status.relay.loaded ? 'outline' : 'primary'} size="sm" disabled={busy} onClick={() => { void run(api.installRelay) }}>
                  {busy ? 'Working…' : status.relay.loaded ? 'Reinstall relay' : 'Install relay'}
                </Button>
                {status.relay.installed && (
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => { void run(api.uninstallRelay) }}>Remove</Button>
                )}
              </div>
              <div style={styles.caption}>
                A LaunchAgent that always answers {status.relay.spec.listen} (what <code>tailscale serve</code> targets) and relays to the proxy on {status.relay.spec.backend}.
                When DSH is not running it runs <span style={styles.mono}>{status.relay.spec.start}</span> in <span style={styles.mono}>{status.relay.spec.cwd}</span> and shows a “starting” page until it answers; logs in <span style={styles.mono}>{status.relay.spec.logDir}</span>.
                Restart both with <span style={styles.mono}>launchctl kickstart -k gui/$UID/{status.relay.label ?? 'io.github.taliesinb.dsh-web-relay'}</span>.
              </div>
            </>
          )
        })()}
      </div>}
    </div>
  )
}

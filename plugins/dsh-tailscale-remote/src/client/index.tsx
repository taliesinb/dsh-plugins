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

export interface ServerAction { id: string; label: string; note: string; danger?: boolean }
export interface ServerProcess {
  id: string
  title: string
  /** One fact per line, shown on hover. */
  details: string[]
  pid?: number
  running: boolean
  uptimeSeconds?: number
  rssKb?: number
  actions: ServerAction[]
}
export interface ServerClient {
  key: string
  login?: string
  address: string
  self: boolean
  proxied: boolean
  admitted: string
  agent: string
  userAgent: string
  firstSeen: number
  lastSeen: number
  requests: number
  sockets: number
  lastPath?: string
  lastSession?: { method: string; sessionId?: string; cwd?: string; workspace?: string; at: number }
}
export interface ServerStatus {
  instance: string
  tracking: boolean
  processes: ServerProcess[]
  clients: ServerClient[]
  now: number
  message?: string
}

export interface RemoteApi {
  status(): Promise<RemoteStatus>
  serverStatus(): Promise<ServerStatus>
  serverAct(target: string, action: string): Promise<ServerStatus>
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
  const raw = async (endpoint: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    let result
    try {
      result = await rpc.call(CHANNEL, endpoint, { args })
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      throw new Error(/HTTP 403/.test(text) ? REMOTE_ONLY_MESSAGE : text)
    }
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  const call = (endpoint: string, args: Record<string, unknown> = {}) => raw(endpoint, args) as Promise<RemoteStatus>
  return {
    status: () => call('status'),
    serverStatus: () => raw('server-status') as Promise<ServerStatus>,
    serverAct: (target, action) => raw('server-act', { target, action }) as Promise<ServerStatus>,
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
  ctx.slots.inject('settings.section', () => {
    const disposers = [
      ctx.slots.register({
        name: 'settings.section',
        id: 'tailscale-remote',
        order: 40,
        label: () => 'Tailscale remote',
        inject: () => ({ api }),
      }, TailscaleRemoteSection),
      ctx.slots.register({
        name: 'settings.section',
        id: 'tailscale-remote-server',
        order: 41,
        label: () => 'Server',
        inject: () => ({ api }),
      }, ServerSection),
    ]
    return () => { for (const dispose of disposers) dispose() }
  })
}

// ---- Server pane ---------------------------------------------------------

function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${String(seconds)}s`
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`
  const hours = Math.floor(seconds / 3600)
  if (hours < 48) return `${String(hours)}h ${String(Math.floor((seconds % 3600) / 60))}m`
  return `${String(Math.floor(hours / 24))}d ${String(hours % 24)}h`
}

const table = {
  table: { width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 12, lineHeight: '18px' } as CSSProperties,
  th: { textAlign: 'left', padding: '4px 6px', color: 'var(--dsw-alias-label-tertiary)', fontWeight: 500, borderBottom: '0.5px solid var(--dsw-alias-border-l2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as CSSProperties,
  td: { padding: '6px 6px', borderBottom: '0.5px solid var(--dsw-alias-border-l1, var(--dsw-alias-border-l2))', verticalAlign: 'middle', color: 'var(--dsw-alias-label-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as CSSProperties,
  muted: { color: 'var(--dsw-alias-label-tertiary)' } as CSSProperties,
  tag: { display: 'inline-block', padding: '0 5px', borderRadius: 6, fontSize: 10, lineHeight: '15px', background: 'var(--dsw-alias-bg-module-platform)', border: '0.5px solid var(--dsw-alias-border-l4)', marginLeft: 6, verticalAlign: '1px' } as CSSProperties,
  iconButton: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, marginLeft: 4, padding: 0,
    borderRadius: 6, border: '0.5px solid var(--dsw-alias-border-l4)', background: 'transparent', color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))', cursor: 'pointer',
  } as CSSProperties,
}

/** Small monochrome glyphs for the process actions. */
function ActionIcon({ id }: { id: string }) {
  const common = { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  switch (id) {
    case 'restart':
    case 'relaunch':
      // circular arrow
      return <svg {...common} aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" /><path d="M13.6 2.6v3h-3" /></svg>
    case 'launch':
      return <svg {...common} aria-hidden="true"><path d="M5 3.5v9l7.5-4.5z" fill="currentColor" stroke="none" /></svg>
    default:
      // stop / quit: square
      return <svg {...common} aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor" stroke="none" /></svg>
  }
}

const ICON_LEGEND: Array<[string, string]> = [['restart', 'restart / relaunch'], ['stop', 'stop / quit'], ['launch', 'launch']]

export function ServerSection({ api }: SectionProps) {
  const [status, setStatus] = useState<ServerStatus | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [message, setMessage] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const alive = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const next = await api.serverStatus()
      if (!alive.current) return
      setStatus(next)
      setError(undefined)
    } catch (caught) {
      if (alive.current) setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [api])

  useEffect(() => {
    alive.current = true
    void refresh()
    const timer = setInterval(() => { void refresh() }, 5000)
    return () => {
      alive.current = false
      clearInterval(timer)
    }
  }, [refresh])

  const act = async (process: ServerProcess, action: ServerAction) => {
    if (action.danger && !window.confirm(`${action.label} ${process.title}?\n\n${action.note}`)) return
    setBusy(`${process.id}/${action.id}`)
    setMessage(undefined)
    try {
      const next = await api.serverAct(process.id, action.id)
      if (!alive.current) return
      setStatus(next)
      setMessage(next.message)
      setError(undefined)
    } catch (caught) {
      if (alive.current) setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (alive.current) setBusy(undefined)
    }
  }

  if (status === undefined) {
    const stale = error !== undefined && /unknown endpoint/.test(error)
    return (
      <div style={styles.section}>
        <div style={styles.group}>
          <div style={styles.title}>Server</div>
          <div style={error === undefined || stale ? styles.caption : styles.error}>
            {stale ? 'The running DSH predates this pane — it appears after the next restart of dsh web.' : error ?? 'Loading…'}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={styles.section}>
      <div style={styles.group}>
        <div style={styles.title}>Processes{status.instance ? ` — ${status.instance} instance` : ''}</div>
        <table style={table.table}>
          <colgroup>
            <col style={{ width: '46%' }} />
            <col style={{ width: '17%' }} />
            <col style={{ width: '13%' }} />
            <col style={{ width: '24%' }} />
          </colgroup>
          <thead>
            <tr>
              <th style={table.th}>Process</th>
              <th style={table.th}>Up</th>
              <th style={table.th}>RSS</th>
              <th style={{ ...table.th, textAlign: 'right' }}>PID</th>
            </tr>
          </thead>
          <tbody>
            {status.processes.map(process => (
              <tr key={process.id}>
                <td style={table.td} title={process.details.join('\n')}>
                  <span style={styles.dot(process.running ? '#3ba55c' : 'var(--dsw-alias-label-tertiary)')} />
                  {process.title}
                </td>
                <td style={table.td}>{process.uptimeSeconds === undefined ? '—' : ago(process.uptimeSeconds * 1000)}</td>
                <td style={table.td}>{process.rssKb === undefined ? '—' : `${String(Math.round(process.rssKb / 1024))} MB`}</td>
                <td style={{ ...table.td, textAlign: 'right' }}>
                  <span style={styles.mono}>{process.pid ?? '—'}</span>
                  {process.actions.map(action => (
                    <button
                      key={action.id}
                      type="button"
                      style={{ ...table.iconButton, opacity: busy !== undefined ? 0.5 : 1 }}
                      disabled={busy !== undefined}
                      title={`${action.label} ${process.title}\n${action.note}`}
                      aria-label={`${action.label} ${process.title}`}
                      onClick={() => { void act(process, action) }}
                    >
                      {busy === `${process.id}/${action.id}` ? '…' : <ActionIcon id={action.id} />}
                    </button>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {message !== undefined && <div style={styles.caption}>{message}</div>}
        {error !== undefined && <div style={styles.error}>{error}</div>}
        <div style={styles.caption}>
          Hover a process name for its details and{' '}
          {ICON_LEGEND.map(([id, meaning]) => (
            <span key={id} title={meaning} style={{ display: 'inline-flex', verticalAlign: 'middle', marginRight: 2 }}><ActionIcon id={id} /></span>
          ))}
          {' '}for what each does. Restarting the relay or dsh web takes this page down briefly; with the relay in front it comes back through the “Starting DSH…” screen.
        </div>
      </div>

      <div style={styles.group}>
        <div style={styles.title}>Clients</div>
        {!status.tracking && <div style={styles.error}>Client tracking unavailable: the web server’s internal http.Server is not reachable in this DSH build.</div>}
        <table style={table.table}>
          <colgroup>
            <col style={{ width: '27%' }} />
            <col style={{ width: '17%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '7%' }} />
            <col style={{ width: '8%' }} />
            <col style={{ width: '10%' }} />
            <col style={{ width: '19%' }} />
          </colgroup>
          <thead>
            <tr>
              <th style={table.th}>Who</th>
              <th style={table.th}>From</th>
              <th style={table.th}>App</th>
              <th style={table.th}>Live</th>
              <th style={table.th}>Req</th>
              <th style={table.th}>Seen</th>
              <th style={table.th}>Viewing</th>
            </tr>
          </thead>
          <tbody>
            {status.clients.length === 0 && (
              <tr><td style={{ ...table.td, ...table.muted }} colSpan={7}>No clients in the last 2 minutes.</td></tr>
            )}
            {status.clients.map(client => (
              <tr key={client.key}>
                <td style={table.td} title={`${client.login ?? client.admitted}${client.self ? ' — this Mac' : ''}\nadmitted by: ${client.admitted}${client.proxied ? ' (through the tailnet proxy)' : ' (direct loopback)'}`}>
                  {client.login ?? <span style={table.muted}>{client.admitted === 'cookie' ? 'QR token' : client.admitted}</span>}
                  {client.self && <span style={table.tag}>this Mac</span>}
                </td>
                <td style={{ ...table.td, ...styles.mono }} title={client.proxied ? 'tailnet address (x-forwarded-for)' : 'direct connection to the loopback port'}>{client.address}</td>
                <td style={table.td} title={client.userAgent}>{client.agent}</td>
                <td style={table.td} title="open GUI WebSockets">{client.sockets > 0 ? <span style={{ color: '#3ba55c' }}>● {client.sockets}</span> : <span style={table.muted}>—</span>}</td>
                <td style={table.td}>{client.requests}</td>
                <td style={table.td}>{ago(status.now - client.lastSeen)}</td>
                <td style={table.td} title={client.lastSession === undefined ? (client.lastPath ?? '') : `${client.lastSession.workspace ?? client.lastSession.cwd ?? ''}\n${client.lastSession.sessionId ?? ''}\n${client.lastSession.method}`}>
                  {client.lastSession === undefined
                    ? <span style={table.muted}>—</span>
                    : (
                        <>
                          {(client.lastSession.workspace ?? client.lastSession.cwd ?? '').split('/').filter(Boolean).pop() ?? ''}
                          {client.lastSession.sessionId !== undefined && <span style={{ ...styles.mono, ...table.muted, marginLeft: 6 }}>{client.lastSession.sessionId.replace(/^session-/, '').slice(0, 8)}</span>}
                        </>
                      )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={styles.caption}>
          Everyone who reached this DSH in the last 2 minutes — tailnet clients through the proxy (Tailscale login, tailnet IP) and direct loopback tabs. Hover a cell for details; “Viewing” is the workspace and session of the last session-related call, not a live cursor.
        </div>
      </div>
    </div>
  )
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

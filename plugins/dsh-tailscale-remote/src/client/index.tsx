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
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

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
  /** One fact per line, shown on hover over the name. */
  details: string[]
  /** Full command line, shown on hover over the PID. */
  command?: string
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

/**
 * In-page hover card (native `title` tooltips do not show inside the
 * WKWebView Dock app). Fixed-positioned so cells with overflow:hidden cannot
 * clip it; opens on hover or keyboard focus.
 */
function Hint({ text, children, style, mono, copyText }: { text: string; children: ReactNode; style?: CSSProperties; mono?: boolean; copyText?: string }) {
  const [anchor, setAnchor] = useState<{ left: number; top: number; bottom: number } | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  const [placed, setPlaced] = useState<{ left: number; top: number } | undefined>(undefined)
  const card = useRef<HTMLDivElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const show = (event: { currentTarget: Element }) => {
    const rect = event.currentTarget.getBoundingClientRect()
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setAnchor({ left: rect.left, top: rect.top, bottom: rect.bottom }), 150)
  }
  const hide = () => {
    clearTimeout(timer.current)
    setAnchor(undefined)
    setPlaced(undefined)
  }
  // Measure, then keep the card inside the viewport: below the anchor when it
  // fits, above it otherwise, and never past the right edge.
  useLayoutEffect(() => {
    const element = card.current
    if (anchor === undefined || element === null) return
    const { width, height } = element.getBoundingClientRect()
    const margin = 8
    const below = anchor.bottom + 6
    const top = below + height <= window.innerHeight - margin
      ? below
      : Math.max(margin, anchor.top - 6 - height)
    const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - margin - width))
    setPlaced({ left, top })
  }, [anchor, text])
  const trimmed = text.trim()
  const copy = async () => {
    const ok = await writeClipboard(copyText ?? trimmed)
    setCopied(ok)
    setTimeout(() => setCopied(false), 1200)
  }
  return (
    <span
      style={{ display: 'inline-block', maxWidth: '100%', verticalAlign: 'bottom', cursor: trimmed === '' ? undefined : 'copy', ...style }}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onClick={(event) => { if (trimmed !== '') { event.stopPropagation(); void copy() } }}
      tabIndex={trimmed === '' ? undefined : 0}
    >
      {children}
      {anchor !== undefined && trimmed !== '' && (
        <div
          ref={card}
          role="tooltip"
          style={{
            position: 'fixed', left: placed?.left ?? anchor.left, top: placed?.top ?? anchor.bottom + 6, zIndex: 10000,
            visibility: placed === undefined ? 'hidden' : 'visible',
            maxWidth: mono ? 560 : 360, padding: '8px 11px', borderRadius: 10, whiteSpace: 'pre-wrap', overflowWrap: mono ? 'normal' : 'anywhere',
            font: mono ? '11px/16px ui-monospace, SFMono-Regular, Menlo, monospace' : '12px/17px -apple-system, system-ui, sans-serif',
            color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))',
            background: 'var(--dsw-alias-bg-module-float, var(--dsw-alias-bg-module-platform, #2a2a2c))', border: '0.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l4))',
            boxShadow: '0 8px 28px rgba(0,0,0,.28), 0 1px 3px rgba(0,0,0,.2)', pointerEvents: 'none',
          }}
        >
          {trimmed}
          <div style={{ marginTop: 6, font: '11px/14px -apple-system, system-ui, sans-serif', color: 'var(--dsw-alias-label-tertiary)' }}>{copied ? 'Copied' : 'Click to copy'}</div>
        </div>
      )}
    </span>
  )
}

/**
 * A `ps` command line as display lines: the binary on its own first line
 * (path components joined by spaces stay together), then one argument per
 * line with its value (`--listen 127.0.0.1:3085`); a new path starts a new
 * line. Only ever splits on spaces.
 */
export function commandLines(command: string): string[] {
  const tokens = command.trim().split(' ').filter(Boolean)
  const lines: string[] = []
  for (const [index, token] of tokens.entries()) {
    const last = lines[lines.length - 1]
    if (index === 0 || last === undefined) lines.push(token)
    else if (token.startsWith('-')) lines.push(token)
    else if (/^--?[\w-]+$/.test(last)) lines[lines.length - 1] = `${last} ${token}`
    else if (token.startsWith('/') || token.startsWith('~')) lines.push(token)
    else lines[lines.length - 1] = `${last} ${token}`
  }
  return lines
}

/** Small circled "i" whose hover card shows `lines` (empty strings become blank lines). */
function Info({ lines, mono, copyText, gap = 'paragraph' }: { lines: Array<string | undefined>; mono?: boolean; copyText?: string; gap?: 'paragraph' | 'line' }) {
  const text = lines.filter((line): line is string => line !== undefined && line !== '').join(gap === 'paragraph' ? '\n\n' : '\n').trim()
  return (
    <Hint text={text} mono={mono} copyText={copyText} style={{ marginLeft: 6, verticalAlign: '-2px' }}>
      <span aria-label={text} style={{ display: 'inline-flex', color: 'var(--dsw-alias-label-tertiary)', cursor: 'help' }}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
          <circle cx="8" cy="8" r="6.3" />
          <path d="M8 7.2v4" strokeLinecap="round" />
          <circle cx="8" cy="4.9" r="0.75" fill="currentColor" stroke="none" />
        </svg>
      </span>
    </Hint>
  )
}

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
        <div style={styles.title}>
          Processes{status.instance ? ` — ${status.instance} instance` : ''}
          <Info lines={[
            'The pieces of this DSH instance and the actions that apply to each: ↻ restart or relaunch, ■ stop or quit, ▶ launch. Hover an icon for what exactly it does.',
            'Restarting the relay or dsh web takes this page down briefly; with the relay in front it comes back through the “Starting DSH…” screen.',
            'ⓘ after a name shows its details; ⓘ after a PID shows the full command line. Clicking any ⓘ copies its text.',
          ]} />
        </div>
        <table style={table.table}>
          <colgroup>
            <col style={{ width: '34%' }} />
            <col style={{ width: 70 }} />
            <col style={{ width: '16%' }} />
            <col style={{ width: '13%' }} />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th style={table.th}>Process</th>
              <th style={table.th}>PID</th>
              <th style={table.th}>Uptime</th>
              <th style={table.th}>RSS</th>
              <th style={{ ...table.th, textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {status.processes.map(process => (
              <tr key={process.id}>
                <td style={table.td}>
                  <span style={styles.dot(process.running ? '#3ba55c' : 'var(--dsw-alias-label-tertiary)')} />
                  {process.title}
                  <Info lines={process.details} gap="line" />
                </td>
                <td style={{ ...table.td, ...styles.mono }}>
                  {process.pid ?? '—'}
                  {process.command !== undefined && <Info lines={commandLines(process.command)} mono copyText={process.command} gap="line" />}
                </td>
                <td style={table.td}>{process.uptimeSeconds === undefined ? '—' : ago(process.uptimeSeconds * 1000)}</td>
                <td style={table.td}>{process.rssKb === undefined ? '—' : `${String(Math.round(process.rssKb / 1024))} MB`}</td>
                <td style={{ ...table.td, textAlign: 'right' }}>
                  {process.actions.map(action => (
                    <Hint key={action.id} text={`${action.label} ${process.title}\n${action.note}`}>
                      <button
                        type="button"
                        style={{ ...table.iconButton, opacity: busy !== undefined ? 0.5 : 1 }}
                        disabled={busy !== undefined}
                        aria-label={`${action.label} ${process.title}`}
                        onClick={() => { void act(process, action) }}
                      >
                        {busy === `${process.id}/${action.id}` ? '…' : <ActionIcon id={action.id} />}
                      </button>
                    </Hint>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {message !== undefined && <div style={styles.caption}>{message}</div>}
        {error !== undefined && <div style={styles.error}>{error}</div>}
      </div>

      <div style={styles.group}>
        <div style={styles.title}>
          Clients
          <Info lines={[
            'Everyone who reached this DSH in the last 2 minutes: tailnet clients through the proxy (Tailscale login and tailnet IP) and direct loopback tabs.',
            '“Live” counts open GUI WebSockets. “Viewing” is the workspace and session of the last session-related call, not a live cursor.',
            'Hover a cell for details.',
          ]} />
        </div>
        {!status.tracking && <div style={styles.error}>Client tracking unavailable: the web server’s internal http.Server is not reachable in this DSH build.</div>}
        <table style={table.table}>
          <colgroup>
            <col style={{ width: '18%' }} />
            <col style={{ width: 118 }} />
            <col style={{ width: '13%' }} />
            <col style={{ width: '8%' }} />
            <col style={{ width: '8%' }} />
            <col style={{ width: '10%' }} />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th style={table.th}>User</th>
              <th style={table.th}>IP</th>
              <th style={table.th}>Via</th>
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
                <td style={table.td}>
                  <Hint text={`${client.login ?? client.admitted}${client.self ? ' — this Mac' : ''}\nadmitted by: ${client.admitted}${client.proxied ? ' (through the tailnet proxy)' : ' (direct loopback)'}`}>
                    {client.login === undefined
                      ? <span style={table.muted}>{client.admitted === 'cookie' ? 'QR token' : client.admitted}</span>
                      : client.login.replace(/@.*$/, '')}
                    {client.self && <span style={table.tag}>this Mac</span>}
                  </Hint>
                </td>
                <td style={{ ...table.td, ...styles.mono, fontSize: 11, letterSpacing: '-0.03em', overflow: 'visible', textOverflow: 'clip' }} title={client.proxied ? 'tailnet address (x-forwarded-for)' : 'direct connection to the loopback port'}>{client.address}</td>
                <td style={table.td}><Hint text={client.userAgent}>{client.agent === '—' ? <span style={table.muted}>—</span> : client.agent}</Hint></td>
                <td style={table.td} title="open GUI WebSockets">{client.sockets > 0 ? <span style={{ color: '#3ba55c' }}>● {client.sockets}</span> : <span style={table.muted}>—</span>}</td>
                <td style={table.td}>{client.requests}</td>
                <td style={table.td}>{ago(status.now - client.lastSeen)}</td>
                <td style={table.td}>
                  <Hint text={client.lastSession === undefined ? (client.lastPath ?? '') : `${client.lastSession.workspace ?? client.lastSession.cwd ?? ''}\n${client.lastSession.sessionId ?? ''}\n${client.lastSession.method}`}>
                    {client.lastSession === undefined
                      ? <span style={table.muted}>—</span>
                      : (
                          <>
                            {(client.lastSession.workspace ?? client.lastSession.cwd ?? '').split('/').filter(Boolean).pop() ?? ''}
                            {client.lastSession.sessionId !== undefined && <span style={{ ...styles.mono, ...table.muted, marginLeft: 6 }}>{client.lastSession.sessionId.replace(/^session-/, '').slice(0, 8)}</span>}
                          </>
                        )}
                  </Hint>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

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
  if (status.route === 'active' && status.proxyRunning) return { color: '#3ba55c', text: 'Enabled' }
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
    if (!usersDirty) setUsers(next.allowedUsers.length > 0 ? next.allowedUsers.join(', ') : (next.selfLogin ?? ''))
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
      {status.dockApp !== undefined && <div style={styles.group}>
        <div style={styles.title}>
          Services{status.instance ? ` — ${status.instance} instance` : ''}
          <Info lines={status.selfLogin === undefined
            ? ['This node has no Tailscale user (tagged device): its own requests carry no identity, so the macOS app would need the QR token.']
            : [`Requests this Mac makes to ${status.url ?? 'the tailnet address'} are signed in by Tailscale itself as ${status.selfLogin} — no token, no cookie, nothing to expire.`, 'That is how the macOS app and Safari on this Mac get in.']} />
        </div>
        <div style={styles.row}>
          <div style={{ ...styles.sub, flex: 1 }}>
            <span style={styles.dot(route.color)} />
            Tailscale serve: {live ? 'installed'
              : status.route === 'active' ? 'route published, proxy down'
                : status.route === 'conflict' ? 'conflict'
                  : status.route === 'unavailable' ? 'Tailscale unavailable'
                    : status.enabled ? 'enabled, route off' : 'not installed'}
            <Info lines={[
              route.text,
              `Publishes this DSH on your tailnet with tailscale serve at ${status.mountPath} (HTTPS, port ${String(status.servePort)}), behind an authenticating proxy${status.proxyUrl === undefined ? '' : ` on ${status.proxyUrl}`}.`,
              'Only devices on the tailnet can reach it.',
            ]} />
          </div>
          <Button
            variant={live ? 'outline' : 'primary'}
            size="sm"
            disabled={busy || (!live && status.route === 'unavailable')}
            onClick={() => { void run(live ? api.disable : api.enable) }}
          >
            {busy ? 'Working…' : live ? 'Uninstall' : 'Install'}
          </Button>
        </div>
        {error !== undefined && <div style={styles.error}>{error}</div>}
        {status.relay !== undefined && (() => {
          const relay = status.relay
          const described = describeRelay(relay, status.enabled)
          const state = relay.loaded && relay.listening ? 'running'
            : relay.loaded ? 'loaded, not answering'
              : relay.listening ? 'port taken by something else'
                : relay.installed ? 'installed, not loaded'
                  : 'not installed'
          return (
            <div style={styles.row}>
              <div style={{ ...styles.sub, flex: 1 }}>
                <span style={styles.dot(described.color)} />
                relay: {state}
                <Info lines={[
                  described.text,
                  '',
                  `LaunchAgent ${relay.label ?? ''}: always answers ${relay.spec.listen} (what tailscale serve targets) and relays to the proxy on ${relay.spec.backend}.`,
                  `When DSH is down it runs “${relay.spec.start}” in ${relay.spec.cwd} and shows a “Starting DSH…” page until it answers.`,
                  `Logs: ${relay.spec.logDir}`,
                  'Restart or stop it from the Server pane.',
                ]} />
              </div>
              <Button variant={relay.loaded ? 'outline' : 'primary'} size="sm" disabled={busy} onClick={() => { void run(api.installRelay) }}>
                {busy ? 'Working…' : relay.loaded ? 'Reinstall' : 'Install'}
              </Button>
              {relay.installed && (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => { void run(api.uninstallRelay) }}>Uninstall</Button>
              )}
            </div>
          )
        })()}
        {(() => {
          const dockApp = status.dockApp
          const dock = describeDockApp(dockApp, status.url)
          const state = dock.action === undefined && !dockApp.toolchain ? 'needs Xcode Command Line Tools'
            : dockApp.kind === 'wrapper' && dockApp.current ? 'installed'
              : dockApp.kind === 'wrapper' ? 'installed, points elsewhere'
                : dockApp.kind === 'safari-webapp' ? 'Safari web app (replace)'
                  : dockApp.kind === 'other' ? 'blocked by another app'
                    : 'not installed'
          return (
            <div style={styles.row}>
              <div style={{ ...styles.sub, flex: 1 }}>
                <span style={styles.dot(dock.color)} />
                macOS app: {state}
                <Info lines={[
                  dockApp.path,
                  `opens ${status.url ?? '(tailnet address unknown)'}`,
                  `falls back to ${dockApp.fallbackUrl} + token when Tailscale is off`,
                  dockApp.kind === 'wrapper' && !dockApp.current ? `currently points at ${dockApp.url ?? '?'} — reinstall` : '',
                  dockApp.kind === 'safari-webapp' ? `currently a Safari web app for ${dockApp.url ?? '?'} (30-day cookie it cannot renew)` : '',
                  dockApp.kind === 'other' ? 'something else sits at that path: change dockAppName or remove it' : '',
                  '',
                  `A small native WKWebView app — no Safari, no permissions. Links leaving DSH open in your browser. Built with swiftc, a few seconds the first time${dockApp.toolchain ? '' : ' (install the Xcode Command Line Tools first)'}.`,
                  'Quit or relaunch it from the Server pane.',
                ]} />
              </div>
              {dock.action !== undefined && (
                <Button variant={dock.action === 'reinstall' ? 'outline' : 'primary'} size="sm" disabled={busy || status.url === undefined} onClick={() => { void run(api.installDockApp) }}>
                  {busy ? 'Working…' : dock.action === 'install' ? 'Install' : dock.action === 'replace' ? 'Replace' : 'Reinstall'}
                </Button>
              )}
              {dockApp.kind === 'wrapper' && (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => { void run(api.uninstallDockApp) }}>Uninstall</Button>
              )}
            </div>
          )
        })()}
      </div>}
      <div style={styles.group}>
        <div style={styles.row}>
          <div style={{ ...styles.title, flex: 1 }}>
            Address
            <Info lines={['Keep the trailing slash: Tailscale strips the mount before forwarding, so the page needs it to find its assets.']} />
          </div>
          <Button variant="outline" size="sm" disabled={status.url === undefined} onClick={() => { void copy() }}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <span style={{ ...styles.url, flex: 'none', display: 'block' }}>{status.url ?? '(Tailscale hostname unknown)'}</span>
      </div>

      <div style={styles.group}>
        <div style={styles.title}>
          Allowed Tailscale users
          <Info lines={[
            'Comma-separated tailnet logins, as shown by tailscale whois.',
            'A device whose verified Tailscale login is listed enters without a token; anyone else needs the QR code below.',
            status.selfLogin === undefined ? '' : `Your own login (${status.selfLogin}) is always allowed, listed or not.`,
          ]} />
        </div>
        <div style={{ ...styles.row, flexWrap: 'nowrap' }}>
          <Input
            style={{ flex: '1 1 auto', minWidth: 0 }}
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
      </div>

      <div style={styles.group}>
        <div style={styles.row}>
          <div style={{ ...styles.title, flex: 1 }}>
            QR code
            <Info lines={[
              'The code includes the standing access token: scanning it signs the device in for good, whatever its Tailscale user.',
              'Treat it like a password — whoever scans it can run commands on this machine.',
              'Rotate signs out every device that used the code; allowed Tailscale users are unaffected.',
            ]} />
          </div>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { void run(api.rotateToken) }}>Rotate</Button>
        </div>
        {status.qrSvg === undefined
          ? <div style={{ ...styles.qr, display: 'grid', placeItems: 'center', color: '#888', fontSize: 12 }}>unavailable</div>
          : <div style={styles.qr} dangerouslySetInnerHTML={{ __html: status.qrSvg }} />}
      </div>

    </div>
  )
}

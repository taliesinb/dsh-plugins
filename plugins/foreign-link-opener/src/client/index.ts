/**
 * tali-foreign-link-opener — browser half.
 *
 * Installs one capture-phase click listener on `document` and a thin wrapper
 * around `window.open`. A click on an <a href> whose URL is http(s) and whose
 * server is not this one is prevented and handed to the host route
 * GET /api/foreign-links/open?url=… (index.js), which runs `open -a Safari`.
 * Same-origin links, non-http schemes (dsh:, mailto:, …), alt-clicks (Safari's
 * "download linked file"), <a download>, and clicks another handler already
 * prevented are untouched; propagation is never stopped, so React handlers on
 * the anchor still run.
 *
 * Activation (`when` from the host config):
 *   auto    – only when the GUI runs as an installed web app: any display-mode
 *             other than `browser`, or Safari's `navigator.standalone`. In a
 *             normal tab a target=_blank link already opens a new Safari tab,
 *             so nothing needs doing there.
 *   always  – every foreign link (lets a normal tab exercise the path).
 *   never   – inert.
 * plus `loopbackOnly`: the GUI's own hostname must be a loopback alias, so a
 * phone reaching DSH through the reverse proxy never opens Safari on the Mac.
 *
 * If the host refuses or fails, the click falls back to the browser's own
 * window.open so the link is never swallowed.
 */
import type { Context } from '@deepseek-ai/cordis'

/** Mirrors index.js. */
// Document-relative (`./api/...`), not root-relative: behind a path-mounting
// proxy (dsh-tailscale-remote at `/dsh/`) `/api` would escape the mount.
const CONFIG_PATH = './api/foreign-links/config'
const OPEN_PATH = './api/foreign-links/open'
const REQUEST_HEADER = 'x-dsh-foreign-links'

interface ClientConfig {
  when: 'auto' | 'always' | 'never'
  loopbackOnly: boolean
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0'])

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost')
}

/** The port the URL actually addresses (the URL API blanks the default port). */
function effectivePort(url: URL): string {
  if (url.port !== '') return url.port
  return url.protocol === 'https:' ? '443' : '80'
}

/**
 * True when `url` is served by a different server than the GUI. Loopback
 * aliases of the same protocol+port (localhost vs 127.0.0.1) are the same
 * server; only http(s) is ever foreign.
 */
export function isForeign(url: URL, here: URL = new URL(window.location.href)): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.origin === here.origin) return false
  if (isLoopbackHost(url.hostname) && isLoopbackHost(here.hostname)
    && url.protocol === here.protocol && effectivePort(url) === effectivePort(here)) return false
  return true
}

/** Installed web app (Dock / Home Screen), as opposed to a browser tab. */
function isInstalledWebApp(): boolean {
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone
  if (standalone === true) return true
  if (typeof window.matchMedia !== 'function') return false
  // display-mode is the manifest `display` the UA actually applied; `browser`
  // is a tab. DSH's manifest asks for `fullscreen`, Safari renders `standalone`.
  return !window.matchMedia('(display-mode: browser)').matches
}

function shouldActivate(config: ClientConfig): boolean {
  if (config.when === 'never') return false
  if (config.loopbackOnly && !isLoopbackHost(window.location.hostname)) return false
  if (config.when === 'always') return true
  return isInstalledWebApp()
}

/** The anchor a click landed on, through shadow roots and inline children. */
function anchorOf(event: MouseEvent): HTMLAnchorElement | undefined {
  for (const node of event.composedPath()) {
    if (node instanceof HTMLAnchorElement) return node
  }
  return undefined
}

async function openViaHost(href: string): Promise<boolean> {
  try {
    const response = await fetch(`${OPEN_PATH}?url=${encodeURIComponent(href)}`, {
      credentials: 'same-origin',
      headers: { [REQUEST_HEADER]: '1' },
    })
    return response.ok
  } catch {
    return false
  }
}

async function loadConfig(): Promise<ClientConfig> {
  const fallback: ClientConfig = { when: 'auto', loopbackOnly: true }
  try {
    const response = await fetch(CONFIG_PATH, { credentials: 'same-origin' })
    if (!response.ok) return fallback
    const body = (await response.json()) as Partial<ClientConfig>
    return {
      when: body.when === 'always' || body.when === 'never' ? body.when : 'auto',
      loopbackOnly: body.loopbackOnly !== false,
    }
  } catch {
    return fallback
  }
}

export const name = 'foreign-link-opener-client'
export const inject: string[] = []

export function apply(ctx: Context): void {
  let disposed = false
  ctx.effect(() => () => { disposed = true }, 'foreign-link-opener: lifetime')

  void loadConfig().then((config) => {
    if (disposed) return
    if (!shouldActivate(config)) {
      console.info(`[foreign-link-opener] inactive (when=${config.when}, installed=${String(isInstalledWebApp())}, host=${window.location.hostname})`)
      return
    }
    console.info('[foreign-link-opener] active: foreign http(s) links open in the system browser')

    const nativeOpen = window.open.bind(window)

    const handOff = (href: string): void => {
      void openViaHost(href).then((opened) => {
        // Never swallow a link: on failure let the UA do what it would have.
        if (!opened) nativeOpen(href, '_blank', 'noopener')
      })
    }

    const onClick = (event: MouseEvent): void => {
      if (event.defaultPrevented || event.button !== 0 || event.altKey) return
      const anchor = anchorOf(event)
      if (anchor === undefined || anchor.hasAttribute('download')) return
      const href = anchor.href
      if (href === '') return
      let url: URL
      try { url = new URL(href) } catch { return }
      if (!isForeign(url)) return
      event.preventDefault()
      handOff(url.href)
    }

    ctx.effect(() => {
      document.addEventListener('click', onClick, true)
      return () => document.removeEventListener('click', onClick, true)
    }, 'foreign-link-opener: click capture')

    // window.open() always stays inside a Safari web app, scope or not.
    ctx.effect(() => {
      const wrapped: typeof window.open = (url?: string | URL, target?: string, features?: string) => {
        if (url !== undefined && url !== '') {
          try {
            const resolved = new URL(String(url), window.location.href)
            if (isForeign(resolved)) {
              handOff(resolved.href)
              return null
            }
          } catch { /* not a URL: native behaviour */ }
        }
        return nativeOpen(url, target, features)
      }
      window.open = wrapped
      return () => { if (window.open === wrapped) window.open = nativeOpen }
    }, 'foreign-link-opener: window.open')
  })
}

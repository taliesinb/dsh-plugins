# Foreign links from the Dock-installed DSH web app → real Safari

**Plugin:** `~/github/tali-dash-plugins/plugins/foreign-link-opener`
(package `tali-foreign-link-opener`, host + client halves). The README there
owns the plugin; this recipe owns the system-level story.

## The pathology

`dsh web` serves `/manifest.webmanifest` (`apps/web/public/manifest.webmanifest`
in the checkout: `scope: "/"`, `display: "fullscreen"`), so Safari ▸ File ▸
**Add to Dock…** turns the GUI into a standalone macOS web app. In that app,
clicking a link to a server an agent started on *another port*
(`http://localhost:5173`, `http://127.0.0.1:8000`, …) opens a **new
DSH-branded window** instead of a Safari tab.

Root cause (Apple, [WWDC23 "What's new in web apps"](https://wwdc-quick-look.swiftgg.team/en/articles/wwdc2023-10120/)):

- Safari routes a link by the web app's **scope**; links in scope stay in the
  app, links out of scope go to the default browser.
- The default scope is the **host** of the installing page. The **port is not
  part of it**, so `127.0.0.1:5173` is in scope for an app installed from
  `127.0.0.1:3080`.
- The manifest `scope` field can only *narrow* to a path prefix on the same
  host — it cannot say "other ports are foreign". `id` only distinguishes apps.
- `window.open()` **always** stays inside the web app, scope or not.

So no manifest tweak fixes it; the GUI itself has to hand such links to the
OS. Note the live GUI is reached at `127.0.0.1:3080` while agents often print
`localhost:<port>` — both are loopback, both in scope.

## The fix

Client-side interception + a host route that shells out to `open`:

1. Browser half: capture-phase `click` listener on `document` and a
   `window.open` wrapper. A link is *foreign* when it is http(s) and neither
   same-origin nor a loopback alias of the same protocol+port. Foreign →
   `preventDefault()` and `GET /api/foreign-links/open?url=…` with header
   `x-dsh-foreign-links: 1`; on failure fall back to native `window.open`.
2. Host half: `ctx.connection.fetch.register` (GET/HEAD only — the API
   offers no POST; the header requirement and the `SameSite=Strict` auth
   cookie make the side-effecting GET safe) → `execFile('/usr/bin/open',
   ['-a', app, url])`.
3. Active only when running as an installed web app (`navigator.standalone`
   or `display-mode` ≠ `browser`) and served from a loopback host — a phone
   through the reverse proxy must never open Safari on the Mac. `when: always`
   exists for testing in a normal tab.

Client↔host plumbing pattern copied from `wolfram-kernel-supervisor`'s
`/api/wolfram/open` route; bundle format/build from its `build.mjs`.

## Install

Verified in isolation first (see README "Build / test"): throwaway
`DSH_HOME`, port 3083, `when: always`, python `http.server` on 3084 as the
foreign target — the click was prevented, the trace file logged the open, and
Safari showed a `127.0.0.1:3084` tab.

Live profile row (`~/.dsh/profiles/web/cordis.patch.yml`, inside the top
`- insert:` list; **patchReload is live — saving applies immediately**):

```yaml
    # Dock-installed web app: links leaving the DSH server (other ports/hosts)
    # open in real Safari instead of a new DSH window. Safari's web-app scope is
    # host-only, so a manifest cannot express this.
    # Source: ~/github/tali-dash-plugins/plugins/foreign-link-opener
    # Recipe: ~/projects/deepseek-harness/foreign-link-opener-plugin.md
    - id: tali-foreign-link-opener
      name: '/Users/tali/github/tali-dash-plugins/plugins/foreign-link-opener/index.js'
      config:
        app: /Applications/Safari.app
        when: auto
        loopbackOnly: true
```

The Dock app needs a **reload** (⌘R) after the row lands so the new client
bundle boots; the boot graph is injected per index render.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Links still open a DSH window | Console says `[foreign-link-opener] inactive (installed=false …)`: Safari's web app reports `display-mode: browser` and no `navigator.standalone`. Set `when: always` (harmless in tabs: Safari opens the link in Safari anyway). |
| `inactive (… host=<domain>)` | `loopbackOnly` refused a non-loopback GUI host (e.g. the cloudflared URL). Intended. |
| Route answers 403 `missing request header` | Something other than the plugin's client hit the open route; the header is mandatory by design. |
| 401 `unauthorized` from curl | Fetch routes sit behind the browser auth cookie; use the tokened URL with a cookie jar. |
| `pnpm install` prints `ERR_PNPM_IGNORED_BUILDS: esbuild` | Harmless here — the esbuild binary still resolves and `pnpm build` succeeds; `pnpm approve-builds` silences it. |
| Plugin loads but no routes | `inject = ['connection']`; if the host lacks that service the plugin waits in PENDING silently. |
| Linux/other host | Plugin logs "inert on this platform" — the pathology is macOS-Safari-only. |

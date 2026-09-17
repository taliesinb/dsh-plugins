# Tailscale remote for DSH at `https://<node>/dsh/` (dsh-tailscale-remote + DSH patch)

Phone/laptop control of the DSH Web GUI over the tailnet at a **path mount**
(`https://tali-macbook-air.tailbce956.ts.net/dsh/`) with the from-scratch
plugin `plugins/dsh-tailscale-remote` and the DSH branch
`fix/tailscale-mounting`. Written 2026-09-16 against DSH `0.1.2-rc.1`
(`master` = `76fda72979`), tailscale `1.102.3`, macOS. Supersedes the Tailscale
route feature of the `dsh-full-remote` fork described in
[`cloudflare-remote-control.md`](cloudflare-remote-control.md) — that fork
stays as reference; this is the one-feature replacement.

> **2026-09-17 update** — see [`dock-app-via-tailnet.md`](dock-app-via-tailnet.md):
> the proxy now listens on **3084** and `tailscale serve /dsh` targets the
> always-on relay on **3083** (`publishPort`); this node's own login is
> admitted implicitly (no allowlist entry needed) and a WKWebView Dock app
> replaces Safari's web app. The "No `Tailscale-User-*` for a self-probe"
> fact below was observed while the node was *tagged*; untagged, Serve does
> inject the node's own login for its requests to itself.

## Why a from-scratch plugin and a DSH patch

- `dsh-full-remote` (fork `~/github/dsh-full-remote`, branch `tali/main`) grew
  a Tailscale route, but it carries tunnels, invites, device approval, audit
  log, i18n, CIDR allowlists, gzip… The only feature wanted is Tailscale, so
  `dsh-tailscale-remote` reimplements just that: proxy + `tailscale serve`
  route + settings section (Enable/Disable, URL + copy, allowed users, QR
  with the token). ~600 lines of host code, 16 tests.
- The fork's route was **port-based** (`http://tbwork/`) because a `/dsh`
  path mount was "not viable": tailscaled strips the mount prefix before
  proxying and DSH hard-coded `/api`, `/assets`, WebSocket and `/plugins`
  URLs at the origin. The user wants `/dsh`, so the DSH side was fixed
  instead — **not** with a configurable prefix (DSH never sees the prefix:
  Tailscale strips it, and `/dsh` vs `/dsh/` are indistinguishable at the
  backend) but by making every URL the shell computes **document-relative**.
  One build then serves both `http://127.0.0.1:3080/` and `/dsh/`.

## The DSH patch: branch `fix/tailscale-mounting`

Worktree `~/github/deepseek-harness-tailscale` (created with
`git worktree add -b fix/tailscale-mounting ../deepseek-harness-tailscale master`
from `~/github/deepseek-harness`, whose own checkout stays on
`fix/safari-dock-app-gap` and runs the live GUI).

**Rebased 2026-09-16 onto upstream** (`upstream` remote =
`deepseek-ai/deepseek-harness`, added to the fork clone; `master` fast-forwarded
2196 commits from `76fda72979` to `0d1f50007f` and pushed to `origin`). Branch
shape now: `master` → `0b0c8a5f8e` (the safari scroll-pin commit, cherry-picked;
its `boot.ts` import hunk conflicted because upstream moved `STATE_LABELS` to
`boot-client.ts`) → `1c80583ba3` (this patch; `tsconfig.client.json` conflicted
because upstream deleted `src/client/fixture.ts`). `fix/safari-dock-app-gap`
itself was **not** moved: git refuses to force a branch that is checked out in
another worktree, and rebasing it in place would swap source (and later
node_modules) under the live server. When the live server is next stopped,
`git rebase master fix/safari-dock-app-gap` yields exactly `0b0c8a5f8e`'s
content.

Upstream review before rebasing: no commit in those two weeks touches the
anchoring points (`<base href="/">`, `resolveBase()`, the WebSocket URL, the
HMR `EventSource`, `el.src`), no `basePath`/`X-Forwarded-Prefix` support
exists, and discussion **#4966** (2026-08-30, "all client RPC calls fail
silently behind a path-prefix reverse proxy") describes exactly this problem:
the community workaround rewrites `/api` strings inside the bundles and then
trips `CHANNEL_PATTERN` on `/dsh/api`. The document-relative approach needs
no bundle rewriting and leaves the channel `/api`. #3210/#3211 (proxy-attested
identity for privileged RPCs) are orthogonal. `pnpm install --offline` no
longer suffices after the rebase (new deps); online install + `pnpm run build`
(~100 s) and the GUI lanes (432 files / 6343 tests) are green. **Why a worktree:** the live
`dsh web` serves `apps/web/dist` and every `packages/*/lib/client.js` from
disk, and the HMR watcher hot-swaps rebuilt bundles into the open GUI —
rebuilding `client-connection` in the live checkout would have swapped the
transport out from under the session doing the work. `pnpm install --offline`
in the worktree took 6 s (shared store); `pnpm run build` ~50 s.

Commit `29c3f38d2a` "fix(web): resolve Host URLs relative to the served
document, not the origin". What was root-anchored and what it became:

| Where | Before | After |
|---|---|---|
| `packages/client/connection/src/client/rpc.ts` | `new URL('/api/x', location.origin)` | `hostUrl('/api/x')` → `new URL('./api/x', <document dir>)` |
| `packages/client/connection/src/client/host-base.ts` (new) | — | `hostBaseUrl()`: directory of `document.baseURI` when same-origin; origin root in a Worker (its `location` is the script URL); `http://dsh.internal/` without a location. `hostUrl(path)` |
| `packages/api/gateway/src/client/stream-client.ts` | WebSocket `new URL('/api/remote.mux', origin)` | document-relative (local copy of the helper — the **bundle purity gate** rejects a value import of `@deepseek-ai/dsh-client-connection/client` from the gateway; `INLINE_SAFE` in `packages/client/tsdown.client.ts`) |
| `packages/client/modules/src/client/system.ts` | `<script src="/plugins/??…">` from the loader | `documentRelativeUrl(url)` → `./plugins/??…` resolved against `document.baseURI` |
| `packages/host/webserver/src/injections.ts` | `script-src` / `script-preload` rows rendered verbatim | root-relative `src` rendered `./…` (graph rows themselves unchanged — sourcemap `sourceMappingURL`s inside combo scripts stay root-relative; devtools-only degradation under a mount) |
| `packages/client/hmr/src/client/index.ts` | `new EventSource('/plugins/events')` | `new EventSource(new URL('./plugins/events', document.baseURI))` |
| `packages/host/frontend-static/src/index.ts` | injected `<base href="/">` into every index | removed — the index is only served at a directory or as `/index.html`, and the dist is built with Vite `base: './'` |
| `packages/client/connection/src/browser-auth.ts` | 303 `Location: /` after `?token=` | `Location: ./` |
| `packages/session-query/session-log-export/src/client/controller.ts` | `/api/session.export` at origin | document-relative |
| `apps/web/public/manifest.webmanifest` | `"/"` start_url/scope/icon | `"./"` |

Facts that shaped it:

- **Vite already used `base: './'`** — the built `index.html` references
  `./assets/…`; only JS-built URLs and the injected `<base>` were the problem.
- The client has **no pathname routing** (no `pushState` anywhere in
  `packages/client`), so "the document's directory" is always the mount.
- New client source files must be listed in the package's
  `tsconfig.client.json` `files` array (TS6307 otherwise); the first
  `build:lib:host` run also emitted stray `host-base.{js,d.ts}` next to the
  source — delete them, they are not gitignored.
- Tests touched: `webserver.spec` (rendered `./plugins/…`),
  `node-half.client.spec`, `loader.client.spec` (script `src` now resolved),
  `frontend-static.spec` + `browser-auth.host.spec` (`./` redirect). New:
  `packages/client/connection/tests/host-base.client.spec.ts`. Full GUI lanes
  green: `pnpm vitest run packages/client packages/host packages/api/gateway
  packages/session-query packages/bundle` → 320 files / 4589 tests.
- Not done, deliberately: `ctx.connection.isLoopback` on the remote page is
  still `false` (the page authority is the tailnet FQDN), so **Settings →
  General/Models persist in memory only** from the phone. `dsh-full-remote`
  pins `isLoopback` with a `__ModuleLoader__` wrapper injected by `tapIndex`;
  a cleaner fix would be a DSH-side signal (e.g. a trust flag the server
  injects for requests whose `Host` it already considers loopback). Chat,
  sessions, tool approvals, the settings *panel* all work remotely.

Running DSH from the branch: `cd ~/github/deepseek-harness-tailscale && pnpm dsh web`
(all artifacts are built there). To move the live GUI onto it, either run
from the worktree, or `git checkout fix/tailscale-mounting` in
`~/github/deepseek-harness` **after** stopping the live server and rebuild
(`pnpm run build`); merging the branch into `fix/safari-dock-app-gap` is a
clean fast-forward-able merge (both branch off `master`).

## Tailscale path-mount facts (measured with an echo server)

`tailscale serve --bg --yes --https=443 --set-path /dshtest http://127.0.0.1:38099`, then curl:

| Request | Backend sees `req.url` |
|---|---|
| `GET /dshtest` | `/` |
| `GET /dshtest/` | `/` |
| `GET /dshtest/foo/bar?x=1` | `/foo/bar?x=1` |

- `Host` stays the tailnet FQDN (`tali-macbook-air.tailbce956.ts.net`);
  `x-forwarded-for: 100.114.226.21`, `x-forwarded-host`, `x-forwarded-proto:
  https` added; socket peer `127.0.0.1`. No `x-forwarded-prefix`. No
  `Tailscale-User-*` for a self-probe from a *tagged* node (documented).
- Since `/dshtest` and `/dshtest/` are the same to the backend, the **display
  URL must carry the trailing slash** (`…/dsh/`), and the proxy injects a head
  script into index responses that `location.replace`s `…/dsh` → `…/dsh/`;
  the token-exchange redirect names `/dsh/` outright behind Tailscale (a
  relative `./` from the slash-less form resolves to the site root — found
  the hard way in the first browser test).
- Removal syntax: `tailscale serve --https=443 --set-path /dshtest off` (exit
  0). `serve status --json` shape: `Web["<fqdn>:443"].Handlers["/dsh"].Proxy`.
- WebSocket upgrades pass through the path mount (verified: `wss://…/dsh/api/remote.mux` opens).
- This node: `tali-macbook-air.tailbce956.ts.net`, tags `tag:research`,
  `tag:typst-host`; the `svc:typst` service also uses Serve — port 443 root
  and `/dsh` were free.

## The plugin: `plugins/dsh-tailscale-remote`

README: `plugins/dsh-tailscale-remote/README.md` (admission rules, config,
control channel, threat-model note). Layout: `index.js` (Cordis plugin,
`inject = ['webServer', 'connection']`, `Schema` config, boot restore, RPC
channel `/tailscale-remote` via `ctx.connection.rpc.handle`), `proxy.mjs`,
`tailscale.mjs`, `state.mjs`, `src/client/index.tsx` (settings section),
`tests/*.test.mjs` (node:test).

Design decisions:

- **Auth = allowlisted `Tailscale-User-Login` OR token OR HMAC cookie.** The
  header is trusted only when the socket is loopback and the rightmost
  `x-forwarded-for` is a tailnet address (same peer test as the fork; no
  Cloudflare marker check because there is no cloudflared here). The cookie
  is `HMAC(token)`, so **rotating the token signs out every QR device** while
  allowed users keep working — exactly the semantics the panel promises.
- **QR contains the standing token** (`…/dsh/?token=…`) per the spec —
  unlike the fork's one-time invites. The panel says so in red-ish caption
  terms; the state file is 0600.
- **DSH auth bridge** copied from the fork: on proxy start,
  `ctx.connection.authenticatedUrl('http://127.0.0.1:<port>')` → GET →
  303 + `Set-Cookie` → forward that cookie on every request with
  `Host`/`Origin` rewritten to `127.0.0.1:<port>`. Refreshed after 6 h or on
  an upstream 401.
- **Control channel** is its own `webServer` prefix route `/tailscale-remote`
  gated by `ctx.connection.requestRejection(req)` (DSH's Host/Origin fence +
  cookie), speaking the Connection envelope so the browser half can use
  `ctx.connection.rpc.call('/tailscale-remote', …)`. Not `/api` Fetch routes
  (GET/HEAD only; mutations were needed) and **not `ctx.connection.rpc.handle`**:
  that worked on the pre-rebase master but on upstream `0d1f50007f` fails at
  activation with `cannot get property "webServer" without inject` from
  `rpc-host.ts` `register()` (`owner.webServer` through the traceable service
  context; no in-tree plugin calls `rpc.handle`, so upstream never notices).
  "Host only" is enforced by the **proxy refusing to forward
  `/tailscale-remote/*`** (403) — the remote panel shows "controlled from the
  DSH host only".
- **Public passthrough** for `/manifest.webmanifest` and `/favicon.svg`:
  Chrome fetches the manifest without cookies and logged 401s otherwise.
- `uqr` renders the QR as SVG on the host (same library as the fork).
- UI uses `Button`/`Input`/`writeClipboard` from `ui-primitives`, inline
  styles with `--dsw-alias-*` tokens (house pattern of the other plugins);
  typing `ctx.slots` needs `import type {} from
  '@deepseek-ai/dsh-client-ui-renderer/client'`.

Dev-instance row added to `cordis.dev.yml` (state defaults to disabled, so
harmless until Enable is pressed).

## Verified end to end (2026-09-16)

Isolated preview from the worktree, throwaway home:

```sh
cat > /tmp/tailscale-remote-preview.yml <<'EOF'
- insert:
    - id: tali-tailscale-remote
      name: /Users/tali/github/tali-dash-plugins/plugins/dsh-tailscale-remote/index.js
EOF
cd ~/github/deepseek-harness-tailscale
DSH_HOME=/tmp/tailscale-remote-home pnpm dsh web --patch /tmp/tailscale-remote-preview.yml --port 3081 --no-open
```

- Served index at `:3081` has no `<base>`, `./plugins/??…` script tags,
  `./assets/…`; `dsh-tailscale-remote/client.js` in the boot graph.
- Panel: Enable → `tailscale serve status` shows `/dsh proxy http://127.0.0.1:3083`;
  Disable removes it and closes the listener; users saved as lower-cased
  list; state file updated; boot with `enabled: true` restores the proxy.
- Through the tailnet (`curl` + Chrome): anonymous `401`; `/dsh?token=` →
  `303 /dsh/` + cookie; index with the slash guard; `assets` 200 (423 kB
  JS); `/dsh/api/settings/describe` 200; `/dsh/plugins/events` 200;
  `wss://…/dsh/api/remote.mux` opens; `/dsh/tailscale-remote/status` 403.
  The GUI renders, Settings opens, "Tailscale remote" section shows the
  read-only message remotely and the full panel locally.
- `chrome_fill` on the users `<Input>` did **not** trigger React's onChange
  (Save stayed disabled); typing did. Not a plugin bug.

## Live install (done 2026-09-16)

Live checkout `~/github/deepseek-harness` is now on `fix/tailscale-mounting`
(`1c80583ba3`), reinstalled and rebuilt; the worktree was removed (git allows
a branch in one worktree only). `dsh-full-remote` was removed from the web
profile (`pnpm dsh plugin --profile web remove -w dsh-full-remote`); its
`- id: reverse-proxy` config block in `~/.dsh/profiles/web/cordis.patch.yml`
and `~/.dsh/reverse-proxy.json` / `.audit.jsonl` are leftovers to delete. The
plugin row lives at the top of the profile patch's `insert` list; state at
`~/.dsh/tailscale-remote.json`. The dev overlay no longer carries the row
(duplicate id would fail a preview boot; the preview also could not bind
:3083 while the live one runs).

Confirmed live 2026-09-16: Enable pressed in the live GUI, phone scanned the
QR and got the DSH GUI at `https://tali-macbook-air.tailbce956.ts.net/dsh/`.
DSH branch pushed: `taliesinb/deepseek-harness` → `fix/tailscale-mounting`.

## Using it

1. Run DSH from `fix/tailscale-mounting` (see above) with the plugin row in
   the profile patch or `dsh plugin --profile web add ./plugins/dsh-tailscale-remote`
   (bundle patch inserts id `tali-tailscale-remote`; do not also keep the dev
   overlay row — duplicate id fails the boot).
2. Settings → **Tailscale remote** → **Enable**. Copy
   `https://tali-macbook-air.tailbce956.ts.net/dsh/` or scan the QR from the
   phone (phone must be on the same tailnet — see the Cloudflare recipe on
   why the company tailnet is the constraint).
3. Optionally type the phone's login into **Allowed Tailscale users**
   (`tailscale whois <phone-ip>` shows it) so it needs no QR.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Remote page is blank, console full of 404 on `/api/...`, `/plugins/...` | DSH not running from `fix/tailscale-mounting` (stock URLs escape the mount) |
| Remote page loads at `…/dsh` (no slash), assets 404 | slash guard missing → the proxy did not rewrite the index (compressed? path not `/`); check `x-forwarded-host` arrives |
| `Tailscale unavailable: the tailscale CLI was not found` | set `tailscalePath` (`/usr/local/bin/tailscale` here) |
| `/dsh on this node already points at …` | another Serve mapping on `/dsh`; `tailscale serve status`, remove it or change `mountPath` |
| Enable fails with `could not start the proxy on 127.0.0.1:3083` | port taken (a second `dsh web` with the plugin, e.g. dev overlay + live) — change `listenPort` in one of them |
| Allowed user still gets 401 | login must match `Tailscale-User-Login` exactly (lower-cased); tagged devices carry no identity headers; check `x-forwarded-for` is in `100.64.0.0/10` |
| Boot warns `tali-tailscale-remote … cannot get property "webServer" without inject` | an older plugin build using `ctx.connection.rpc.handle`; current code registers on `webServer` directly |
| Panel says "controlled from the DSH host only" on the laptop | you opened the laptop GUI through the tailnet URL — use `http://127.0.0.1:<port>/` |
| Settings changes from the phone do not persist | `isLoopback` false remotely (see "Not done" above) |
| Manifest 401 in console | fixed by the public passthrough; if it reappears the path changed |

## Sibling plugins with root-relative `/api` URLs

`foreign-link-opener/src/client/index.ts` and
`wolfram-kernel-supervisor/src/client/index.tsx` used `/api/...` literals,
which would escape the mount. Sources changed to `./api/...` (typecheck
green) but **`lib/client.js` was not rebuilt** — both are installed in the
live profile and a rebuild hot-swaps the open GUI. Run `pnpm build` in each
directory before the next live restart (or any time a hot swap is fine).

## Rollback

```sh
tailscale serve --https=443 --set-path /dsh off       # remove the route
rm -f ~/.dsh/tailscale-remote.json                    # (or the preview home's copy)
# drop the plugin row from the profile patch / `dsh plugin --profile web remove dsh-tailscale-remote`
cd ~/github/deepseek-harness && git worktree remove ../deepseek-harness-tailscale  # keeps the branch
```

# dsh-tailscale-remote

Drive this DeepSeek Harness Web GUI from another device on your tailnet, at

```
https://<node>.<tailnet>.ts.net/dsh/
```

One feature, on purpose. `dsh-full-remote` does tunnels, invites, device
approval, audit logs and a Tailscale route; this plugin does only the
Tailscale part, from scratch, in ~600 lines:

- a **loopback reverse proxy** (`proxy.mjs`) in front of DSH that
  authenticates each request and rewrites it so DSH's own `/api` Host/Origin
  fence and cookie auth are satisfied;
- a **Tailscale Serve path route** (`tailscale.mjs`):
  `tailscale serve --bg --yes --https=443 --set-path=/dsh http://127.0.0.1:3083`;
- a **"Tailscale remote"** settings section (`src/client/index.tsx`):
  Enable / Disable, the URL with copy-to-clipboard, a comma-separated list of
  allowed Tailscale users, and a QR code of the URL *with* the access token.

English only.

## Requires the patched DSH

Tailscale strips the mount prefix before proxying (`/dsh/x` arrives as `/x`),
and stock DSH anchors its computed URLs at the origin (`/api/...`, the
`/api/remote.mux` WebSocket, `/plugins/...` bundles, `<base href="/">`). The
DSH branch **`fix/tailscale-mounting`** (worktree `~/github/deepseek-harness-tailscale`)
makes every Host URL *document-relative*, so the same build works at
`http://127.0.0.1:3080/` and behind the `/dsh/` mount. Run DSH from that
branch; on `master` the remote page loads its HTML and then 404s on
everything else.

## How a request is admitted

Exactly one of, in this order:

1. **Allowed Tailscale user.** Serve injects `Tailscale-User-Login` (tailnet
   verified; a client-supplied copy is overwritten). It is trusted only when
   the request also looks like a Serve peer — loopback socket and a rightmost
   `x-forwarded-for` inside `100.64.0.0/10` or `fd7a:115c:a1e0::/48` — and the
   lower-cased login is in the allowlist. Empty allowlist = nobody by login.
2. **Token.** `GET /?token=<token>` (what the QR encodes) with the exact
   standing token sets the proxy's own `HttpOnly` cookie and redirects to
   `/dsh/` (behind Tailscale) or `./` (on the loopback listener). The token
   is 192 bits, persisted 0600 in `$DSH_HOME/tailscale-remote.json`.
3. **Cookie.** `dsh-tailscale-remote=<HMAC(token)>`. Rotating the token
   invalidates every cookie; allowed users are unaffected.

Everything else is `401`. `/manifest.webmanifest` and `/favicon.svg` pass
anonymously (DSH serves them public too; browsers fetch manifests without
cookies). The plugin's own control channel `/tailscale-remote/*` is answered
`403` and never forwarded — the remote page can view the section but cannot
flip the route or read the token.

Admitted requests are forwarded to `http://127.0.0.1:<dsh port>` with
`Host`/`Origin` rewritten to that authority, `sec-fetch-site: same-origin`,
the browser's cookies replaced by the DSH browser-session cookie the plugin
obtained by exchanging its own launch token (`ctx.connection.authenticatedUrl`),
Tailscale identity headers stripped, and `x-forwarded-*` re-derived.
WebSocket upgrades take the same gate. Index responses get a head script that
turns `https://node/dsh` into `https://node/dsh/` — both arrive as `/`, and
without the slash the shell's relative asset URLs resolve at the site root.

**Threat model note.** Any local process can connect to the loopback
listener and forge the identity headers — that equals full local access,
which a local process already has. The gate protects against the tailnet,
not the machine.

## Config (`cordis.patch.yml`)

| key | default | |
|---|---|---|
| `listenHost` | `127.0.0.1` | proxy bind address (keep loopback) |
| `listenPort` | `3083` | proxy port `tailscale serve` points at |
| `mountPath` | `/dsh` | path mount on the node |
| `servePort` | `443` | HTTPS port on the node (the Tailscale cert covers the FQDN only) |
| `tailscalePath` | `''` | CLI override; default resolves PATH, then `/Applications/Tailscale.app/Contents/MacOS/Tailscale`, `/usr/local/bin`, `/opt/homebrew/bin` |
| `stateFile` | `''` | `$DSH_HOME/tailscale-remote.json` |
| `cookieName` | `dsh-tailscale-remote` | |

Persisted: `{ enabled, allowedUsers, token }`. tailscaled persists the route
itself; on boot the plugin restarts the proxy when `enabled` and republishes
the route if `serve status` no longer shows it. Unloading the plugin closes
the listener but leaves the route (it comes back with the next boot).

## Control channel

`POST /tailscale-remote/<endpoint>`, a `webServer` prefix route gated by
`ctx.connection.requestRejection` (DSH's Host/Origin fence + cookie), JSON envelope `{type:'client-request', rpcId,
method, payload:{args}}`: `status`, `enable`, `disable`,
`set-users {allowedUsers: "a, b"}`, `rotate-token`.

## Develop

```sh
pnpm install && pnpm build          # lib/client.js (esbuild, CJS factory bundle)
pnpm typecheck                      # tsc against the linked checkout d.ts
pnpm test                           # node:test — proxy gate/forwarding against a fake DSH, state, helpers
pnpm watch                          # rebuild on save (HMR hot-swaps the open GUI)
```

Preview against a throwaway home from the patched worktree:

```sh
cat > /tmp/tailscale-remote-preview.yml <<'EOF'
- insert:
    - id: tali-tailscale-remote
      name: /Users/tali/github/tali-dash-plugins/plugins/dsh-tailscale-remote/index.js
EOF
cd ~/github/deepseek-harness-tailscale
DSH_HOME=/tmp/tailscale-remote-home pnpm dsh web --patch /tmp/tailscale-remote-preview.yml --port 3081 --no-open
```

System-level story, facts and troubleshooting: `recipes/tailscale-remote-plugin.md`.

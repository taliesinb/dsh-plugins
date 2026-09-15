# Remote control of DSH from the phone (dsh-full-remote + Cloudflare)

Recipe for driving the DeepSeek Harness Web GUI running on the laptop (`tbwork`)
from a phone, over a Cloudflare tunnel, with the
[`dsh-full-remote`](https://github.com/JUANWANG-BUAA/dsh-full-remote) plugin
providing authentication. Written 2026-09-05 against DSH `0.1.2-rc.1`,
`dsh-full-remote` `0.3.7`, `cloudflared` `2026.8.3`.

## Why this shape

- **Stock `dsh web` is loopback-only** (`127.0.0.1:3080`) and the CLI refuses
  `--host 0.0.0.0`. `--trusted-host` lets a tunnel hostname pass the `/api`
  Host/Origin fence, but settings, credentials and the directory browser stay
  loopback-only (non-loopback pages get in-memory settings persistence).
- **`dsh-full-remote`** puts an authenticating reverse proxy in front of DSH
  (loopback `:3082` here) that rewrites `Host`/`Origin` to loopback, so the whole
  GUI works remotely — including settings, "add workspace", and tool-approval
  sheets on the phone. Its own access layer replaces DSH's fence: 192-bit token
  (`0600` state file), per-device sessions (hash-only), **one-time 15-minute QR
  invites that never contain the standing token**, optional first-visit approval,
  per-IP lockout, JSONL audit log. Control routes (start/stop/reveal token) are
  loopback-only and never forwarded through the tunnel.
- **Cloudflare tunnel, not Tailscale**: the laptop lives on the company tailnet
  and a Tailscale client can be active on only one tailnet at a time, so a
  personal tailnet for phone+laptop would mean leaving the work one. `cloudflared`
  makes outbound connections only — no listening port, no port forwarding.
- **Not `ds-harness-remote`** (a.k.a. `deepseek-harness-remote`): it routes through
  a third-party hosted relay (`dsh.r2049.cn`) with GitHub/Zhihu login and has no
  self-hosted option — not appropriate for a company laptop.

DSH streams live output over WebSocket (not SSE), so Cloudflare's quick-tunnel
"no SSE" limitation does not matter.

## What was installed (already done)

```sh
# dsh is launched from the checkout: `pnpm dsh …` in ~/github/deepseek-harness
cd ~/github/deepseek-harness

# The web profile (~/.dsh/profiles/web) is a pnpm workspace (it holds a
# `workspace:*` plugin), so pnpm needs -w to add to the workspace root.
pnpm dsh plugin --profile web add -w dsh-full-remote     # -> dsh-full-remote@^0.3.7

brew install cloudflared                                  # -> /opt/homebrew/bin/cloudflared
```

`dsh plugin add` appended `dsh-full-remote` to `dsh.profile.bundles` in
`~/.dsh/profiles/web/package.json`. The plugin's own bundle layer inserts a
`reverse-proxy` row on `127.0.0.1:3081` and disables the native macOS directory
picker in favour of the in-app browser (set `DSH_FULL_REMOTE_USE_NATIVE_PICKER=1`
before boot to get the native chooser back).

Peer-dependency warnings from `pnpm peers check` are pre-existing
(`dsh-import-agents` wants `@deepseek-ai/dsh-session*`) and unrelated.

## Profile patch (already done)

Appended to `~/.dsh/profiles/web/cordis.patch.yml`. A patch **replaces** the
targeted row's whole `config` (no deep merge), so `listenHost`/`listenPort` are
restated:

```yaml
- id: reverse-proxy
  config:
    listenHost: 127.0.0.1
    listenPort: 3082                    # NOT the plugin default 3081 — see below
    approvalMode: true                  # a new phone waits until approved in the local panel
    trustForwardedFor: true             # real client IPs for audit/lockout behind cloudflared
    trustCloudflareConnectingIp: true   # ...via CF-Connecting-IP (Cloudflare edge only)
    sessionIdleSeconds: 43200           # 12h idle → device must log in again
    auditLog: true
    cloudflaredPath: /opt/homebrew/bin/cloudflared   # brew-installed; skips the plugin's own download
```

Port note: `127.0.0.1:3081` is already taken by the plugin-dev instance
(`dsh web --patch ~/github/tali-dash-plugins/cordis.dev.yml --port 3081`), so the
proxy listens on `3082`. `backendPort` is left at its default `0` = "follow this
process's `webServer.port`", so the proxy always fronts the DSH instance it runs
inside.

Validation without booting (also prints skipped/unmatched patch targets on stderr):

```sh
pnpm dsh --profile web --dump-config | grep -A10 '^- id: reverse-proxy'
```

### Does the patch affect an already-running `dsh web`?

No. The profile is `patchReload: live`, so a running instance re-reads
`cordis.patch.yml`, but the bundle list in `package.json` is only read at boot.
Until restart the `reverse-proxy` row does not exist, the id-targeted patch is a
*skipped-patch diagnostic* (warning), and the live GUI keeps serving. Verified:
`curl -I http://127.0.0.1:3080/` still answered `401` (auth fence intact) after
the edit.

## Chinese panel (反向代理): cause, interim pnpm patch, and the fork

**Symptom.** After the restart the last Settings entry reads **反向代理** and the
whole panel is Chinese while the rest of DSH is English.

**Root cause (plugin bug, not a misconfig).** The client entry declares Cordis
`inject = ['slots']` only, so its `apply` can run before DSH's
`@deepseek-ai/dsh-client-locale` row (`id: locale`) activates. `bindTranslate`
read the service **once** with `ctx.get('locale')`; when it lost that race the
panel never saw the host locale for the life of the page. In 0.3.7 the fallback
dictionary was `zh` (the source comment claims zh "matches the harness's own
fallback locale" — wrong: DSH's `FALLBACK_LOCALE` is `'en'`,
`packages/client/locale/src/client/index.ts`). Upstream 0.3.11 (unpublished on
npm as of 2026-09-05; npm `latest` = 0.3.7) changed the fallback to the browser
language and added an Auto/English/中文 selector (#30), which hides the symptom
for English browsers but leaves "Auto" ignoring the Harness Language setting.

Two mechanisms are easy to confuse here: the manifest's `dsh.client.inject`
(package names) only orders client **module factory arrival**
(`packages/client/modules/src/client/system.ts`, missing packages are skipped);
the Cordis `inject` static (service names) is what gates `apply`. Adding the
locale package to the manifest list therefore does not fix the race — the real
fix is binding reactively with `ctx.inject(['locale'], …)`.

### The fork (current state)

- GitHub: <https://github.com/taliesinb/dsh-full-remote> (fork of
  `JUANWANG-BUAA/dsh-full-remote`, created with `gh repo fork --clone=false`,
  then `gh repo clone taliesinb/dsh-full-remote` into `~/github/dsh-full-remote`,
  which sets `origin` = fork and `upstream` = original automatically).
- Branch `tali/main` (tracks `origin/tali/main`); `main` mirrors upstream.
- Commit `16c8786` "fix(client): bind the host locale service reactively":
  `src/client/i18n.ts` binds via `ctx.inject(['locale'], …)` (registers the
  dictionary in the scope, unregisters via `scope.effect`, disposes the fiber
  on `dispose()`), `src/client/language.ts` gains `invalidate()` so open
  panels/overlays re-render on arrival, `tests/fixtures/fake-client-context.ts`
  emulates Cordis inject/provide/revoke for tests, plus a regression test for a
  late-arriving service.
- `vitest.config.ts`: `pool: 'forks'` + `execArgv: ['--no-experimental-webstorage']`.
  **Failed first:** on Node 26 (`/opt/homebrew/bin/node`), Node's default-on
  experimental `localStorage` global is `undefined` without `--localstorage-file`
  and shadows jsdom's, so the pristine upstream #30 tests fail too; upstream CI
  is Node 22/24. Vitest 4 rejects the old `poolOptions.forks.execArgv` shape —
  `execArgv` is top-level now.
- Toolchain: `pnpm install` (pnpm 11.21 via `packageManager`; `prepare` builds
  `lib/`), `pnpm run check` = lint + typecheck + 229 unit + 67 client tests +
  build. All green.

Installing the fork into the live profile (not yet done — features pending):

```sh
cd ~/github/dsh-full-remote && pnpm run build
cd ~/.dsh/profiles/web
#   1. drop the 0.3.7 pnpm patch first (see below), otherwise pnpm errors on an
#      unused patch:  remove `patchedDependencies` from pnpm-workspace.yaml and
#      rm patches/dsh-full-remote@0.3.7.patch
#   2. either link the checkout (follows every rebuild; good while developing)
pnpm add -w link:/Users/tali/github/dsh-full-remote
#      or install a packed tarball (frozen copy; what upstream's README suggests)
(cd ~/github/dsh-full-remote && pnpm pack) && pnpm add -w ~/github/dsh-full-remote/dsh-full-remote-*.tgz
# then restart dsh web
```

Upstream PR: the locale fix is self-contained and worth sending to
`JUANWANG-BUAA/dsh-full-remote` (`gh pr create --repo JUANWANG-BUAA/dsh-full-remote
--head taliesinb:tali/main` once features are split into their own branch).

### Interim `pnpm patch` (what the profile runs right now, on 0.3.7)

Until the fork is installed, the profile carries a `pnpm patch` with the
two-line version of the fix (fallback → `en`, manifest inject edge — the latter
harmless but, per the above, not the real fix):

```sh
cd ~/.dsh/profiles/web
pnpm patch dsh-full-remote@0.3.7 --edit-dir /tmp/dsh-full-remote-patch
#   lib/client.js   : const fallback = translatorFor(zh);  ->  translatorFor(en);
#   package.json    : dsh.client.inject += "@deepseek-ai/dsh-client-locale"
pnpm patch-commit /tmp/dsh-full-remote-patch
```

Result: `~/.dsh/profiles/web/patches/dsh-full-remote@0.3.7.patch` plus
`patchedDependencies` in `~/.dsh/profiles/web/pnpm-workspace.yaml`. Takes effect
at the next `dsh web` boot (the manifest is read at boot; a plain page refresh
may already pick up the new client bundle). Also check **Settings → General →
Language** if anything else is off.

Maintenance: the patch key is pinned to `0.3.7`. After
`pnpm dsh plugin --profile web update -w --latest dsh-full-remote` (or the fork
install above), pnpm refuses to install while a patch targets a version that is
no longer present — drop the `patchedDependencies` entry and the file.

Label map, in case the panel is still Chinese:

| 中文 | English | 中文 | English |
|---|---|---|---|
| 反向代理 | Reverse proxy | 启动代理 / 停止代理 | Start / Stop proxy |
| 代理尚未运行 / 代理正在运行 | Proxy is not running / running | 发布地址 | Listen address |
| 隧道目标 | Tunnel target | 一键公网隧道 → 启动快速隧道 | One-click public tunnel → Start quick tunnel |
| 隧道已上线 / 隧道错误 | Tunnel online / error | 手机邀请 | Phone invite |
| 公网 / 可达 Origin | Public / reachable Origin (leave empty) | 设备显示名称 | Device display name |
| 生成邀请 / 复制邀请链接 | Generate invite / Copy invite link | 已连接设备 → 批准 | Connected devices → Approve |
| 访问令牌 → 显示访问令牌 / 轮换令牌 | Access token → Show / Rotate token | | |

## Weekend flow (to do)

### 1. Restart the main `dsh web`

Quit the running instance (Ctrl-C once = graceful drain, up to 5 s) and start it
again from the checkout:

```sh
cd ~/github/deepseek-harness && pnpm dsh web
```

Expected: the usual `dsh web: http://127.0.0.1:3080/?token=…` line, and
**Settings → Reverse proxy** appears as the last entry in the left navigation.

### 2. Start the proxy and the quick tunnel (laptop)

In **Settings → Reverse proxy**:

1. **Start proxy** — the panel shows the tunnel target `http://127.0.0.1:3082`
   and a *fence self-check* (probes `settings.describe` through the rewrite).
2. **Start Cloudflare quick tunnel** — gives a random `https://…trycloudflare.com`
   URL. Uses `/opt/homebrew/bin/cloudflared`; no Cloudflare account needed.
3. **Generate invite** — leave *Public / reachable Origin* empty (the tunnel URL
   is used automatically). A QR code appears; it is single-use, expires in
   15 minutes, and does not contain the standing token.

Manual equivalent of step 2, if you prefer a terminal:

```sh
cloudflared tunnel --url http://127.0.0.1:3082
```

### 3. Phone

1. Scan the QR (or open the one-time link). The login page submits once.
2. Because `approvalMode: true`, the phone sits on a *Waiting for approval* page.
3. On the laptop, in the same panel, approve the new device (rename it, e.g.
   "tali-phone"). The device list shows login IP and last-seen IP.
4. The phone now shows the normal DSH GUI. Tool approvals, `ask_user_question`
   choices and plan reviews appear as a bottom sheet on the phone.

Optional: pair with a phone layout plugin such as
[`dsh-web-mobile`](https://github.com/mexiaosqwq/dsh-web-mobile).

### 4. Verify

```sh
# proxy up and gated (401/redirect to the token page, not the DSH GUI)
curl -sI http://127.0.0.1:3082/ | head -3
# health endpoint
curl -s http://127.0.0.1:3082/_dsh_reverse_proxy/healthz
# state + audit (0600, next to $DSH_HOME)
ls -la ~/.dsh/reverse-proxy.json ~/.dsh/reverse-proxy.audit.jsonl
```

The audit viewer in the panel shows `login.ok`, approvals, revocations, token
rotations and WebSocket open/deny events.

### Things to know

- **Quick tunnel URL changes on every start**, which invalidates the phone's
  cookie (it is bound to the authority). Re-invite after each tunnel restart.
  Quick tunnels are "testing/dev only": no SLA, 200 in-flight request cap.
- **Auto-restore**: once you press *Start proxy*, `enabled: true` is persisted in
  `~/.dsh/reverse-proxy.json` and the proxy restarts on every boot
  (`autoRestore: true`). The plugin-dev instance on `:3081` loads the same profile,
  so on *its* next restart it will also try to bind `:3082`, fail because the main
  instance already holds it, and log `reverse-proxy: persisted start skipped` —
  harmless. To keep it out entirely, add `- id: reverse-proxy` / `disabled: true`
  to `~/github/tali-dash-plugins/cordis.dev.yml`.
- **Laptop must stay awake** with `dsh web` running; on Android give the browser
  no battery restrictions if you want long sessions to keep streaming.
- **The token is the credential.** Whoever holds a device session controls an
  agent that runs commands on the laptop. Keep `approvalMode: true`, revoke
  devices you no longer use, rotate the token from the panel after invites
  outlive their need. Never enable Cloudflare *Funnel*-style public listing.
- Control actions (start/stop/reveal token/change listen address) only work from
  the local laptop window, never through the tunnel.

## Phase 2 (recommended after the weekend): named tunnel + Cloudflare Access

Gives a **stable hostname** and a **second, identity-bound auth layer** in front
of the plugin (email one-time-PIN or GitHub login at the Cloudflare edge). Costs:
Cloudflare Tunnel and Access (≤50 users) are free; you need a domain on
Cloudflare DNS (~$10/yr if you do not have one).

```sh
cloudflared tunnel login                       # browser: pick the zone
cloudflared tunnel create dsh                  # writes ~/.cloudflared/<UUID>.json
cloudflared tunnel route dns dsh dsh.<your-domain>
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: <UUID>
credentials-file: /Users/tali/.cloudflared/<UUID>.json
ingress:
  - hostname: dsh.<your-domain>
    service: http://127.0.0.1:3082
  - service: http_status:404
```

```sh
brew services start cloudflared                # launchd, restarts at login
```

Then in the Cloudflare Zero Trust dashboard: **Access → Applications → Add
(self-hosted)**, hostname `dsh.<your-domain>`, policy *Allow* with rule
*Emails = your address* (or a GitHub identity provider). Session duration e.g. 1
week. Traffic that has not passed Access never reaches `cloudflared` on the
laptop, so the plugin only ever sees you.

Plugin side: in **Reverse proxy**, generate invites with *Public / reachable
Origin* = `https://dsh.<your-domain>`; do not start the quick tunnel. Because the
hostname is stable, phone cookies survive laptop restarts. Named tunnels have no
SSE / in-flight limits. `trustForwardedFor` + `trustCloudflareConnectingIp` keep
working unchanged.

Quick tunnels and a `~/.cloudflared/config.yml` do not coexist — once the named
tunnel exists, rename `config.yml` temporarily if you ever want a quick tunnel
again.

## Alternatives considered

| Tunnel | Verdict |
|---|---|
| Cloudflare quick tunnel | free, no account, random URL per start — this weekend |
| Cloudflare named tunnel + Access | free (+domain), stable, second auth layer — Phase 2 |
| ngrok free | stable `*.ngrok-free.app` domain but 1 GB egress + 20k requests/month and an interstitial; OK for light use |
| Pinggy | free tier has a 60-minute tunnel timeout; Pro (a few $/month) gives a persistent subdomain; Pinggy can inspect non-TLS tunnel traffic |
| Personal Tailscale tailnet | not viable: one active tailnet per device, laptop is on the company tailnet |
| `tailscale serve` on the company tailnet | works technically (`dsh web --trusted-host tbwork.tailbce956.ts.net`) but the phone would have to join the company tailnet |
| `ds-harness-remote` | hosted third-party relay + GitHub/Zhihu login, no self-hosting — no |

## Rollback

```sh
cd ~/github/deepseek-harness
pnpm dsh plugin --profile web remove -w dsh-full-remote   # drops the bundle entry too
# remove the `- id: reverse-proxy` block from ~/.dsh/profiles/web/cordis.patch.yml
# remove the `patchedDependencies` entry from ~/.dsh/profiles/web/pnpm-workspace.yaml
rm -f ~/.dsh/profiles/web/patches/dsh-full-remote@0.3.7.patch
rm -f ~/.dsh/reverse-proxy.json ~/.dsh/reverse-proxy.audit.jsonl
brew uninstall cloudflared                                # optional
```

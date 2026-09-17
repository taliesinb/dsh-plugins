# PREVIEWING.md — trialing plugins safely

> **VERY IMPORTANT: do not modify the user's live DSH configuration without
> explicit confirmation.** The live home is `~/.dsh`. Three tiers of risk,
> verified against the source checkout (`packages/boot/app-boot/src/profile.ts`,
> `docs/subsystems/client-modules.md`):
>
> 1. **Hot (applies the moment you save):** the `web` profile defaults to
>    `patchReload: 'live'`, so edits to `~/.dsh/cordis.patch.yml` (home level)
>    or `~/.dsh/profiles/<name>/cordis.patch.yml` reload the affected plugin
>    rows in the RUNNING server — including the client/server session YOU are
>    likely being run in, which can render it inoperative. (`headless`/`sdk`
>    profiles default to `patchReload: 'startup'`.)
> 2. **Hot for the browser:** the client-bundle HMR watcher is always mounted;
>    rebuilding the `lib/client.js` of a plugin that is installed in the live
>    profile hot-swaps it into the user's open GUI immediately.
> 3. **Boot-time:** `dsh plugin add`/`remove` rewrites the profile manifest
>    and node_modules — composed at next launch, not live, but it still
>    changes what the user's DSH runs from then on (and the install itself
>    mutates the running profile's directory).
>
> (Module-source HMR — `@deepseek-ai/cordis-plugin-hmr` — ships disabled, so
> editing installed plugins' *source* files alone does not hot-reload.)
>
> Make none of these changes unless explicitly asked. If the user only
> *implies* it — e.g. asks you to "install" a plugin or fix a DSH bug — check
> first that they want the change applied to the live DSH they are using. The
> safe way to trial a plugin is the isolated preview server below; that
> requires no confirmation.

## The standing preview server (`~/.dsh-preview`, since 2026-09-17)

There is a permanent preview instance on this Mac, managed by a relay
LaunchAgent (`io.github.taliesinb.dsh-web-relay.preview`) that starts it on
demand and keeps it apart from the live one — own home, own ports, own Dock
app. Prefer it over ad-hoc servers for anything the user should also be able
to look at.

| | live | preview |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | `~/.dsh-preview` |
| `dsh web` port | 3080 | 3088 |
| composition | `~/.dsh/profiles/web/cordis.patch.yml` | `~/.dsh-preview/profiles/web/cordis.patch.yml` (only the `tali-tailscale-remote` row) **+ `cordis.dev.yml`** (the plugins under trial) |
| tailnet URL | `https://tali-macbook-air.tailbce956.ts.net/dsh/` | `…/dsh-preview/` |
| relay → proxy | :3083 → :3084 | :3085 → :3086 |
| Dock app | `~/Applications/DSH.app` | `~/Applications/DSH Preview.app` (red) |
| logs | `~/.dsh/logs/{relay,dsh-web}.log` | `~/.dsh-preview/logs/{relay,dsh-web}-preview.log` |

**How to use it as an agent:**

1. Put the plugin row(s) under trial into `cordis.dev.yml` (absolute `name`
   paths; an `insert` list — it is a *complement* to the preview home's
   profile patch, which only contains `tali-tailscale-remote`; do not repeat
   that id).
2. Start or restart the preview: `launchctl kickstart -k gui/$UID/io.github.taliesinb.dsh-web-relay.preview`
   (restarts the relay **and** the DSH it spawned — required after editing
   `cordis.dev.yml` or any host-side plugin module; client-bundle rebuilds
   hot-swap on their own). If it is not running yet, any request to
   `http://127.0.0.1:3085/` (or opening the Dock app) starts it; it answers a
   503 "Starting DSH…" page until the server is up (~3 s).
3. Reach it:
   - browsers on this Mac, incl. the `browser-automation` STP windows: open
     `https://tali-macbook-air.tailbce956.ts.net/dsh-preview/` — admitted by
     the node's own Tailscale identity, **no token**;
   - scripts/curl: the tokened URL is printed into
     `~/.dsh-preview/logs/dsh-web-preview.log` (`dsh web: http://127.0.0.1:3088/?token=…`,
     the last occurrence is the current process); exchange it with a cookie
     jar (303) and call `/api/...` or the plugin control channels.
4. Tell the user to click **DSH Preview** in the Dock to see the same thing.

Facts: its Settings persist (the page is treated as the operator's machine),
so providers/models configured there stay; sessions and workspaces are the
preview's own, never the live ones — **never point both servers at one home**
(session write ownership is a cross-process `flock`; a session listed by both
GUIs ends in `SessionAlreadyOwnedError`). Story and failure table:
`recipes/dock-app-via-tailnet.md`.

## Ad-hoc throwaway server (still fine for one-off tests)

A third `dsh web` against a `/tmp` home, e.g. for a patch you do not want in
`cordis.dev.yml`:

```sh
cd ~/github/deepseek-harness
DSH_HOME=/tmp/tali-dash-plugins-home \
  pnpm dsh --profile web --patch /tmp/my-overlay.yml --port 3090 --no-open
```

Run it as a managed background job and capture stdout. Note the CLI shape:
global options (`--profile`, `--patch`) come *before* the profile's own
(`--port`, `--no-open`); `dsh web --patch` is rejected. Ports 3080–3088 are
taken by the live/preview pairs; other sessions have used 3081/3082 ad hoc,
so pick 3090+ and stop the server when done.

## Details and gotchas

- **The URL is tokened.** stdout prints
  `dsh web: http://127.0.0.1:<port>/?token=...` — open THAT link (or hand it to
  the user); a bare `http://127.0.0.1:<port>/` answers 401. (The standing
  preview additionally has the token-free tailnet URL above.)
- **What isolation covers.** Sessions, workspace registrations, and profile
  state live per-home — but NOT the filesystem: agents run in the preview do
  real work in whatever workspace is opened there. Use a scratch directory.
- **Credentials.** A fresh home has no API keys or providers. Forward the
  user's by copying `~/.dsh/.credentials.yaml` (file-backed key store) and
  `~/.dsh/settings.yaml` (providers/models) into the throwaway home. They are
  snapshots, not links — edits on either side do not propagate.
- **Headless verification.** Fetch the tokened URL with a cookie jar and grep
  the `window.__DSH_BOOT__` graph for the plugin package name; the bundle is
  served at `/plugins/??<package>/client.js&rev=...` (expect HTTP 200).
- **HMR.** The server stat-polls every plugin bundle: a `pnpm watch` rebuild
  hot-swaps the browser without a refresh, and the graph row's `rev` flips
  from a process nonce to a content hash once a rebuild was observed. Host
  modules (`index.js` etc.) are NOT hot-reloaded — restart the instance.
- **Disposable.** A `/tmp` home evaporates on reboot; treat everything in it
  (sessions, keys copied there) as throwaway state. `~/.dsh-preview` persists.

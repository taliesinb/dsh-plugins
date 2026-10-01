# Canary instances: `pnpm canary` (one throwaway DSH per branch)

2026-09-29. The standard way to try a feature branch of this repo as a user:
a separate `dsh web` on its own home, a **Dock app `DSH <branch> <commit>`**
with the red whale icon (the same WKWebView wrapper as the live Dock app), the
same label in the wordmark and window title, loading the plugins that changed
on the branch — nothing in `~/.dsh` or the standing preview is touched.
`tools/canary.sh`, wired as `pnpm canary`.

```sh
cd <plugins>/.worktrees/<branch>        # (or the checkout; see the warning below)
pnpm canary                             # build changed plugins, start, launch the Dock app
pnpm canary --plugin fs-tools           # also load an unchanged plugin
pnpm canary stop                        # this branch's canary (+ quits its Dock app); `stop --all` for every one
pnpm canary remove                      # stop + delete the home and the Dock app
pnpm canary list                        # branch · commit · port · pid · url
pnpm canary logs                        # tail the dsh log
pnpm canary url                         # the tokened URL again
```

Start options: `--only` (ignore the branch diff; load only `--plugin`s),
`--port N`, `--no-credentials`, `--no-app` (browser instead of the Dock app),
`--no-open`, `--no-build`,
`--browser-picker` (in-browser directory picker, the `SSH_TTY` trick), `--fresh`
(wipe the branch's canary home). `pnpm canary --help` prints the header.

## What it does

1. **Plugins** = `plugins/<dir>` touched on the branch relative to
   `merge-base origin/main HEAD` (committed) plus the working tree (uncommitted,
   untracked), plus `--plugin`. Infrastructure plugins (`INFRA_PLUGINS`:
   dsh-tailscale-remote, local-model-supervisor, enforce-model-preset,
   instance-identity, app-lifeline, reload-on-restart) are skipped unless
   forced with `--plugin` — their defaults publish routes or supervise
   servers, wrong for a throwaway. No plugin and no `--plugin` → error.
2. **Build**: per plugin with a `build` script, `pnpm install --ignore-scripts`
   if `node_modules` is missing, then `pnpm run build`. A `dsh.client` package
   without `lib/client.js` afterwards is an error (the server would fail the
   boot).
3. **Overlay** `<root>/<branch>/overlay.yml`: absolute-path rows (`id:
   tali-<dir>`, `name:` the package's `main`) plus an `instance-identity` row
   (`id: canary-identity`) with `label`/`dockLabel` = `DSH <branch> <commit>`
   and `brandColor: '#E5484D'` (the preview's red). The label strips a `feat-`/`fix-`/`chore-`
   prefix and is cut to instance-identity's 32-char limit; `-dirty` is appended
   when `plugins/`, `tools/` or `cordis.dev.yml` have uncommitted changes.
4. **Home** `<root>/<branch>/home` with `~/.dsh/settings.yaml` and
   `.credentials.yaml` copied in (snapshots, mode 600) so real turns work;
   `--no-credentials` skips that. A `scratch/` directory sits beside it to
   use as a workspace.
5. **Launch** from the checkout (`deepseek-harness/`, resolved through the
   worktree's symlink): `node --import tsx/esm apps/cli/src/bin.ts --profile
   web --patch overlay.yml --port N --no-open`, detached (`nohup`), log
   `dsh.log`, pid in `pid`, first free port from 3091. Waits up to 60 s for
   the `dsh web: http://…?token=` line, stores it in `url` and the token
   in `token.json` (`{"token": "…"}`, mode 600).
6. **Dock app** `~/Applications/DSH <branch> <commit>.app` via the new
   `dock-app:local` command of `dsh-tailscale-remote/scripts/cli.mjs`: the
   WKWebView wrapper with `url: http://127.0.0.1:<port>/`, no `fallbackUrl`,
   `tokenFile: <root>/<branch>/token.json`, red glyph. The wrapper change
   that makes this work: with a `tokenFile` and **no** fallback, the primary
   URL itself is tokened from the file on every connect (`entryURL()` in
   `main.swift`), so a restarted canary with a fresh token reconnects on the
   wrapper's own 5 s retry or ⌘R; the offline page names the local server
   instead of the tailnet. The bundle id is per branch
   (`canary-<branch>`), the name per commit: a new commit retires the
   previous app (`dock-app:uninstall`) before installing the new one. A rerun
   with the same name and URL skips the install and just relaunches
   (`dock-app:status` `current: true`). `stop` SIGTERMs the app by bundle
   path (`pkill -f 'Applications/<name>.app/Contents/MacOS/'`).

`<root>` = `$DSH_CANARY_ROOT`, default `/tmp/dsh-canary` (evaporates on
reboot — a canary is throwaway by design). The directory is keyed by
**branch**, so test sessions survive new commits on the branch; a rerun stops
the previous canary of that branch first and reuses the home. The commit
lives only in the label.

## Why these choices

- **Not `pnpm dsh`**: pnpm 12's `packageManager` handling creates a temp
  install directory that the sandbox denies (`Operation not permitted`) — the
  CLI source launch through tsx is the recorded workaround
  (`recipes/chat-title-plugin.md`).
- **Not the standing preview**: its overlay `cordis.dev.yml` is the main
  checkout's; a branch under trial in a worktree would have to edit it there
  and kickstart a shared relay. One canary per branch keeps trials
  independent and lets two branches run side by side (ports 3091, 3092, …).
- **Not the `DSH Canary.app` DMG** (`recipes/bundled-app-dmg.md`): that is a
  self-contained *release* artefact (minutes to build, hundreds of MB); a
  branch trial needs seconds and live hot-swap from `pnpm watch`. The Dock
  app here is the thin wrapper from `dock-app-via-tailnet.md` — the server
  is the checkout's, run by the tool.
- **The wrapper's name is the wordmark.** `desktop-branding.js` writes the
  app's `name` over the page's brand (with `!important`, so a server-side
  `instance-identity` row cannot override it — `recipes/instance-identity.md`).
  Hence the app is named after the full label, commit included, and one app
  per branch is kept by retiring the previous commit's.
- **Identity through the existing `instance-identity` plugin** — the label
  is the "DSH-<branch>-<commit> bundle" the maintainer asked for, without a
  new mechanism; its 32-char label rule is why the branch prefix is stripped.
- **Worktrees**: `install-plugins.sh` pnpm-links the checkout's plugin
  directories into the live profile, so rebuilding a plugin *in the main
  checkout* hot-swaps the live GUI. The script warns when not under
  `.worktrees/`. A fresh worktree's `deepseek-harness/` is empty; symlink it
  (`ln -s ../../deepseek-harness deepseek-harness`) — the script errors with
  that hint otherwise.

## Traps met while building it

| Symptom | Cause / fix |
|---|---|
| `error: unexpected argument '-s' found` from pnpm | pnpm 12 dropped `-s`/`--silent` as a global flag; use `pnpm run build >/dev/null 2>&1`. |
| Label came out `DSH feat-message-s 2693808-dirty` | 32-char limit; the `feat-` prefix is now stripped and the branch cut to the remaining budget. |
| esbuild's summary printed despite `>/dev/null` | It writes to stderr; redirect both. |
| Wordmark still says "DSH" | The identity row is host-only (`index-inject`); a hard reload after the server came up shows it. Check `curl -b jar http://127.0.0.1:<port>/ \| grep 'DSH <branch>'`. |
| `shift: shift count out of range` / silent exit code 1 with no arguments | `set -e` + a bare `shift` in the dispatcher when `$1` was defaulted; `shift \|\| true`. |
| Editing `dsh-tailscale-remote/dock-app/Sources` pulled the whole tailscale-remote plugin into the canary | The branch diff selects by directory; that is why `INFRA_PLUGINS` exists. |
| `EPERM: operation not permitted, mkdir '~/Applications/.DSH … .app.staging-…'` | The DSH sandbox refuses writes outside the workspace; the first install of a branch's app needs a terminal (or an approved escalation). Reruns skip the install. |
| `execution error: … got an error: A privilege violation occurred. (-10004)` | Apple-events `quit` from a sandboxed shell; `stop` uses `pkill -f` by bundle path instead. |
| swiftc: `missing argument label 'token:' in call` | Swift labels every parameter by default; `tokened(base, token: token)`. |
| The app's log stops at launch, process gone | Observed once right after the first install (the installer's `open` racing the staging rename?); a second `open` was fine. Reruns relaunch through `open` anyway. |

## Related

- `PREVIEWING.md` — the three tiers of risk and the standing preview; this
  is the "ad-hoc throwaway server" made repeatable.
- `recipes/message-stash-plugin.md` (branch `feat/message-stash`) — the first feature trialed this way.

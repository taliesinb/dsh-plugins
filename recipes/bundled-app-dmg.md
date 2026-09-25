# The bundled macOS app: `DSH.app` in a DMG, nothing installed globally

**Status (2026-09-24): milestones 1 and 3 done** — a self-hosting `DSH
Canary.app` that carries Node, the fork, and all 22 plugins, runs its own
server, ships in a ~90 MB DMG (268 MB installed), ad-hoc signed, and
**updates itself from GitHub Releases** (`pnpm release-app` publishes; the
app checks on launch and every 6 h). Milestone 2 (first-run dialog offering
Tailscale / STP / Chrome / afm) is designed at the end but not built.

## Why

`tools/bootstrap-mac.sh` reproduces a *developer* machine: Homebrew, node,
pnpm, git, the Command Line Tools, a source checkout run through tsx, plugins
pnpm-linked into `~/.dsh/profiles/web`, a relay LaunchAgent. None of that is a
requirement of DSH — upstream's own `apps/desktop` (Electron) ships a bundled
Node + pnpm + production tree in a signed DMG with `electron-updater`. The
decision (2026-09-23) was to reach the same shape without Electron by growing
the existing Swift WKWebView wrapper (`plugins/dsh-tailscale-remote/dock-app`,
see `dock-app-via-tailnet.md`) into the app, because everything built so far
(integrated title bar, port forwarding, tailnet identity, ⌘-chords, instance
colours) lives there. Of the ten things the bootstrap installs globally, only
Tailscale and Safari Technology Preview are legitimately external (a system
VPN extension; an Apple-distributed browser) — both become "detect and offer",
not "install".

## What the bundle is

The app is **DSH Canary** — red whale (`#E5484D`, the same red as DSH
Preview, distinct bundle id `io.github.taliesinb.dsh-app`), so it is never
mistaken for a checkout-run DSH (stock black whale) in the Dock. `--name` and
`--glyph-color` change both; the page's sidebar whale follows the icon colour
through the wrapper's identity script, and the wordmark reads the app name
unless a brand-kit profile is active (then the brand wins, by design).

```
DSH Canary.app/Contents/
  MacOS/DSH                  the Swift wrapper (dock-app/Sources/*.swift) with EmbeddedServer.swift
  Info.plist                 bundle id io.github.taliesinb.dsh-app, LSMultipleInstancesProhibited
  Resources/
    node/bin/node            official Node 24 LTS macOS build (bin/node only, ~116 MB)
    dsh/package.json         the staging manifest (dshBundle.plugins = what is inside)
    dsh/node_modules/        production closure, hoisted: @deepseek-ai/dsh + base + web-app
                             + headless bundles, 326 first-party packages, 22 plugins (~640 MB)
    profile-template/        package.json {dsh.profile.bundles:[base, web-app, ...22 plugins]}
                             + a `[]` cordis.patch.yml
    dsh-dock-app.json        wrapper config with the `embedded` block (below)
    dsh-app-release.json     version, dsh version, node version, plugin list, build time
    AppIcon.icns
```

Build: `pnpm build-app` (`tools/build-app.sh` → the three scripts in
`tools/bundle/`). ~1.5 min warm; the DMG step alone is 1.5–5 min (ULMO/APFS).
Result on 2026-09-23 after pruning: `DSH.app` 268 MB on disk,
`DSH-0.1.6-alpha.2-<sha>.dmg` 88 MB, cold start to a served page ≈ 3–6 s.

### Runtime behaviour (`EmbeddedServer.swift`)

`dsh-dock-app.json` carries
`"embedded": { "node": "node/bin/node", "dsh": "dsh/node_modules/@deepseek-ai/dsh/lib/bin.js", "profile": "app", "port": 3090, "profileTemplate": "profile-template", "dshHome": null }`.
When present the wrapper, instead of probing a tailnet URL:

1. Resolves `$DSH_HOME` (env, else `~/.dsh` — **shared with a checkout-run
   DSH on the same Mac**: providers, keys, sessions, brand profile all carry
   over; only the profile is separate).
2. Ensures `$DSH_HOME/profiles/app` exists: copied from the template on first
   run; on later runs every template bundle the profile lacks is appended, so
   a release that adds a plugin reaches existing installs while user-added
   bundles (Plugins panel) stay. `--dump-config` on that profile shows all 22
   `tali-*` rows resolving with `dependencies: {}`.
3. Spawns `/bin/zsh -lc 'exec "$@"' dsh-app <node> <bin.js> app --no-open --port 3090`
   with `DSH_HOME`, `DSH_APP_BUNDLE=<bundle path>`, `DSH_APP_VERSION`. The
   login shell is deliberate (same reason as the relay): the operator's PATH
   and exported keys reach the agent's tools.
4. Reads stdout for `dsh web: http://127.0.0.1:3090/?token=…`, rebuilds the
   URL scope from it, loads it. Everything the child prints goes to
   `$DSH_HOME/logs/dsh-app.log`; the wrapper's own log is
   `~/Library/Logs/DSH Dock/DSH (bundled).log` (distinct from the
   checkout-installed wrapper's `DSH.log`).
5. Quit (⌘Q, or `kill <pid>` — SIGTERM is now routed to `NSApp.terminate`)
   → SIGTERM to the child, SIGKILL after 5 s. A child that dies on its own
   shows the offline page with its last stderr lines and a **Try again** that
   restarts it (no auto-retry loop for this case).

**Orphan guard:** macOS does not reap a child when its parent is killed -9 or
crashes, and `applicationWillTerminate` never runs then. The `tali-app-lifeline`
plugin (`plugins/app-lifeline/`, bundled, inert unless `DSH_APP_BUNDLE` is
set and stdin is not a TTY) watches the stdin pipe the wrapper holds open and
exits the server 500 ms after EOF. Verified: `kill -9` of the wrapper → server
gone within 3 s.

## How the production tree is made (`tools/bundle/stage-dsh.mjs`)

This is where the traps were.

- **`pnpm deploy --prod` does not work for `@deepseek-ai/dsh`.** The CLI
  reaches half the workspace through `workspace:^` *peer* dependencies
  (dsh-app-boot → cordis-plugin-group, …) that only resolve because the
  monorepo root's devDependencies list everything. `deploy` drops them and the
  built `bin.js` dies with `ERR_MODULE_NOT_FOUND @deepseek-ai/cordis-plugin-group`;
  `deploy --legacy` refuses the spec outright. Upstream's Electron shell solves
  it with a packed "package set"; so does this script:
  `pnpm pack` every non-private workspace package (304 of 314; excludes the
  desktop shell, website, benchmarks, python closure, and the native platform
  packages of *other* platforms, whose `prepack` verifies a binary this host
  never built) into `dist/bundle/stage/tarballs/`, then install a staging
  project whose **overrides** pin every first-party name to its tarball.
  Root dependencies: `@deepseek-ai/dsh`, `dsh-base`, `dsh-web-app`,
  `dsh-headless`, plus the plugins. ~10 s to pack, ~7 s to install (store warm).
- **pnpm 12 ignores `pnpm.overrides` in package.json** ("no longer read")
  and then *silently* resolves `^0.1.6-alpha.2` from **registry.npmjs.org —
  upstream's published packages, not the fork's**. Measured: 125 tarball
  resolutions, the rest from the registry, in a tree that booted fine. The
  overrides now go into the stage's `pnpm-workspace.yaml`, and
  `verifyFirstParty()` fails the build if any first-party package's lockfile
  resolution lacks `tarball: file:tarballs/`.
- **`allowBuilds` keys must match the spec form.** A tarball-resolved package
  is checked as `name@file:tarballs/x.tgz`, so the checkout's
  `'@deepseek-ai/dsh-subprocess-local@file:packages/…': true` never matches;
  the script re-keys every allowed first-party name to its tarball form.
  (`--ignore-scripts` would skip node-pty's prebuild check and the
  spawn-helper chmod.)
- **Never stage under a symlinked path** (`/tmp` → `/private/tmp`): pnpm
  resolves the checkout's `patches/@electron__osx-sign….patch` relative to
  the target and reports "No such file". `dist/bundle/stage` in the repo works.
- **`pnpm pack --json` output is not pure JSON** when a package has a
  `prepack` script (its stdout comes first); parse the trailing object.
- **Plugins are packed too**, so their `link:` devDependencies into the
  checkout never enter the tree and their runtime deps come from the
  registry. This surfaced a real bug the dev `link:` install had hidden: two
  plugins' `files` lists omitted modules they import (`browser-automation`:
  environment/chrome-read/waiting/page-read.mjs; `dash-docsets`:
  docset-info.mjs) → "failed to import". Both now use `"*.mjs"`. The check
  worth re-running after adding a plugin: for each tarball, every `./x.mjs`
  import inside must be in the tarball.
- **A package merely present in `node_modules` is invisible to app-boot.**
  The resolution generation is a BFS over the dependency graph rooted at the
  launcher's manifest (`profile.ts resolveModuleFallbackEntries`,
  `INSTALL_ANCHOR = @deepseek-ai/dsh/package.json`). All 21 rows "failed to
  import" until `anchorPlugins()` added them to that manifest's
  `dependencies` (unlink first — with the hoisted linker it is a hard link
  into pnpm's store). This is the mechanism that lets the profile stay
  `dependencies: {}` and yet list the plugins as bundles.
- `@vscode/ripgrep` 1.18 ships platform prebuilds, no postinstall; the
  allow entry for it is harmless.

## The wrapper build and signing (`tools/bundle/build-app.mjs`)

Reuses `dock-app.mjs`'s `buildDockApp()` (swiftc via xcrun; every file in
`Sources/` is one module, so `EmbeddedServer.swift` just joins) and
`infoPlist()`, then adds `LSMultipleInstancesProhibited`. Node addons,
`bin/node`, `rg`, `spawn-helper` (9 Mach-O files after pruning; 219 with the
LibreOffice engine) are signed individually
before the bundle — a deep signature over unsigned Mach-O files is rejected by
the hardened runtime once a real identity is used. `--sign -` (default) is
ad-hoc: `codesign --verify --deep --strict` passes, `spctl --assess` says
**rejected**, i.e. a downloaded DMG needs right-click → Open (or Privacy &
Security → Open Anyway) once. A `Developer ID Application:` identity drops in
via `--sign` (adds `--options runtime --timestamp`); notarization
(`xcrun notarytool submit` + `stapler`) is not scripted yet.

DMG: `hdiutil create -format ULMO -fs APFS` over a staging folder with an
`/Applications` symlink. **hdiutil fails inside the DSH file sandbox** with
the misleading `create failed - Directory not empty` even for a 3-file folder
(diskimages-helper cannot attach); run the build from a terminal or use
`--no-dmg` and finish by hand.

## Testing without touching the live DSH

- The staged tree alone: `DSH_HOME=/tmp/x dist/bundle/node/*/bin/node dist/bundle/stage/node_modules/@deepseek-ai/dsh/lib/bin.js app --no-open --port 3099`
  after writing `/tmp/x/profiles/app/package.json` with the bundle list;
  `--dump-config` instead of `app` to check row resolution. (`web --no-open`
  is wrong: the launcher takes the profile name positionally.)
- The app: **launch it with `open -n`, not by running the executable from an
  agent shell** — a directly spawned app inherits the sandbox and WebKit
  cannot create its data store, the wrapper cannot write its log. Note that
  `open --env DSH_HOME=…` did *not* reach the process here, so the app used
  the real `~/.dsh` (creating `profiles/app` + `logs/dsh-app.log`, nothing
  else; the `web` profile is untouched). Remove those two afterwards if the
  test must leave no trace.
- See the window: `kill -USR1 <wrapper pid>` writes a PNG beside the log
  (`dock-app-integrated-titlebar.md`). **The window must be frontmost**:
  WebKit does not paint an occluded/background window, and the snapshot is
  then a uniform grey pane while the page's API calls keep flowing in the
  log — `open <app>` (no `-n`) activates it first. Quit: `kill <pid>` (SIGTERM). Orphan
  test: `kill -9 <pid>` then `pgrep -f 'lib/bin.js app'`.
- `osascript … quit app id` is denied from the agent shell (-10004).

## Size

Unpruned: 797 MB installed / 280 MB DMG (the tree pnpm produces is 640 MB +
node 116 MB). `build-app.mjs prune()` (skip with `--no-prune`) takes it to
**268 MB / 88 MB**, measured per category before it was written:

| Dropped | MB | Note |
|---|---|---|
| `@deepseek-ai/libreoffice-kit-darwin-arm64` | 259 | native Office → PDF engine; `--with-office` keeps it. `dsh-office-to-pdf` creates its converter lazily, so boot is unaffected and only an Office preview fails |
| `*.map` | 46 | |
| `*.ts` sources (not `.d.ts`) | 42 | vendored cordis/cosmokit ship `src/` beside `lib/`; zod/openai/anthropic ship theirs |
| `*.d.ts`/`.d.mts`/`.d.cts` | 41 | |
| three.js `examples/` + `src/` | 29 | the wolfram client bundle inlines its own copy |
| node-pty other-platform prebuilds | 24 | win32-x64/arm64 12 MB each |
| `strip -x` on `bin/node` | 24 | 121 → 97 MB; the stripped binary is SIGKILLed until re-signed, which the signing step does anyway |
| duplicate `sharp` + libvips under `tali-browser-automation/node_modules` | 19 | the plugin pinned `0.35.3` while the fork resolved `^0.35.3` → `0.35.4`; pin relaxed to the range |
| test dirs, `.github`, README/CHANGELOG-style `*.md`, `.tsbuildinfo` | ~15 | |

**Not** dropped: `*.md` wholesale — `SKILL.md`, the cordis preset guides and
chrome-devtools-mcp's 250 issue-description files are runtime data. What is
left: node 93 MB, `@deepseek-ai/*` ~70 MB (web frontend dist 18 MB), the LLM
SDKs (openai, anthropic, google/genai ~30 MB), OpenTelemetry 29 MB, node-pty
4 MB. Compressing node further would need a custom build.

## Updates (milestone 3)

**Publishing** — `pnpm release-app [--dry-run] [--skip-pack] [--notes "…"] [--draft]`
(`tools/bundle/release.mjs`, needs `gh auth login` with push rights):

1. Build number `YYYYMMDDnn` (UTC; `nn` = 01 + the day's existing
   `canary-YYYYMMDD*` tags) → `CFBundleVersion`; display version is the
   calver `2026.9.24` / `2026.9.24.2` (`CFBundleShortVersionString`).
2. `fetch-node` → `stage-dsh` → `build-app --build N --update-repo owner/name`.
3. `<dmg>.sha256` in `shasum -a 256` format.
4. `gh release create canary-N <dmg> <sha256> --latest --title "DSH Canary
   <version>"`; notes default to the commit subjects since the previous
   canary tag. Never a prerelease: GitHub's `releases/latest` (the feed) skips
   prereleases and drafts.

**In the app** — `Updater.swift`, configured by the `update` block of
`dsh-dock-app.json` (`{ repo, intervalHours: 6, feed: null }`). Check 10 s
after launch and every 6 h, plus **DSH Canary ▸ Check for Updates…**:
`GET https://api.github.com/repos/<repo>/releases/latest` (unauthenticated:
60 requests/h per IP is plenty; `User-Agent` is mandatory or GitHub answers
403), build = integer after the last `-` of `tag_name`, compared with
`CFBundleVersion` (a dev build has 0 and therefore always sees an update).
Newer → alert with the release notes: **Install and Relaunch / Later / Skip
This Version** (skip persists in UserDefaults `dsh.update.skipBuild`; a
manual check ignores it). Install:

1. Preflight: refuse when the bundle path contains `/AppTranslocation/` or
   starts with `/Volumes/` (running off the DMG) or the parent directory is
   not writable — the message says to move the app to Applications.
2. Download the `.dmg` asset (progress window), fetch the sibling
   `.dmg.sha256` asset, compare SHA-256 (CryptoKit); mismatch aborts.
3. `hdiutil attach -nobrowse -readonly -noverify -mountpoint <tmp>`; `cp -R`
   the `.app` from the image to a dot-prefixed sibling of the running bundle
   (same volume → the final rename is atomic); `codesign --verify --deep` on
   the copy; running bundle → Trash (`trashItem`, falls back to renaming it
   `<Name> (old).app`); rename the copy into place; detach.
4. Relaunch: `/bin/sh -c 'while kill -0 <pid>; do sleep .2; done; open <app>'`
   then `NSApp.terminate` — the poll matters because
   `LSMultipleInstancesProhibited` would refuse a second instance while the
   old one is still quitting; `applicationWillTerminate` stops the embedded
   server, the new copy starts its own.

Why no quarantine problem without a Developer ID: the DMG is fetched by the
app's own `URLSession` (no `LSFileQuarantineEnabled` in the plist), so neither
it nor the copied bundle carries `com.apple.quarantine`, and Gatekeeper is
not consulted on the relaunch. Only the *first* install (a browser-downloaded
DMG) hits "right-click → Open".

**Measured end to end (2026-09-24)** without a real release: app A built with
`--build 2026092401 --update-feed http://127.0.0.1:8765/latest.json`, app B
with `--build 2026092402` into a DMG, a hand-written `latest.json` in the
GitHub release shape served with `python3 -m http.server` beside the DMG and
its `.sha256`, and `defaults write io.github.taliesinb.dsh-app
dsh.update.autoInstall -bool true` (the headless hook: install without the
prompt). Launch A → 13 s later B was running from A's path, the server
restarted, and B's own check reported "latest 2026092402; running
2026092402". Delete the default afterwards (`defaults delete …`).

**Against a real release (2026-09-25):** the first `pnpm release-app --repo
<fork>` published `canary-2026092501` on a personal fork (nothing is
published on the upstream repo from a branch — releases there come from `main`
after the PR merges); an app built with `--build 2026092500 --update-repo
<fork>` found it through api.github.com, downloaded the 92 MB asset, verified,
swapped and relaunched in 19 s. Rate limit: unauthenticated 60/h per IP; one
check per launch + one per 6 h is far below it.

## Known gaps / next

- **Milestone 2 — first-run dialog** inside DSH (a host+client plugin,
  `app-setup`): detect Tailscale.app / STP / Chrome / afm / Dash / Mathematica,
  offer the free ones as "open download page / install", never install paid
  apps; port-conflict handling when 3090 is taken; the tailscale-remote
  plugin's default proxy ports vs a dev instance on the same Mac; the relay
  LaunchAgent as an *opt-in* (boot-on-demand tailnet access), registered via
  `SMAppService`, not a Homebrew-installed node.
- Updater follow-ups: a GitHub Actions release job (the fork build on a
  `macos-14` arm64 runner is ~15 min; `release.mjs` is written to run there
  unchanged given `gh` auth); Developer ID signing + notarization in
  `build-app.mjs --sign` (the swap itself needs neither); an x64 lane.
- Multi-arch: only `darwin-arm64` is staged (`OTHER_PLATFORM` filter + the
  Node tarball); an x64 build needs the build to run on x64 or a lipo pass.
- The `.pkg` idea was dropped: with everything inside the `.app` there is
  nothing left for `postinstall` to do, and the root-postinstall problems of
  `bootstrap-mac-installer.md` would return.

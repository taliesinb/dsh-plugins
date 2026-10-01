# The bundled macOS app: `DSH.app` in a DMG, nothing installed globally

**Status (2026-09-29): shipped and tested on a fresh OS** — a self-hosting
`DSH.app` (plain name, black whale; `pnpm canary --app` builds the red
**DSH <branch> <commit>**) carrying Node, the fork and all 24 plugins, a
52 MB DMG with the app icon on a disk-image drive and a proper install
window, **in-app updates from GitHub Releases** with one continuous progress
bar, and a **first-run checklist** that installs Tailscale / Safari
Technology Preview / Chrome / afm from vendor downloads through macOS's own
admin dialog. The whole flow, screenshot by screenshot, from a pristine
macOS 26 VM: [docs/bundled-app/README.md](../docs/bundled-app/README.md).

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

DMG: a read-write image (`hdiutil create -format UDRW`) over a staging folder
with the app, an `/Applications` symlink and `.background/backdrop.png`
(`Tools/make-dmg-background.swift`: the DSH near-white surface, a 6 % red
whale watermark off the right edge, a thin arrow, one grey caption at
660×400 pt rendered 2×); the image is mounted and **Finder itself** writes the
view settings into its `.DS_Store` through osascript — icon view, 128 px
icons, no toolbar/status/path bar, window bounds, backdrop, the two icon
positions matching the arrow — then `hdiutil convert -format ULMO` makes
the compressed read-only DMG (51 MB, smaller than the one-shot `create`).
Trap in the renderer: an `NSBitmapImageRep` whose `size` is set in points
already draws at 2×; an explicit `scaleBy(2)` on top gave 4× text. **hdiutil fails inside the DSH file sandbox** with
the misleading `create failed - Directory not empty` even for a 3-file folder
(diskimages-helper cannot attach); run the build from a terminal or use
`--no-dmg` and finish by hand.

## Testing without touching the live DSH

**The standard way (2026-09-29): `pnpm canary --app`** from the branch's
worktree — builds the app from the branch into `/tmp/dsh-canary/<branch>/`,
pinned to a throwaway home there, labelled `DSH <branch> <commit>`, no
updater; `pnpm canary stop|remove|logs|url` as for a source canary
(`canary-instances.md`). Everything below is the manual form it automates.

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
after launch and every 6 h, plus **DSH Canary ▸ Check for Updates… (⇧⌘U)** —
always listed in a bundled app, disabled ("off in this build") when the build
carries no feed (a `pnpm canary --app` build), via `validateMenuItem`:
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

## First run (milestone 2): `plugins/app-setup`

Both halves; README in the plugin. Host: detection (bundles under
`/Applications` + `~/Applications` + Setapp; commands on PATH + Homebrew bins;
`Tailscale status --json` for the connection state), a `./api/app-setup`
route (`state` / `dismiss` / `open` / `launch`), `__DSH_APP_SETUP__` global.
Browser: a `shell.overlay` Modal — one row per item, ● / ○, **Get…** (opens
the download page) or **Open** (installed Tailscale not connected), **Done**
— and the same rows as the bundle's `plugins.bundle.config` card. Armed only
under `DSH_APP_BUNDLE`. Design rule applied: no explanatory text; the
one-line status ("2 optional apps are not installed") is the whole copy.

Facts found building it:

- **The Plugins page hides installation-supplied bundles.** `listBundles`
  returns them, but `PluginManagerPage` lists only `installed` (in the
  profile's `dependencies`) or `optional` packages; installation bundles are
  meant for Settings ▸ Plugins ▸ Plugin list. So *no* bundled plugin's card
  (brand-kit's profiles, tailscale-remote's, this one) was reachable in the
  app. Fix: the profile template lists the plugins under `dependencies` by
  version — pnpm never installs them (they resolve from the installation
  anchor first), the entry only makes them visible. Side effect: the page
  offers **Uninstall**, which would edit the profile and is undone by the
  next launch's template merge.
- **Sequencing behind the shipped onboarding.** `WelcomeNotice` and the API
  key step render through `OnboardingModal`, which sets `#root.inert = true`
  while showing. The dialog polls that flag (400 ms) and opens only when the
  root is not inert; a one-shot check passes too early because the notice
  mounts after this component's first render. On a fresh home the chain is
  notice → API key (the latter re-shows every load until a key is saved or
  "Configure later") → this dialog.
- **A dropped plugin must not brick existing installs.** `~/.dsh/profiles/app`
  from the 09-25 release still listed `tali-wolfram-kernel-supervisor` (since
  moved to `extras/`); the new build failed to boot with `cannot resolve
  profile bundle`. `EmbeddedServer.mergeBundles` now reconciles: bundles the
  template previously wrote (`dsh.app.templateBundles`; a profile without the
  record is treated as all-template, since only this app ever created it) and
  no longer lists are removed; user-added ones stay. Measured: the stale
  profile repaired itself on launch.
- Testing the plugin from an agent shell: `env -i … | node bin.js app` with
  `DSH_APP_BUNDLE` set needs stdin held open (`sleep 3600 |`), or the
  lifeline plugin exits the server at once; and the stripped env breaks the
  Tailscale CLI ("The Tailscale GUI failed to start") — a test artefact, the
  real app's login-shell environment is fine. `launchctl setenv DSH_HOME`
  does not reach an `open`ed app either; the real-app trial ran against the
  live `~/.dsh` (only `profiles/app`, `logs/dsh-app.log`, `app-setup/` are
  touched). Twice, in the wrapper only, the dialog was dismissed ~4 s after
  launch by a **trusted click** on the Done button (logged with
  `isTrusted=true` at its exact coordinates); a third identical launch did
  not reproduce it and the instrumentation found no synthetic events. Left
  unexplained; if it recurs, the profile's `app-setup/state.json` is the
  thing to delete.

### Install from the dialog + real progress bars (2026-09-29, later)

- **Updater bar**: one continuous bar for the whole update — download
  0–60 %, verify 60–65 %, install 65–98 %, relaunch 100 — instead of the
  determinate download followed by an indeterminate "Installing…". The
  install phase is driven by a file-by-file copy (`copyTree`, sizes summed
  first, ≥ 50 ms between reports) replacing `cp -R`, which reports nothing;
  `codesign --verify --deep` afterwards is the proof the copy is intact.
  Measured 2026092800 → 2026092903 headless (`dsh.update.autoInstall`) in
  44 s, relaunched.
- **Install buttons** in the app-setup dialog (`plugins/app-setup/install.mjs`,
  table in its README): direct vendor downloads, `installer -pkg` through
  macOS's own admin dialog (`osascript … with administrator privileges`),
  Chrome by `ditto` to a staging name + rename, afm unpacked into
  `$DSH_HOME/app-setup/bin` — which `EmbeddedServer` prepends to PATH
  *inside* the login shell (`export PATH="$DSH_APP_BIN:$PATH"; exec "$@"`),
  after `.zprofile` had its say. Jobs live in the host route's memory
  (`state.jobs`), the dialog polls at 400 ms while one runs. Two lessons:
  never write over an existing `.app` (ditto over a running Chrome fails on
  every file with `Operation not permitted`; the installer now refuses), and
  errors go to the row as one line (`firstLine()`), the full text to the log.
- **Stage trap**: a `file:` tarball whose name@version is unchanged is served
  stale by pnpm's lockfile even when its bytes changed — an edited plugin
  survived three restages. `stage-dsh.mjs` drops the lockfile and the
  plugins' installed copies before every install (`forgetPlugins`; the 300
  fork tarballs re-resolve in ~4 s).
- Hook-order bug found by the canary: a `useRef`/`useEffect` placed after an
  early `return null` → React #310, the overlay entry crashed and the dialog
  never appeared. Hooks above the return.

## Fresh-OS test in a VM (2026-09-29)

`pnpm vm-test fresh` (`tools/vm-test.sh`) boots a pristine macOS 26 guest
with a window — Tart on Virtualization.framework, the Cirrus Labs vanilla
Tahoe image pulled once (28 GB, ~7 min) as `dsh-fresh-base`, each `fresh` a
copy-on-write `tart clone` of it. The host folder `/tmp/dsh-vm-share` is the
**only** channel into the guest: mounted read-only as the volume "DSH Share".
Drop the DMG there, then in the guest do exactly what a colleague would:
open the DMG, drag to Applications, right-click → Open (Gatekeeper on an
ad-hoc signed app), log in to the API key step, etc. Nothing else — no ssh,
no bootstrap script — enters the machine.

Update test: put the **latest** DMG in the share (the first-install
experience should be the current one — seeding an old build to give the
updater something to do was tried and regretted), install it, confirm ⇧⌘U
says up to date, *then* `pnpm release-app --repo <fork> --notes "update
test"` publishes a build whose only difference is its number; ⇧⌘U in the
guest now offers it, and Install and Relaunch should leave the newer build
running from `/Applications`.

Limits: Apple Intelligence is off in VMs (afm installs but reports not
enabled); Tailscale in the guest is a new tailnet node (one login). Homebrew's
`cirruslabs/cli/tart` tap is refused by Homebrew 6 (`depends_on macos:` form);
the release tarball in `~/Applications/tart.app` works. 16 GB host RAM: give
the guest 6 GB (`DSH_VM_MEM`); the image needs ~28 GB free.

### Rename and icons (2026-09-29, late)

- The release is plain **DSH** (`--name` default; `--glyph-color` default
  `#000000`, which the wrapper's identity script treats as "stock whale in
  the page"). Red + "DSH <branch> <commit>" is what `pnpm canary --app`
  passes. Release tags stay `canary-<build>`; the updater parses them and
  the fork's history depends on them.
- **Volume icon**: `.VolumeIcon.icns` on the mounted image + `SetFile -a C`
  on the root. Three traps, measured in order: `hdiutil create -srcfolder`
  drops a root-level `.VolumeIcon.icns`; Finder's view-settings pass
  (the layout osascript) drops it again, so it is copied *after* the
  layout; and Finder ignores it while the file carries
  `com.apple.provenance` (which `cp` adds) — `xattr -c` first, then the
  classic `icns`/`MACS` type on the file.
- **The icon artwork** (`Tools/make-dmg-icon.swift`): the system's own
  disk-image drive with the app tile on its face. On macOS 26 every API
  route to that artwork (`UTType.diskImage`, the `kGeneric*Icon` type
  codes, CoreTypes' loose `.icns`) returns a placeholder — the coloured
  icons live in asset catalogs — so the renderer creates a 1 MB throwaway
  image, mounts it, takes `NSWorkspace.icon(forFile:)` of the volume, and
  composites onto that.
- **The `.dmg` file's own icon** — what Downloads shows — is embedded
  *inside the UDIF container* with `hdiutil udifrez` (resource type `icns`,
  id −16455, the slot license agreements use). File bytes, so it survives
  HTTP downloads, VirtioFS shares and any copy. The first attempt used
  `NSWorkspace.setIcon` (a resource-fork xattr) and was wrongly declared
  the best possible: that one *is* stripped by downloads and by Tart's
  share, which is why the VM showed a generic icon. Verified: `xattr -c` +
  byte copy, the udifrez icon stays.
- Volume name `DSH <version>` so a mounted image is never confused with the
  installed app.

### Rebase onto main, 2026-09-29 (evening)

- Main's live set gained `backup-restore`; it goes into `plugins.txt` like
  every plugin `install-plugins.sh` installs. Its `pnpm-workspace.yaml` was
  pnpm 12's generated stub (`esbuild: set this to true or false`), so a
  fresh install of the plugin failed with `ERR_PNPM_IGNORED_BUILDS` — fixed
  to `esbuild: true` like the others.
- **The bundle must be built from the harness commit main pins**, not from
  whatever the live checkout is on. `import-sessions` on main imports
  `storeSessionLogs` from `dsh-session-log-export`, which exists at main's
  pin (`fc92737`) and not 21 commits earlier (`5029131`, where the live
  checkout sat); the staged plugin then fails to import at boot. Rebuilding
  the live checkout would hot-swap the running server, so the build uses a
  **worktree** of the submodule at the pinned commit (`git -C
  deepseek-harness worktree add .worktrees/harness-<sha> <sha>`, `pnpm
  install --frozen-lockfile && pnpm build` there, then `stage-dsh.mjs
  --checkout <worktree>`). `release.mjs` refuses a checkout whose HEAD
  differs from the repo's submodule pin.
- **A clean harness tree needs a two-pass build** at the pinned commit
  (`fc92737`; verified from scratch under Node 24): `build:lib:host` fails
  with 55 TS errors — `session-controller` / `workspace-files`
  `src/client/*` import `@…/remote`, the Typert artifacts
  (`lib/typert.remote-client.*`) that the same build's *tsdown* pass emits
  afterwards — but `tsc -b` has by then emitted every project not
  downstream of those two, which is enough for `pnpm exec tsdown
  --env.DSH_BUILD_FACE host` to generate the artifacts; a second
  `pnpm build` is then clean. A long-lived checkout never sees any of
  this: its stale `lib/` breaks the cycle and `tsc -b` is incremental.
  So: `pnpm install --frozen-lockfile; pnpm run build:lib:host || true;
  pnpm exec tsdown --env.DSH_BUILD_FACE host; pnpm build`. The CI job does
  exactly that. (Running tsdown *without* the first failing pass does not
  work — `cordis-plugin-hmr` has no entries yet; that was the false trail
  that briefly made this look unbuildable.) The real fix — the host
  tsconfig reference chain must not reach client sources — belongs
  upstream.

## Release pipeline (`.github/workflows/release-app.yml`)

`pnpm release-app` in a `macos-15` runner. Triggers: **Run workflow** (notes
+ draft inputs) or a push to `main` whose head commit subject starts with
`release:` (the rest of the subject is the notes). Checkout with tags; the
harness submodule initialised **by hand over HTTPS** (`.gitmodules` carries
SSH URLs and `extras` is private, so `submodules: true` would fail); pnpm
11.7 (the harness's `packageManager`), Node 24; the Typert-first harness
build; then `release.mjs --repo $GITHUB_REPOSITORY`, which enforces the
pin. `permissions: contents: write` is all `gh release create` needs; the
release's DMG + `.sha256` are what installed apps update from.

**pnpm 12 is required for the stage** and the workflow switches to it
(corepack) after building the harness with its own 11.7: pnpm 11 reads the
`pnpm-workspace.yaml` overrides but does not apply them to
`peerDependencies`, so the first CI run installed 87 first-party packages a
*second* time from npm through peer edges — two copies of every service,
the `Symbol.for` failure mode of `promotion-loop-and-duplicate-dsh-tools.md`
at package scale. `verifyFirstParty()` caught it; `stage-dsh.mjs` now also
refuses to run under pnpm < 12.

Runner: **`macos-26`** (arm64, macOS 26 SDK) — the wrapper's Liquid Glass
path uses `NSGlassEffectView`, and `#available` guards the call at run time
only; on `macos-15` it does not compile. Xcode on the image supplies
`SetFile`; the runner's logged-in session lets Finder write the DMG layout.
Four trial runs on the fork to get here (harness build order → pnpm 12 for
peers → the SDK → green); the fourth's DMG was downloaded, verified (sha,
embedded icon, `codesign --verify`, layout, volume icon) and its server
booted locally with all 25 plugins active.

Testing it needs the file on the repo's **default branch** (GitHub only
registers `workflow_dispatch` there) — on the fork the default was
temporarily switched to the PR branch for the trial run, then back.

## Known gaps / next

- Still open from the milestone-2 design: port-conflict handling when 3090
  is taken; the tailscale-remote plugin's proxy ports beside a dev instance
  on the same Mac; the relay LaunchAgent as an *opt-in* (boot-on-demand
  tailnet access) registered via `SMAppService` rather than a
  Homebrew-installed node; an in-dialog "download office support" for the
  LibreOffice engine the prune drops.
- Developer ID signing + notarization in `build-app.mjs --sign` (the swap
  itself needs neither); an x64 lane.
- Multi-arch: only `darwin-arm64` is staged (`OTHER_PLATFORM` filter + the
  Node tarball); an x64 build needs the build to run on x64 or a lipo pass.
- The `.pkg` idea was dropped: with everything inside the `.app` there is
  nothing left for `postinstall` to do, and the root-postinstall problems of
  `bootstrap-mac-installer.md` would return.

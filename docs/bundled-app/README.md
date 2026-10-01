# DSH for macOS — the bundled app, from a fresh Mac

What a colleague sees when handed the DMG and nothing else. The screenshots
(hosted as assets of the fork release they were taken with, not in this repo)
are from a **pristine macOS 26 virtual machine** (`pnpm vm-test fresh`,
[recipe](../../recipes/bundled-app-dmg.md)) into which only the `.dmg` was
copied: no Homebrew, no Node, no checkout, no scripts. Build 2026092906 →
2026092907, 2026-09-29.

How it is built and why: [recipes/bundled-app-dmg.md](../../recipes/bundled-app-dmg.md).
Per-branch throwaway instances for testing: [recipes/canary-instances.md](../../recipes/canary-instances.md).

## 1. Install

The DMG (≈ 52 MB) wears the app icon on a disk-image drive — embedded in
the file itself, so it looks the same in Downloads — mounts as
**DSH <version>**, and opens the usual drag-to-Applications window.

![DMG on the desktop](https://github.com/Demonstrandum/dsh-plugins/releases/download/canary-2026092907/01-dmg-on-desktop.png)
![Install window](https://github.com/Demonstrandum/dsh-plugins/releases/download/canary-2026092907/02-install-window.png)
![Copying 231 MB to Applications](https://github.com/Demonstrandum/dsh-plugins/releases/download/canary-2026092907/03-copying.png)

Right-click → Open the first time (ad-hoc signature; no Developer ID yet).
The app runs its own DSH server from inside the bundle (Node 24, the fork,
24 plugins) and opens its window in three to six seconds.

![Installed, in the Dock](https://github.com/Demonstrandum/dsh-plugins/releases/download/canary-2026092907/04-installed-dock.png)

## 2. First run

After the shipped onboarding steps (internal-testing notice, API key), the
**companion-apps checklist**: what DSH can use on this Mac that the app does
not carry. Each free item has **Get…** (the vendor's download page) and
**Install** (direct download + `installer -pkg` through macOS's own admin
dialog, or a DMG copy; nothing goes through Homebrew). Paid apps are only
listed when present.

![Setup dialog on a bare OS](https://github.com/Demonstrandum/dsh-plugins/releases/download/canary-2026092907/05-setup-dialog.png)
![Tailscale installed from the dialog](https://github.com/Demonstrandum/dsh-plugins/releases/download/canary-2026092907/06-tailscale-installed.png)
![Safari Technology Preview installing](https://github.com/Demonstrandum/dsh-plugins/releases/download/canary-2026092907/07-installing-stp.png)
![Everything installed](https://github.com/Demonstrandum/dsh-plugins/releases/download/canary-2026092907/08-all-installed.png)

All four installed from the dialog on the bare VM: Tailscale (`.pkg`, admin
prompt), Safari Technology Preview (`.pkg` inside Apple's DMG, admin prompt),
Chrome (DMG → `/Applications`), afm (GitHub tarball into the app's own
`bin`, which its server has on `PATH`). The dialog is available afterwards
from the bundle's card on the Plugins page.

## 3. Updates

**DSH ▸ Check for Updates… (⇧⌘U)** reads the GitHub Releases feed the build
points at (`--update-repo`); it also checks ten seconds after launch and
every six hours.

![Up to date](https://github.com/Demonstrandum/dsh-plugins/releases/download/canary-2026092907/09-up-to-date.png)

A newer release published → the prompt with its notes:

![Update available](https://github.com/Demonstrandum/dsh-plugins/releases/download/canary-2026092907/10-update-available.png)

**Install and Relaunch**: one continuous bar through download (SHA-256
verified against the release's `.sha256`), the copy beside the current
bundle, `codesign --verify`, swap, relaunch.

![Downloading](https://github.com/Demonstrandum/dsh-plugins/releases/download/canary-2026092907/11-downloading.png)
![Installing](https://github.com/Demonstrandum/dsh-plugins/releases/download/canary-2026092907/12-installing.png)
![Relaunched on the new build](https://github.com/Demonstrandum/dsh-plugins/releases/download/canary-2026092907/13-updated.png)

The updated app relaunched **without a second Gatekeeper prompt** (the copy
is made by the app itself, no quarantine flag), and its About panel and
⇧⌘U report build 2026092907.

## For maintainers

```sh
pnpm build-app                 # dist/bundle/DSH.app + DSH-<version>-<build>.dmg
pnpm release-app --repo <o/r>  # build → DMG → sha256 → GitHub Release (tag canary-<build>)
pnpm canary --app              # this branch as a throwaway app, own home, no updater
pnpm vm-test fresh             # pristine macOS guest; /tmp/dsh-vm-share is its only way in
```

The release name is plain **DSH**; the red-whale **DSH <branch> <commit>**
is what `pnpm canary` builds. Release tags stay `canary-<build>` — they are
what the updater compares against `CFBundleVersion`.

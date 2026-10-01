# tali-app-setup

First-run checklist for the bundled macOS app (**DSH Canary**): the companion
apps DSH can use but does not carry — Tailscale (remote access), Safari
Technology Preview and Google Chrome (browser automation), afm (the on-device
Apple Foundation model server) — and whether each is present. One button per
missing free item, **Get…**, opens its download page in the default browser;
Tailscale that is installed but not connected gets **Open**. Paid apps (Dash,
Mathematica) are listed only when present and never offered.

- Shown once, after the shipped onboarding steps (Internal Testing Notice,
  API key) have been dismissed — those steps mark the app root `inert` while
  they show, and this dialog waits until it is not. **Done** / **×** / Escape
  record the dismissal in `$DSH_HOME/app-setup/state.json`.
- Always available afterwards from the bundle's card on the **Plugins** page
  (**Companion apps**, with **Refresh**).
- Inert outside the bundled app: both halves register nothing unless the
  wrapper's `DSH_APP_BUNDLE` environment variable is present (the host half
  publishes `__DSH_APP_SETUP__` to the page only then).

## Installing from the dialog

Free items whose vendor ships a direct download get an **Install** button
(`install.mjs`), Homebrew not involved:

| Item | Source | Step | Admin? |
|---|---|---|---|
| Tailscale | `pkgs.tailscale.com/stable/Tailscale-latest-macos.pkg` | `installer -pkg -target /` | yes |
| Safari Technology Preview | the current DMG linked from developer.apple.com/safari/download | mount → `installer -pkg` | yes |
| Google Chrome | `dl.google.com/…/googlechrome.dmg` | mount → `ditto` to a staging name → rename into `/Applications` | only if `/Applications` is not writable |
| afm | latest arm64 tarball of scouzi1966/maclocal-api | unpacked into `$DSH_HOME/app-setup/bin`, which the app's server has on `PATH` | no |

Admin steps go through `osascript … with administrator privileges`: macOS
shows its own password dialog; DSH never sees the password. The row shows
**Downloading N %** (bytes over Content-Length) then **Installing** with a
sweeping segment (`installer`/`ditto` report nothing), then re-detects. An
existing app is never overwritten (the row says so). Failures show one line;
the full text is in the server log. Paid apps have no Install button.

## Route

`GET/POST ./api/app-setup?action=…` — `state` (items + `firstRun`),
`dismiss`, `open&item=<id>` (free items' download page via `open <url>`),
`launch&item=<id>` (`open -a` an installed app), `refresh`.

Detection: application bundles under `/Applications` (and `~/Applications`,
Setapp's directory for Dash), commands on `PATH` plus the two Homebrew bin
directories for afm / wolframscript, and `Tailscale status --json` for the
connection state (`BackendState`, the node's DNS name and login).

Recipe: `recipes/bundled-app-dmg.md` (milestone 2).

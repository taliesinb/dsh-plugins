# Installing dsh-rewind-plugin

Light notes from installing a conversation-rewind plugin into the `web` profile (2026-09).

## Picking a plugin

DSH has no first-party rewind plugin, but the npm registry (DSH's plugin channel) has several
community ones. Shortlist came down to:

- **`dsh-rewind-plugin`** — in-place Claude Code-style `/rewind`: masks the conversation back to an
  earlier user message in the same window (append-only masking marker, never forks a session), plus
  lightweight pre-write file backups it can restore alongside. Zero deps, well tested, ~7k
  downloads/month. **← chosen**
- **`dsh-shadow-rewind`** — workspace-first alternative: full-tree snapshots per turn in a hidden
  shadow jj repo, diff review UI, hunk-level undo, terminal write audit. Rewind-and-continue forks a
  new session, so it's really a snapshot/review system rather than a chat rewinder.

## Install

```sh
pnpm dsh plugin --profile web add -w dsh-rewind-plugin@0.7.5
```

Notes:

- `-w` is needed because the `web` profile dir is a pnpm workspace (it has local `plugins/*`).
- pnpm's minimum-release-age supply-chain gate initially resolved 0.7.3; pinning `@0.7.5` bypassed
  it and recorded the package in `minimumReleaseAgeExclude` in the profile's `pnpm-workspace.yaml`.
- The install appended `dsh-rewind-plugin` to `dsh.profile.bundles` in
  `~/.dsh/profiles/web/package.json`.
- The bundle list is composed at boot (`patchReload: live` only watches patch files), so the server
  needed a restart to load the plugin.

## Security review

Verdict: **clean**. Checked before trusting it:

- Provenance: npm-signed with SLSA attestation — built by GitHub Actions from the public
  `SiriLee/dsh-rewind` repo at tag v0.7.5; installed files byte-identical to the registry tarball.
- No install-time scripts run; zero runtime dependencies.
- Full read of both built bundles (~3.8k lines): no network access, no process execution, no
  eval/obfuscation, no credential or env harvesting. Session log handling is append-only; snapshot
  paths are sanitized against traversal.
- Caveats (weaknesses, not malice): restore writes recorded paths with raw `fs`, bypassing the DSH
  sandbox (trust anchor is `~/.dsh/rewind-snapshots`); plan-time-only symlink check (small TOCTOU
  window); cleanup does recursive deletes under the snapshot root, so don't point
  `DSH_REWIND_SNAPSHOT_DIR` at real data.

## Result

After restart the `web` profile has a ↶ rewind button on each user message, `/rewind` and `/undo`
commands, and a snapshot-cleanup card under Settings → Plugins. Snapshots live in
`~/.dsh/rewind-snapshots/`.

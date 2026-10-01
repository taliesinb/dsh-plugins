#!/usr/bin/env bash
# vm-test.sh — a pristine macOS guest for testing the bundled app (DSH Canary
# DMG) the way a colleague meets it: nothing enters the VM but the DMG.
#
#   pnpm vm-test fresh           # new pristine VM "dsh-fresh" from the base image, booted with a window
#   pnpm vm-test run             # boot the existing dsh-fresh again (state kept)
#   pnpm vm-test stop            # shut it down
#   pnpm vm-test reset           # delete dsh-fresh (the base image stays)
#   pnpm vm-test share           # print what the guest sees in the shared folder
#   pnpm vm-test ip              # the guest's IP (once booted)
#
# The guest sees $SHARE (default /tmp/dsh-vm-share) read-only as a volume
# named "DSH Share" — drop the DMG(s) there on the host, open them in the guest's
# Finder, drag to Applications, right-click → Open. No ssh, no scripts, no
# copying: that folder is the only channel, and it is read-only for the guest.
#
# Base image: ghcr.io/cirruslabs/macos-tahoe-vanilla (macOS 26, user admin /
# admin, ssh on — unused here), pulled once as the local VM "dsh-fresh-base".
# `fresh` is a `tart clone` of it: a copy-on-write snapshot, seconds, so every
# test starts from the same untouched OS. Apple Intelligence does not run in a
# VM (afm can install but reports "not enabled"); Tailscale works (a new node,
# needs one login). Tart is the release binary in ~/Applications/tart.app
# (the Homebrew tap was refused by Homebrew 6 on 2026-09-29).
set -euo pipefail
TART="${TART:-$HOME/Applications/tart.app/Contents/MacOS/tart}"
[ -x "$TART" ] || TART="$(command -v tart || true)"
[ -x "${TART:-}" ] || { echo "tart not found: curl -sSL https://github.com/cirruslabs/tart/releases/latest/download/tart.tar.gz | tar -xz -C ~/Applications" >&2; exit 1; }
BASE="${DSH_VM_BASE:-dsh-fresh-base}"
VM="${DSH_VM:-dsh-fresh}"
SHARE="${DSH_VM_SHARE:-/tmp/dsh-vm-share}"
CPU="${DSH_VM_CPU:-4}"
MEM="${DSH_VM_MEM:-6144}"

note() { printf '▸ %s\n' "$*"; }

run_vm() {
  mkdir -p "$SHARE"
  note "booting $VM (${CPU} cpu, ${MEM} MB) — shared folder '$SHARE' → 'DSH Share' (read-only) in the guest"
  "$TART" set "$VM" --cpu "$CPU" --memory "$MEM" >/dev/null
  # Foreground with a window; Ctrl-C here is a hard stop, use `stop` from another shell for a clean one.
  exec "$TART" run "$VM" --dir="DSH Share:$SHARE:ro"
}

case "${1:-}" in
  fresh)
    "$TART" list --quiet 2>/dev/null | grep -qx "$BASE" || { echo "base image '$BASE' missing: $TART clone ghcr.io/cirruslabs/macos-tahoe-vanilla:latest $BASE" >&2; exit 1; }
    if "$TART" list --quiet 2>/dev/null | grep -qx "$VM"; then "$TART" stop "$VM" 2>/dev/null || true; "$TART" delete "$VM"; note "deleted previous $VM"; fi
    "$TART" clone "$BASE" "$VM"
    note "cloned $BASE → $VM (pristine)"
    run_vm ;;
  run) run_vm ;;
  stop) "$TART" stop "$VM" && note "stopped $VM" ;;
  reset) "$TART" stop "$VM" 2>/dev/null || true; "$TART" delete "$VM" && note "deleted $VM" ;;
  share) ls -la "$SHARE" ;;
  ip) "$TART" ip "$VM" ;;
  *) sed -n '2,24p' "$0" ;;
esac

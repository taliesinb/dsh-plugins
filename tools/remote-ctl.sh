#!/usr/bin/env bash
# remote-ctl.sh <logs|status|restart|stop> [user@host] — day-to-day control of the
# LaunchAgent that deploy-remote.sh installs.
set -euo pipefail
CMD="${1:-status}"; TARGET="${2:-${DSH_REMOTE_TARGET:-alpha@192.168.0.42}}"
LABEL="ai.symbolica.dsh-remote"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 "$TARGET")
case "$CMD" in
  logs) exec "${SSH[@]}" -t 'tail -n 80 -f ~/dsh/logs/dsh.log' ;;
  status) "${SSH[@]}" bash -s -- "$LABEL" <<'REMOTE'
set -u; LABEL="$1"; TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
echo "launchd:  $(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E 'state =|pid =' | tr -s ' ' | tr '\n' ' ' || echo 'not loaded')"
echo "http:     $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3080/ || echo down) (401 = up, auth wall)"
echo "node:     $(~/.local/node/bin/node --version 2>/dev/null || echo missing)"
echo "checkout: $(cat ~/dsh/checkout/package.json 2>/dev/null | grep '"version"' | tr -d ' ,')"
echo "serve:    $("$TS" serve status 2>/dev/null | tr '\n' ' ' || echo unavailable)"
echo "log tail:"; tail -n 5 ~/dsh/logs/dsh.log 2>/dev/null | sed 's/^/  /'
REMOTE
  ;;
  restart) "${SSH[@]}" "launchctl kickstart -k gui/\$(id -u)/$LABEL && echo restarted" ;;
  stop) "${SSH[@]}" "launchctl bootout gui/\$(id -u)/$LABEL && echo stopped (will not restart until the next deploy)" ;;
  *) echo "usage: remote-ctl.sh <logs|status|restart|stop> [user@host]" >&2; exit 2 ;;
esac

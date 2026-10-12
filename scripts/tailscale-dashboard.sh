#!/bin/bash
# Share the Home Compute dashboard with your own tailnet over HTTPS, through
# `tailscale serve` on a port of its own. The controller stays on 127.0.0.1;
# nothing is ever exposed to the internet (this script never uses funnel).
#
#   scripts/tailscale-dashboard.sh            # what it would do, and the current serve config
#   scripts/tailscale-dashboard.sh on         # serve https://<this machine>.<tailnet>.ts.net:8443/
#   scripts/tailscale-dashboard.sh off        # stop serving that port (other ports untouched)
#
# HC_TAILNET_PORT (default 8443) and HC_API_PORT (default 4786) change the ports.
set -euo pipefail

PORT="${HC_TAILNET_PORT:-8443}"
API_PORT="${HC_API_PORT:-4786}"
TARGET="http://127.0.0.1:$API_PORT"

if command -v tailscale >/dev/null 2>&1; then
  TS="$(command -v tailscale)"
elif [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
  TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
else
  echo "Tailscale's CLI was not found." >&2
  exit 1
fi

case "$PORT" in
  ''|*[!0-9]*) echo "HC_TAILNET_PORT must be a port number" >&2; exit 2 ;;
esac
case "$API_PORT" in
  ''|*[!0-9]*) echo "HC_API_PORT must be a port number" >&2; exit 2 ;;
esac

host="$("$TS" status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,"")))')"
url="https://$host:$PORT/"

# What `tailscale serve` already does on PORT, if anything: "none", our target, or something else.
current() {
  "$TS" serve status --json 2>/dev/null | PORT="$PORT" HOST="$host" node -e '
    let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
      const status = s.trim() ? JSON.parse(s) : {};
      const web = status.Web?.[`${process.env.HOST}:${process.env.PORT}`];
      const funnel = Object.keys(status.AllowFunnel ?? {}).some((key) => key.endsWith(`:${process.env.PORT}`));
      if (funnel) { console.log("funnel"); return; }
      if (!web && !status.TCP?.[process.env.PORT]) { console.log("none"); return; }
      console.log(web?.Handlers?.["/"]?.Proxy ?? "other");
    });'
}

state="$(current)"
case "${1:-show}" in
  show|status)
    echo "Dashboard on the tailnet: $url  ->  $TARGET"
    echo "Port $PORT is now: $state"
    echo "Turn on with:  $TS serve --bg --https=$PORT $TARGET"
    echo "Turn off with: $TS serve --https=$PORT off"
    echo
    "$TS" serve status
    ;;
  on)
    if [ "$state" = funnel ]; then
      echo "Port $PORT is funnelled to the internet. Turn that off first: $TS funnel --https=$PORT off" >&2
      exit 1
    fi
    if [ "$state" != none ] && [ "$state" != "$TARGET" ]; then
      echo "Port $PORT already serves $state; choose another with HC_TAILNET_PORT." >&2
      exit 1
    fi
    "$TS" serve --bg --https="$PORT" "$TARGET"
    echo "Open $url on any of your tailnet devices."
    ;;
  off)
    if [ "$state" = none ]; then echo "Port $PORT is not served."; exit 0; fi
    if [ "$state" != "$TARGET" ]; then
      echo "Port $PORT serves $state, not the dashboard; leaving it alone." >&2
      exit 1
    fi
    "$TS" serve --https="$PORT" off
    ;;
  *)
    sed -n '2,/^set -euo/{/^#/p;}' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac

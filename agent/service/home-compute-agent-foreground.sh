#!/bin/sh
# Supervises `home-compute-agent run` where there is no systemd (a container
# whose init is tini, for example). Run this in the foreground.
#
# `run` itself is one process: SIGTERM or SIGINT makes it exit 0 and leave
# any job running, to be adopted on the next start. This loop treats that
# exit 0 as a clean stop. Any other exit waits 5 seconds and starts again.
set -u
NODE="${HC_AGENT_NODE:-/opt/home-compute/node/bin/node}"
BIN="${HC_AGENT_BIN:-/opt/home-compute/agent/current/home-compute-agent.mjs}"
STATE="${HC_AGENT_STATE_DIR:-/var/lib/home-compute}"
child=0

stop() {
  if [ "$child" -gt 0 ]; then
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  exit 0
}
trap stop TERM INT

while true; do
  "$NODE" "$BIN" run --state-dir "$STATE" &
  child=$!
  wait "$child"
  code=$?
  child=0
  if [ "$code" -eq 0 ]; then
    exit 0
  fi
  echo "home-compute-agent exited ${code}; restarting in 5s" >&2
  sleep 5
done

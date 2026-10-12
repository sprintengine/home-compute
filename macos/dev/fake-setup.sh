#!/bin/bash
# A stand-in for wingfoil's deploy/home-compute/macmini.sh that answers the menu bar app's
# control contract without touching Colima, Bacalhau, launchd or R2. State lives in a scratch
# directory: $FAKE_SETUP_DIR, else fake-setup/ next to $HOME_COMPUTE_BAR_CONFIG, else
# $TMPDIR/hcb-fake-setup. Delete that directory to start over (not set up, everything stopped).
#
# Knobs (files in the state directory):
#   delay        seconds between streamed lines of long commands (default 0.25)
#   fail-image   if present, `image` fails with exit 1 halfway through
#
# Deliberate errors: `env set S3_ENDPOINT_URL` without https://, `jobs set` with minutes that
# aren't multiples of 5, hours outside 0-23, an unknown memory size, or a schedule on the prune
# job all exit 2 with {"ok": false, "error": …}. `r2-test` fails (ok: false) when the bucket is "bad".
set -euo pipefail

if [ -n "${FAKE_SETUP_DIR:-}" ]; then
  STATE="$FAKE_SETUP_DIR"
elif [ -n "${HOME_COMPUTE_BAR_CONFIG:-}" ]; then
  STATE="$(dirname "$HOME_COMPUTE_BAR_CONFIG")/fake-setup"
else
  STATE="${TMPDIR:-/tmp}/hcb-fake-setup"
fi
mkdir -p "$STATE"
ENV_FILE="$STATE/env"
JOBS_FILE="$STATE/jobs.json"
LOGS="$STATE/logs"
export STATE ENV_FILE JOBS_FILE LOGS

flag() { [ -f "$STATE/$1" ]; }
set_flag() { if [ "$2" = 1 ]; then touch "$STATE/$1"; else rm -f "$STATE/$1"; fi; }
delay() { cat "$STATE/delay" 2>/dev/null || echo 0.25; }
line() { printf '%s\n' "$*"; sleep "$(delay)"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; sleep "$(delay)"; }

init() {
  [ -f "$ENV_FILE" ] || cat > "$ENV_FILE" <<'ENV'
S3_BUCKET=force5-forecast
S3_ENDPOINT_URL=https://0123456789abcdef.r2.cloudflarestorage.com
S3_PREFIX=
AWS_REGION=auto
ECMWF_SOURCE=ecmwf
WINGFOIL_IMAGE=wingfoil-forecast:local
FORCE5_SIDECARS=0
AWS_ACCESS_KEY_ID=AKIAFAKEFAKEab12
AWS_SECRET_ACCESS_KEY=fake-secret
HOME_COMPUTE_API_TOKEN=dev-token
ENV
  [ -f "$JOBS_FILE" ] || cat > "$JOBS_FILE" <<'JOBS'
{"cronStepMinutes": 5, "memoryChoices": ["512Mb", "1Gb", "2Gb", "3Gb", "4Gb", "5Gb"],
 "jobs": [
  {"id": "harmonie", "description": "HARMONIE-AROME (Met Éireann), hourly DINI cycle", "models": ["harmonie"], "command": "worker",
   "enabled": true, "hours": null, "minutes": [45], "memory": "4Gb", "defaultMemory": "4Gb", "timeoutSeconds": 3300, "scheduleEditable": true},
  {"id": "gfs", "description": "GFS 0.25° and GFS-Wave", "models": ["gfs", "gfswave"], "command": "worker",
   "enabled": true, "hours": [3, 9, 15, 21], "minutes": [30], "memory": "3Gb", "defaultMemory": "3Gb", "timeoutSeconds": 3300, "scheduleEditable": true},
  {"id": "ecmwf", "description": "ECMWF IFS open data", "models": ["ecmwf", "ecmwf-wave"], "command": "worker",
   "enabled": false, "hours": [1, 7, 13, 19], "minutes": [0, 30], "memory": "5Gb", "defaultMemory": "4Gb", "timeoutSeconds": 5400, "scheduleEditable": true},
  {"id": "prune", "description": "Delete old runs from the bucket", "models": [], "command": "prune",
   "enabled": true, "hours": [4], "minutes": [10], "memory": "512Mb", "defaultMemory": "512Mb", "timeoutSeconds": 600, "scheduleEditable": false}
 ]}
JOBS
  mkdir -p "$LOGS"
  [ -f "$LOGS/controller.log" ] || echo "fake controller log" > "$LOGS/controller.log"
  [ -f "$LOGS/bacalhau.log" ] || echo "fake bacalhau log" > "$LOGS/bacalhau.log"
}

env_value() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- || true; }

fail_json() { python3 -c 'import json,sys; print(json.dumps({"ok": False, "error": sys.argv[1]}))' "$1"; exit 2; }
ok_json() { echo '{"ok": true, "restartRequired": true}'; }

state_json() {
  python3 - <<'PY'
import json, os
state = os.environ["STATE"]
def flag(name): return os.path.exists(os.path.join(state, name))
def read(name):
    try: return open(os.path.join(state, name)).read().strip()
    except OSError: return None
complete = flag("setup-complete")
colima = "running" if flag("colima") else "stopped"
bacalhau = "running" if flag("bacalhau") else "stopped"
controller = "running" if flag("controller") else "stopped"
built = read("image-built-at")
source_hash = read("image-hash")
current_hash = read("current-hash") or "c0ffee1234567890"
print(json.dumps({
  "paths": {"wingfoil": "/fake/wingfoil", "homeCompute": "/fake/home-compute", "envFile": os.environ["ENV_FILE"],
            "jobsFile": os.environ["JOBS_FILE"], "logs": os.environ["LOGS"],
            "controllerLog": os.path.join(os.environ["LOGS"], "controller.log"),
            "bacalhauLog": os.path.join(os.environ["LOGS"], "bacalhau.log")},
  "setup": {"complete": complete, "envFile": True, "r2Configured": True, "agents": complete,
            "homeComputeDeps": complete, "configCurrent": complete,
            "tools": {"colima": True, "docker": True, "node": True, "bacalhau": not flag("missing-bacalhau")}},
  "services": {
    "colima": {"state": colima, "cpus": 4, "memoryGiB": 6, "autostart": flag("autostart")},
    "bacalhau": {"state": bacalhau, "loaded": bacalhau == "running", "nodes": 1 if bacalhau == "running" else 0},
    "controller": {"state": controller, "loaded": controller == "running", "answering": controller == "running"}},
  "image": {"name": "wingfoil-forecast:local", "present": built is not None, "builtAt": built,
            "sourceHash": source_hash or None, "currentHash": current_hash,
            "stale": (source_hash != current_hash) if source_hash else None,
            "sizeBytes": 531000000 if built else None},
}))
PY
}

env_json() {
  python3 - <<'PY'
import json, os
values, secrets = {}, {}
for raw in open(os.environ["ENV_FILE"]):
    raw = raw.rstrip("\n")
    if not raw or raw.startswith("#") or "=" not in raw: continue
    key, value = raw.split("=", 1)
    values[key] = value
secret_keys = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "HOME_COMPUTE_API_TOKEN"]
for key in secret_keys:
    value = values.pop(key, "")
    secrets[key] = {"set": bool(value), "hint": ("…" + value[-4:]) if key == "AWS_ACCESS_KEY_ID" and value else None}
print(json.dumps({"exists": True, "values": values, "secrets": secrets}))
PY
}

env_set() {
  local name="${1:-}" value
  case "$name" in
    S3_BUCKET|S3_ENDPOINT_URL|S3_PREFIX|AWS_REGION|ECMWF_SOURCE|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY) ;;
    *) fail_json "$name can't be set from here" ;;
  esac
  IFS= read -r value || true
  case "$name" in
    S3_ENDPOINT_URL) [[ "$value" == https://* ]] || fail_json "S3_ENDPOINT_URL must start with https://" ;;
    S3_BUCKET) [ -n "$value" ] || fail_json "S3_BUCKET can't be empty" ;;
  esac
  python3 - "$name" "$value" <<'PY'
import os, sys
name, value = sys.argv[1], sys.argv[2]
path = os.environ["ENV_FILE"]
lines = open(path).read().splitlines()
out, done = [], False
for raw in lines:
    if raw.startswith(name + "="):
        out.append(f"{name}={value}"); done = True
    else:
        out.append(raw)
if not done: out.append(f"{name}={value}")
open(path, "w").write("\n".join(out) + "\n")
PY
  ok_json
}

r2_test() {
  local bucket
  bucket="$(env_value S3_BUCKET)"
  sleep 1
  if [ "$bucket" = bad ]; then
    python3 -c 'import json,sys; print(json.dumps({"ok": False, "bucket": sys.argv[1], "endpoint": sys.argv[2], "objectsSeen": 0, "manifests": [], "error": "NoSuchBucket: The specified bucket does not exist"}))' "$bucket" "$(env_value S3_ENDPOINT_URL)"
    return
  fi
  python3 - "$bucket" "$(env_value S3_ENDPOINT_URL)" <<'PY'
import json, sys
from datetime import datetime, timedelta, timezone
now = datetime.now(timezone.utc)
def ago(minutes): return (now - timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")
def run(minutes): return (now - timedelta(minutes=minutes)).strftime("%Y%m%d%H")
print(json.dumps({"ok": True, "bucket": sys.argv[1], "endpoint": sys.argv[2], "objectsSeen": 412, "error": None,
  "manifests": [
    {"model": "harmonie", "key": "weather/harmonie.json", "run": run(120), "lastModified": ago(42), "missing": False},
    {"model": "gfs", "key": "weather/gfs.json", "run": run(400), "lastModified": ago(190), "missing": False},
    {"model": "ecmwf", "key": "weather/ecmwf.json", "run": None, "lastModified": None, "missing": True}]}))
PY
}

token_rotate() {
  local token
  token="fake-$(openssl rand -hex 8)"
  python3 - "$token" <<'PY'
import json, os, sys
token = sys.argv[1]
env = os.environ["ENV_FILE"]
lines = [l for l in open(env).read().splitlines() if not l.startswith("HOME_COMPUTE_API_TOKEN=")]
open(env, "w").write("\n".join(lines + [f"HOME_COMPUTE_API_TOKEN={token}"]) + "\n")
# Only ever touch the app's config when it's an explicit (test) override, never ~/.config.
config = os.environ.get("HOME_COMPUTE_BAR_CONFIG")
if config:
    try: data = json.load(open(config))
    except (OSError, ValueError): data = {}
    data["token"] = token
    json.dump(data, open(config, "w"), indent=2)
PY
  ok_json
}

jobs_set() {
  local id="${1:-}"; shift || true
  python3 - "$id" "$@" <<'PY'
import json, os, sys
def fail(message):
    print(json.dumps({"ok": False, "error": message})); sys.exit(2)
path = os.environ["JOBS_FILE"]
data = json.load(open(path))
job_id, args = sys.argv[1], sys.argv[2:]
job = next((j for j in data["jobs"] if j["id"] == job_id), None)
if job is None: fail(f"No job {job_id!r}")
if len(args) % 2: fail("Each option needs a value")
step = data["cronStepMinutes"]
for flag, value in zip(args[::2], args[1::2]):
    if flag == "--enabled":
        if value not in ("true", "false"): fail("--enabled takes true or false")
        job["enabled"] = value == "true"
    elif flag in ("--hours", "--minutes"):
        if not job.get("scheduleEditable", True): fail(f"{job_id}'s schedule can't be changed")
        if flag == "--hours" and value == "every":
            job["hours"] = None; continue
        try: numbers = sorted({int(v) for v in value.split(",")})
        except ValueError: fail(f"{flag} takes a comma-separated list of numbers")
        if flag == "--hours":
            if any(h < 0 or h > 23 for h in numbers): fail("Hours must be 0-23")
            job["hours"] = numbers
        else:
            bad = [m for m in numbers if m < 0 or m > 59 or m % step]
            if bad: fail(f"Minutes must be multiples of {step} between 0 and 55 (got {', '.join(map(str, bad))})")
            job["minutes"] = numbers
    elif flag == "--memory":
        if value not in data["memoryChoices"]: fail(f"Memory must be one of {', '.join(data['memoryChoices'])}")
        job["memory"] = value
    else:
        fail(f"Unknown option {flag}")
json.dump(data, open(path, "w"), indent=1, ensure_ascii=False)
print(json.dumps({"ok": True, "restartRequired": True}))
PY
}

start_all() {
  flag setup-complete || { echo "Run setup first" >&2; exit 1; }
  bold "Starting Colima"
  line "INFO[0000] starting colima"
  line $'\033[32mINFO\033[0m[0001] starting ... context=vm'
  set_flag colima 1
  bold "Started dev.sprintengine.bacalhau"
  set_flag bacalhau 1
  line "Waiting for Bacalhau's node"
  bold "Started dev.sprintengine.home-compute"
  set_flag controller 1
  echo "Logs: $LOGS"
}

stop_all() {
  if flag controller; then set_flag controller 0; bold "Stopped dev.sprintengine.home-compute"; fi
  if flag bacalhau; then set_flag bacalhau 0; bold "Stopped dev.sprintengine.bacalhau"; fi
  line "Colima keeps running"
}

build_image() {
  bold "Building wingfoil-forecast:local from force5/Dockerfile"
  for step in 1 2 3 4 5 6; do
    line "#$step [$step/6] RUN step $step"
    printf 'progress 10%%\rprogress 60%%\rprogress 100%%\n'
    if [ "$step" = 3 ] && flag fail-image; then
      echo "ERROR: failed to solve: process \"/bin/sh -c pip install\" did not complete successfully: exit code: 1" >&2
      exit 1
    fi
  done
  date -u +%Y-%m-%dT%H:%M:%SZ > "$STATE/image-built-at"
  cat "$STATE/current-hash" 2>/dev/null > "$STATE/image-hash" || echo c0ffee1234567890 > "$STATE/image-hash"
  [ -s "$STATE/image-hash" ] || echo c0ffee1234567890 > "$STATE/image-hash"
  line "naming to docker.io/library/wingfoil-forecast:local done"
}

init
case "${1:-help}" in
  state) state_json ;;
  env)
    case "${2:-}" in
      --json) env_json ;;
      set) env_set "${3:-}" ;;
      *) echo "usage: env --json | env set NAME" >&2; exit 1 ;;
    esac ;;
  r2-test) r2_test ;;
  token) [ "${2:-}" = rotate ] || { echo "usage: token rotate --json" >&2; exit 1; }; token_rotate ;;
  jobs)
    case "${2:-}" in
      --json) cat "$JOBS_FILE" ;;
      set) shift 2; jobs_set "$@" ;;
      *) echo "usage: jobs --json | jobs set ID …" >&2; exit 1 ;;
    esac ;;
  setup)
    bold "Checking deploy/local/jobs.toml"
    line "jobs.toml OK (4 jobs)"
    line "npm ci: added 42 packages"
    flag image-built-at || build_image
    bold "Keeping existing $ENV_FILE"
    bold "Wrote launch agents (Bacalhau gets 4 CPUs, 5.5Gb)"
    echo "doctor: Colima isn't running (warning)" >&2
    set_flag setup-complete 1
    bold "Ready. Start it with: macmini.sh start" ;;
  start) start_all ;;
  stop) stop_all ;;
  restart)
    if [ "${2:-}" = controller ]; then
      set_flag controller 0; bold "Stopped dev.sprintengine.home-compute"
      set_flag controller 1; bold "Started dev.sprintengine.home-compute"
    else
      stop_all; start_all
    fi ;;
  image) build_image ;;
  colima-autostart)
    case "${2:-}" in
      on) set_flag autostart 1; bold "Colima will start at login" ;;
      off) set_flag autostart 0; bold "Colima won't start at login" ;;
      *) echo "usage: colima-autostart on|off" >&2; exit 1 ;;
    esac ;;
  *) echo "fake-setup.sh: unknown command: $*" >&2; exit 1 ;;
esac

#!/bin/bash
# Manual acceptance of the Colima runtime on a Mac (§11 M3; GitHub's macOS
# runners cannot run nested VMs). End to end, with nothing deployed:
#
#   1. hc-web and hc-core under `wrangler dev`, with a local D1 in a scratch
#      directory;
#   2. the bundled agent, enrolled with runtime colima and its own throwaway
#      profile (HC_TEST_PROFILE, default hc-test: at most 1 CPU / 1 GiB, a
#      10 GiB disk, a 20 s idle stop);
#   3. a job (busybox, a local secret it prints, a json-lines report, ~200 MiB
#      held for a few seconds) run twice with "Run now".
#
# It shows the VM starting on the claim (the profile does not exist before)
# and stopping after the idle time, the measured boot time, the VM's memory
# footprint while it runs (the com.apple.Virtualization.VirtualMachine
# process that appeared with it), the run's phases, peak memory, digest and
# redacted log, then deletes the profile however it ends.
#
# Never touches another profile or the current docker context: the agent
# starts its VM with --activate=false. Needs colima, docker (CLI), node 22+
# and `npm ci` in the repository.
#
#   agent/scripts/acceptance-colima.sh            # from the repository root
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROFILE="${HC_TEST_PROFILE:-hc-test}"
IDLE_STOP="${HC_IDLE_STOP_SECONDS:-20}"
IMAGE="${HC_TEST_IMAGE:-docker.io/library/busybox:1.37}"
SECRET="acceptance-s3cr3t-$(date +%s)"
WRANGLER="$ROOT/node_modules/.bin/wrangler"
AGENT="$ROOT/agent/dist/home-compute-agent.mjs"
COLIMA_DIR="${COLIMA_HOME:-$HOME/.colima}"

[ "$PROFILE" = default ] && { echo "refusing to use the default profile" >&2; exit 2; }
if colima list --json 2>/dev/null | grep -q "\"name\":\"$PROFILE\""; then
  echo "profile $PROFILE already exists; delete it first (colima delete $PROFILE --force)" >&2
  exit 2
fi
command -v docker >/dev/null || { echo "the docker CLI is needed (brew install docker)" >&2; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/hc-acceptance.XXXXXX")"
CONTEXT_BEFORE="$(docker context show 2>/dev/null || true)"
PIDS=()

say() { printf '%s  %s\n' "$(date +%H:%M:%S)" "$*"; }
# json EXPR: evaluates EXPR with `v` = the JSON on stdin; jsonl EXPR: once per JSON line.
json() { node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const v=JSON.parse(s);const r=new Function("v","return ("+process.argv[1]+")")(v);console.log(typeof r==="object"?JSON.stringify(r):r??"")})' "$1"; }
jsonl() { node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const f=new Function("v","return ("+process.argv[1]+")");for(const l of s.split("\n")){if(!l.trim().startsWith("{"))continue;let v;try{v=JSON.parse(l)}catch{continue}const r=f(v);if(r!==undefined&&r!==null&&r!=="")console.log(r)}})' "$1"; }
profile_state() {
  local state
  state="$(colima list --json 2>/dev/null | jsonl "v.name === \"$PROFILE\" ? v.status : null" | head -1)"
  echo "${state:-absent}"
}
vz_pids() { pgrep -f com.apple.Virtualization.VirtualMachine | sort || true; }
# The VM's process: the com.apple.Virtualization.VirtualMachine that was not there before the agent started.
# Its footprint (MB, as `footprint` reports it) is sampled on every poll; the largest is kept in $WORK/footprint.
measure_vm() { # phase
  local pid line value unit mb rss
  pid="$(comm -13 <(echo "$VZ_BEFORE") <(vz_pids) | head -1)"
  [ -n "$pid" ] || return 0
  line="$(footprint "$pid" 2>/dev/null | sed -n 's/.*Footprint: \([0-9.]*\) \([KMG]B\).*/\1 \2/p' | head -1)"
  [ -n "$line" ] || return 0
  value="${line% *}"; unit="${line#* }"
  mb="$(awk -v v="$value" -v u="$unit" 'BEGIN { printf "%d", (u == "GB" ? v * 1024 : (u == "KB" ? v / 1024 : v)) }')"
  rss="$(( $(ps -o rss= -p "$pid" 2>/dev/null || echo 0) / 1024 ))"
  echo "$(date +%H:%M:%S) pid $pid phase $1 footprint ${mb} MB rss ${rss} MiB" >> "$WORK/footprints"
  if [ "$mb" -gt "$(cat "$WORK/footprint" 2>/dev/null || echo 0)" ]; then echo "$mb" > "$WORK/footprint"; echo "$rss" > "$WORK/rss"; fi
}
free_port() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }

cleanup() {
  local code=$?
  set +e
  for pid in "${PIDS[@]}"; do
    kill -TERM "$pid" 2>/dev/null
    pkill -TERM -P "$pid" 2>/dev/null
  done
  sleep 1
  for pid in "${PIDS[@]}"; do pkill -KILL -P "$pid" 2>/dev/null; kill -KILL "$pid" 2>/dev/null; done
  colima stop "$PROFILE" >/dev/null 2>&1 || colima stop --force "$PROFILE" >/dev/null 2>&1
  colima delete "$PROFILE" --force >/dev/null 2>&1
  say "profile $PROFILE deleted; logs kept in $WORK"
  colima list
  [ "$(docker context show 2>/dev/null)" = "$CONTEXT_BEFORE" ] && say "docker context unchanged: $CONTEXT_BEFORE" || say "WARNING: the docker context changed"
  exit "$code"
}
trap cleanup EXIT INT TERM

say "building the agent bundle"
(cd "$ROOT" && npm run --silent build:agent >/dev/null)

WEB_PORT="$(free_port)"; CORE_PORT="$(free_port)"
WEB="http://127.0.0.1:$WEB_PORT"; CORE="http://127.0.0.1:$CORE_PORT"
export CI=1 WRANGLER_SEND_METRICS=false NO_COLOR=1
say "control plane: hc-web $WEB, hc-core $CORE (local D1 in $WORK/d1)"
(cd "$ROOT/cloud" && "$WRANGLER" d1 migrations apply home-compute --local -c wrangler.web.jsonc --persist-to "$WORK/d1" >"$WORK/migrate.log" 2>&1)
(cd "$ROOT/cloud" && exec "$WRANGLER" dev -c wrangler.web.jsonc --persist-to "$WORK/d1" --ip 127.0.0.1 --port "$WEB_PORT" --inspector-port "$(free_port)" \
  --var DEV_ACCESS_EMAIL:acceptance@example.com --var BOOTSTRAP_ADMINS:acceptance@example.com --var CSRF_KEY:acceptance-only \
  --var "CORE_URL:$CORE" >"$WORK/hc-web.log" 2>&1) &
PIDS+=($!)
(cd "$ROOT/cloud" && exec "$WRANGLER" dev -c wrangler.core.jsonc --persist-to "$WORK/d1" --ip 127.0.0.1 --port "$CORE_PORT" --inspector-port "$(free_port)" \
  --test-scheduled >"$WORK/hc-core.log" 2>&1) &
PIDS+=($!)
for url in "$WEB/v1/health" "$CORE/health"; do
  for _ in $(seq 1 120); do curl -sf "$url" >/dev/null && break; sleep 0.5; done
  curl -sf "$url" >/dev/null || { echo "$url did not come up; see $WORK" >&2; exit 1; }
done

api() { curl -sf -X "$1" "$WEB$2" -H 'content-type: application/json' ${3:+-d "$3"}; }

say "enrolling the agent (runtime colima, profile $PROFILE)"
api POST /v1/join-tokens '{"name":"acceptance-mac"}' | json v.token > "$WORK/join-token"
STATE="$WORK/agent"
node "$AGENT" enrol --server "$CORE" --join-token-stdin --runtime colima --colima-profile "$PROFILE" \
  --allow-images "docker.io/library/busybox:*,docker.io/library/busybox@*" --state-dir "$STATE" < "$WORK/join-token"
node -e '
  const fs = require("fs"); const file = process.argv[1]; const config = JSON.parse(fs.readFileSync(file, "utf8"));
  Object.assign(config, { statusPort: 0, caps: { cpus: 1, memoryMiB: 1024, maxRuns: 1 },
    colima: { ...config.colima, minCpus: 1, minMemoryMiB: 1024, diskGiB: 10, idleStopSeconds: Number(process.argv[2]), keepWarmSeconds: 0 } });
  fs.writeFileSync(file, JSON.stringify(config, null, 2));' "$STATE/config.json" "$IDLE_STOP"
printf 'ACCEPTANCE_SECRET=%s\n' "$SECRET" > "$STATE/env"; chmod 600 "$STATE/env"

cat > "$WORK/job.json" <<'JOB'
{
  "image": "IMAGE", "schedule": null,
  "entrypoint": ["sh", "-c", "echo starting; echo \"token $HC_SECRET\"; printf 'fetch 10%%\\rfetch 100%%\\n'; dd if=/dev/zero bs=200M count=1 2>/dev/null | sleep 7; echo '{\"event\":\"forecast_complete\",\"model\":\"acceptance\"}'; echo done"],
  "secretEnv": { "HC_SECRET": "local:ACCEPTANCE_SECRET" },
  "resources": { "cpus": 1, "memoryMiB": 512, "diskMiB": 1024 }, "timeouts": { "runSeconds": 300 },
  "report": { "format": "json-lines", "trackEvent": "forecast_complete", "trackBy": "model" }
}
JOB
sed -i '' "s|\"IMAGE\"|\"$IMAGE\"|" "$WORK/job.json"
api PUT /v1/jobs/acceptance "$(cat "$WORK/job.json")" >/dev/null || { echo "could not create the job: $(cat "$WORK/job.json")" >&2; exit 1; }

say "profile $PROFILE before the claim: $(profile_state)"
VZ_BEFORE="$(vz_pids)"
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" node "$AGENT" run --state-dir "$STATE" >"$WORK/agent.log" 2>&1 &
AGENT_PID=$!
PIDS+=("$AGENT_PID")

run_and_watch() { # label
  local run started state vm last=""
  run="$(api POST /v1/jobs/acceptance/run '{}' | json v.runId)"
  started=$(date +%s)
  say "$1: Run now → $run"
  while :; do
    state="$(curl -sf "$WEB/v1/runs/$run" | json '(v.run??v).phase')"
    vm="$(profile_state)"
    if [ "$state/$vm" != "$last" ]; then say "  run $state, VM $vm"; last="$state/$vm"; fi
    [ "$vm" = Running ] && measure_vm "$state"
    case "$state" in succeeded|failed|timed-out|cancelled|lost) break ;; esac
    [ $(( $(date +%s) - started )) -gt 300 ] && { echo "the run did not finish in 5 minutes; see $WORK/agent.log" >&2; exit 1; }
    sleep 1
  done
  curl -sf "$WEB/v1/runs/$run" | json '(r=>({state:r.state,outcome:r.outcome,vmWaitSeconds:r.vmWaitSeconds,pullSeconds:r.pullSeconds,durationSeconds:r.durationSeconds,peakMemoryMiB:r.stats&&Math.round(r.stats.peakMemoryBytes/1048576),samples:r.stats&&r.stats.samples,imageDigest:r.imageDigest,error:r.error}))(v.run??v)' \
    | tee "$WORK/$1.json"
  curl -sf "$WEB/v1/runs/$run/logs" > "$WORK/$1.log.json"
  if grep -q "$SECRET" "$WORK/$1.log.json"; then echo "FAIL: the secret reached hc-web" >&2; exit 1; fi
  grep -q '<redacted>' "$WORK/$1.log.json" && say "  log tail: the secret is <redacted>"
}

wait_for_stop() {
  local since
  say "waiting for the idle stop (${IDLE_STOP} s without work)"
  since=$(date +%s)
  while [ "$(profile_state)" = Running ]; do
    [ $(( $(date +%s) - since )) -gt $(( IDLE_STOP + 120 )) ] && { echo "the VM did not stop; see $WORK/agent.log" >&2; exit 1; }
    sleep 1
  done
  say "VM $(profile_state) $(( $(date +%s) - since )) s after the last run ended"
}

boots() { grep '"event":"vm_started"' "$WORK/agent.log" | jsonl v.bootSeconds | paste -sd, -; }

run_and_watch first            # the profile is created on this claim
say "boot measured by the agent (colima start until Docker answers): $(boots) s"
run_and_watch second           # the VM is still warm: no wait
wait_for_stop
run_and_watch third            # a cold start of the stopped profile: the usual case
say "boots measured by the agent: $(boots) s (first: profile created; last: a stopped profile started)"
wait_for_stop
BOOT="$(grep '"event":"vm_started"' "$WORK/agent.log" | tail -1 | jsonl v.bootSeconds)"
FIRST_BOOT="$(grep '"event":"vm_started"' "$WORK/agent.log" | head -1 | jsonl v.bootSeconds)"
say "the agent's VM and caffeinate events:"
grep -E '"event":"(vm_starting|vm_started|vm_stopping|vm_stopped|vm_stop|caffeinate_hold|caffeinate_release|run_claimed|run_finished)"' "$WORK/agent.log" \
  | jsonl '`  ${v.at.slice(11,19)}  ${v.event}${v.bootSeconds?" boot "+v.bootSeconds+" s":""}${v.cpus?" "+v.cpus+" CPU "+v.memoryMiB+" MiB":""}${v.reason?" ("+v.reason+")":""}`'
say "VM process samples (footprint is what the VM costs the Mac):"
sed 's/^/  /' "$WORK/footprints" 2>/dev/null | tail -12
say "summary: boot ${BOOT} s from stopped (${FIRST_BOOT} s creating the profile); VM footprint at most $(cat "$WORK/footprint" 2>/dev/null || echo "?") MB (RSS $(cat "$WORK/rss" 2>/dev/null || echo "?") MiB) while running; VM stopped after ${IDLE_STOP} s idle"

# Home Compute agent

The pull-based agent of
[docs/hosted-control-plane.md](../docs/hosted-control-plane.md) (§4), milestone
M2. It runs on each machine, polls `hc-core` over outbound HTTPS, claims the
runs it is given, runs them in containers, and sends back what happened: the
exit code, OOM and timeout flags, stats, json-lines reports and a redacted
log tail. It schedules nothing itself.

M2 ships one container runtime, **FakeRuntime**, whose containers follow a
script instead of running an image: it is what the tests use, and it lets
you run the whole system without Docker. The Docker and Colima runtimes are
M3; the `ContainerRuntime` interface they implement is in
[src/runtime/runtime.mjs](src/runtime/runtime.mjs).

It is Node 22, ESM, with no runtime dependencies. `npm run build:agent` (from
the repository root) bundles `agent/src` and the `src/core` modules it shares
with the Workers into one file, `agent/dist/home-compute-agent.mjs`.

## Install for development

```sh
npm ci                                    # from the repository root
npm run build:agent                       # → agent/dist/home-compute-agent.mjs
alias hca="node $PWD/agent/dist/home-compute-agent.mjs"
```

Run `hc-web` and `hc-core` locally (see [cloud/README.md](../cloud/README.md)),
make a join token, then:

```sh
hca enrol --server http://localhost:8788 --join-token-stdin --state-dir /tmp/hc-agent < /tmp/join-token
hca doctor --state-dir /tmp/hc-agent
hca run --state-dir /tmp/hc-agent         # the service loop; Ctrl-C stops it
hca status --state-dir /tmp/hc-agent      # from another terminal
```

`node agent/src/cli.mjs …` runs the sources without building.

## Commands

| Command | What it does |
| --- | --- |
| `enrol --server URL --join-token-stdin [--name NAME] [--runtime fake] [--reenrol]` | Spends a join token (read from stdin, so it never shows in `ps`; `--join-token TOKEN` works but warns) for this machine's id and credential, and writes the configuration and credential. The name, labels and capabilities come from the token; `--name` (default: the host name) is used only if the token names none. Refuses to replace an existing credential without `--reenrol`. |
| `run` | The service: adopts containers left from before a restart, sends what waits in the outbox, then syncs at the interval `hc-core` sets. SIGTERM or SIGINT stops it; running containers are left alone and adopted next time. |
| `status [--json]` | Asks the running agent's local status server: connection, last and next sync, clock skew, drain, runtime, runs, outbox, upcoming slots. |
| `doctor` | Checks the configuration, file permissions, credential, runtime and control plane; if the service is not running, makes one sync without claiming to prove the credential and measure clock skew. Exits 1 if anything failed. |
| `version` | The agent version and protocol. |

Every command takes `--state-dir DIR` (or `HC_AGENT_STATE_DIR`).

## State directory

| Default | When |
| --- | --- |
| `~/Library/Application Support/home-compute` | macOS |
| `/etc/home-compute` | Linux, as root or when that directory exists and is writable (the systemd install, M6) |
| `${XDG_STATE_HOME:-~/.local/state}/home-compute` | Linux otherwise |
| `~/.home-compute` | elsewhere |

The directory is 0700 and every file in it 0600, written atomically (a
temporary file, then a rename); `doctor` checks this.

| File | Contents |
| --- | --- |
| `config.json` | The configuration below. |
| `credential` | `hca_<machineId>_<secret>`. `hc-core` keeps only its SHA-256. Replaced by a rotation (§5): the new one is written before it is used. |
| `env` | Local secrets for `local:<NAME>` references, as `NAME=value` lines. They never leave the machine. |
| `status-token` | The bearer token of the local status server. |
| `state.json` | The local drain switch, kept across restarts. |
| `outbox/<run>.json` | A run's final record, written before it is sent and deleted after a 2xx. |
| `runs/<run>.json` | A started run's claim and start time (secret names, never values), for adoption after a restart. |
| `runs/<run>.log.gz` | The run's whole redacted log, kept 7 days. |

## Configuration

`config.json`, written by `enrol`; edit it and restart the agent.

| Field | Default | Meaning |
| --- | --- | --- |
| `server` | | `hc-core`'s URL. |
| `machineId`, `name` | | From enrolment. |
| `runtime` | `"fake"` | `fake` in M2; `docker` and `colima` arrive in M3. |
| `caps` | `{}` | `{cpus, memoryMiB, diskMiB, maxRuns}` this machine offers. Unset figures come from the runtime; `maxRuns` defaults to 2. For Colima this is the largest VM, not its current size. The dashboard can cap it further. |
| `allowImages` | `["*"]` | Image patterns this machine runs (`*` matches anything), whatever the control plane says. Narrow it, e.g. `["ghcr.io/sprintengine/*"]`; `doctor` warns while it is `*`. |
| `allowLocalImages` | `false` | Whether images without a registry host (`wingfoil-forecast:local`, `alpine`) may run. |
| `envFile` | `<state>/env` | Where local secrets are read from (relative to the state directory). |
| `statusPort` | `4787` | The local status server's port on 127.0.0.1 (0 turns it off). |
| `stopGraceSeconds` | `30` | How long a stopped container gets before it is killed (timeouts, cancels). |
| `statsIntervalSeconds` | `3` | How often a running container's stats are sampled. |
| `pullTimeoutSeconds` | `1200` | A pull taking longer fails the run (§3.6). |
| `fake` | `{}` | FakeRuntime's options: `script` (or `scripts` by job id or image), `vm` (`"stopped"` for a Colima-like host), `bootMs`, `pullMs`, `images`, `cpus`, `memoryMiB`, `diskFreeMiB`. |

A FakeRuntime script is `{output, exitCode, oomKilled, hang, ignoreStop}`,
where `output` is a list of lines and steps: `"text"`, `{line, delayMs}`,
`{sleepMs}`, and `{memoryBytes, cpuPct, cpuSeconds}` for what its stats
report. Without one, a container prints one line and exits 0.

## How it behaves

- **Syncing (§4.2).** One `POST /agent/v1/sync` is the heartbeat, each run's
  phase, stats and changed log tail (200 lines / 32 KB), and the claim. The
  server sets the next interval: 10 s with work, at most 30 s idle, 2 s after
  a slot this machine may claim. A phase change syncs early (at most every
  2 s) so the server stamps it. It claims only when not draining, not revoked,
  the runtime answers, and a run slot is free.
- **Failures.** 5xx, 429, Cloudflare's 1027 or no network: exponential backoff
  with jitter, at most 5 minutes; runs carry on and results wait in the
  outbox. 401/403: revoked; it claims nothing more, finishes its runs, keeps
  their results, and looks at the credential file every 30 minutes (a
  re-enrolment replaces it). 426: the protocol is too old; it waits for an
  update (self-update is M7) and claims nothing.
- **A run (§3.1).** claimed → starting-vm (only while the runtime boots) →
  pulling (only when the image is missing; 20 minutes at most) → running →
  reporting, timed by the monotonic clock. The machine's policy is checked
  first; `local:` secrets come from the env file and go to the container's
  environment only. `runSeconds` counts from container start: stop, then kill
  after `stopGraceSeconds`. Output is redacted as it arrives (the run's secret
  values, their URL-encoded and base64 forms, and the credential patterns of
  `src/core/redact.mjs`); json-lines reports are kept apart from the tail. A
  failed run's error comes from its reports, a traceback, error lines, then
  OOM, timeout or exit code. The final record (500 lines / 64 KB of tail) goes
  to the outbox before the container is removed, and the run is reported as
  `reporting` until the control plane has it.
- **Restarts (§3.4).** Containers labelled `dev.homecompute.run` are adopted
  and supervised again from their run records; a run whose container is gone
  is reported failed ("the agent restarted and the container was gone").
- **Drain.** `POST /drain` on the status server (or `drain` from the
  dashboard): finish current work, claim nothing new.

## Local status server

`http://127.0.0.1:4787`, every request with `Authorization: Bearer <status-token>`:

```sh
TOKEN=$(cat "$HOME/Library/Application Support/home-compute/status-token")
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:4787/status
curl -s -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"drain": true}' http://127.0.0.1:4787/drain
```

## Tests

```sh
npm run check --workspace @home-compute/agent    # syntax, unit tests, bundle check
npm test --workspace @home-compute/cloud         # includes the end-to-end tests against hc-core
```

`test/` covers the state directory, the outbox, capture and redaction, the
image policy, FakeRuntime, run supervision, the sync loop against a stand-in
control plane and the command line. The end-to-end tests with `hc-core` in
workerd are `cloud/test-node/agent-integration.test.mjs`.

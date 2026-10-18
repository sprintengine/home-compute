# Home Compute agent

The pull-based agent of
[docs/hosted-control-plane.md](../docs/hosted-control-plane.md) (§4),
milestones M2 and M3. It runs on each machine, polls `hc-core` over outbound
HTTPS, claims the runs it is given, runs them in containers, and sends back
what happened: the exit code, OOM and timeout flags, stats, json-lines
reports and a redacted log tail. It schedules nothing itself.

Four runtimes implement the `ContainerRuntime` interface of
[src/runtime/runtime.mjs](src/runtime/runtime.mjs):

| Runtime | For | What it does |
| --- | --- | --- |
| `docker` | Docker Engine on Linux or WSL, Docker Desktop | The `docker` CLI pulls, runs, stops and removes; the Engine API over the same unix socket answers inspect, wait, stats, ping and info. |
| `colima` | macOS | The same, inside a Colima VM of the agent's own profile (`home-compute`), which it starts when work is due, sizes for it and stops when idle (§4.4). |
| `process` | Linux with no Docker daemon | Pulls the OCI image with the registry HTTP API, unpacks it, and runs its entrypoint as a process. bubblewrap, a user namespace or proot gives it the image as `/`; with none of them the machine claims nothing (`doctor` says why). |
| `fake` | tests, trying the agent without a runtime | Containers that follow a script instead of running an image. |

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
hca enrol --server http://localhost:8788 --join-token-stdin --state-dir /tmp/hc-agent \
  --runtime colima --allow-images 'ghcr.io/sprintengine/*' < /tmp/join-token
hca doctor --state-dir /tmp/hc-agent      # add --start-vm once to check Docker in the VM and time its boot
hca run --state-dir /tmp/hc-agent         # the service loop; Ctrl-C stops it
hca status --state-dir /tmp/hc-agent      # from another terminal
```

`node agent/src/cli.mjs …` runs the sources without building.
[scripts/acceptance-colima.sh](scripts/acceptance-colima.sh) does all of this
end to end on a Mac (see Tests).

## Install by hand

Until the installer and remote provisioning arrive (M6), a machine is added
by hand: an admin makes a join token on the dashboard (Machines › Add
machine), which shows it once together with these commands, filled in with
hc-core's URL. The token is never part of a command: the enrol step asks
for it without echo and hands it to the agent on stdin, so it is in no
command line and no shell history. Paste the enrol line on its own, or the
prompt would read the next pasted line as the token. The paths are the ones
the service templates expect (`/opt/home-compute/…` on Linux, the state
directory on macOS); the system's own Node is linked there, where M6 will
put a pinned one. `--allow-images` lists what this machine may run; change
it to your own registry.

### macOS

1. Install:

   ```sh
   # Needs Homebrew, Node 22+ and git.
   brew install colima docker
   git clone https://github.com/sprintengine/home-compute.git ~/home-compute
   cd ~/home-compute && npm ci && npm run build:agent
   mkdir -p "$HOME/Library/Application Support/home-compute/agent/current" "$HOME/Library/Application Support/home-compute/node/bin" ~/Library/Logs/home-compute
   cp agent/dist/home-compute-agent.mjs "$HOME/Library/Application Support/home-compute/agent/current/"
   ln -sf "$(command -v node)" "$HOME/Library/Application Support/home-compute/node/bin/node"
   ```

2. Enrol: paste this line on its own, then the token when asked:

   ```sh
   printf 'Join token: '; read -rs HC_JOIN_TOKEN; echo; printf '%s' "$HC_JOIN_TOKEN" | "$HOME/Library/Application Support/home-compute/node/bin/node" "$HOME/Library/Application Support/home-compute/agent/current/home-compute-agent.mjs" enrol --server https://hc-core.<account>.workers.dev --join-token-stdin --runtime colima --allow-images 'ghcr.io/sprintengine/*'; unset HC_JOIN_TOKEN
   ```

3. Check, then start the service:

   ```sh
   "$HOME/Library/Application Support/home-compute/node/bin/node" "$HOME/Library/Application Support/home-compute/agent/current/home-compute-agent.mjs" doctor --start-vm
   cd ~/home-compute && sed "s|@HOME@|$HOME|g" agent/service/dev.homecompute.agent.plist > ~/Library/LaunchAgents/dev.homecompute.agent.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.homecompute.agent.plist
   ```

### Linux (systemd)

1. Install:

   ```sh
   # Needs Docker Engine, git, sudo and Node 22+ installed for every user (not through nvm).
   git clone https://github.com/sprintengine/home-compute.git ~/home-compute
   cd ~/home-compute && npm ci && npm run build:agent
   sudo install -d /opt/home-compute/agent/current /opt/home-compute/node/bin
   sudo install -m 0644 agent/dist/home-compute-agent.mjs /opt/home-compute/agent/current/
   sudo ln -sf "$(command -v node)" /opt/home-compute/node/bin/node
   sudo useradd --system --home-dir /etc/home-compute --shell /usr/sbin/nologin hcagent && sudo usermod -aG docker hcagent
   sudo install -d -m 0700 -o hcagent -g hcagent /etc/home-compute
   ```

2. Enrol: paste this line on its own, then the token when asked:

   ```sh
   printf 'Join token: '; read -rs HC_JOIN_TOKEN; echo; printf '%s' "$HC_JOIN_TOKEN" | sudo -u hcagent /opt/home-compute/node/bin/node /opt/home-compute/agent/current/home-compute-agent.mjs enrol --state-dir /etc/home-compute --server https://hc-core.<account>.workers.dev --join-token-stdin --runtime docker --allow-images 'ghcr.io/sprintengine/*'; unset HC_JOIN_TOKEN
   ```

3. Check, then start the service:

   ```sh
   sudo -u hcagent /opt/home-compute/node/bin/node /opt/home-compute/agent/current/home-compute-agent.mjs doctor --state-dir /etc/home-compute
   sudo -u hcagent /opt/home-compute/node/bin/node -e 'const fs=require("fs"),f="/etc/home-compute/config.json",c=JSON.parse(fs.readFileSync(f,"utf8"));c.docker={...c.docker,cgroupParent:"home-compute.slice"};fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n")'
   cd ~/home-compute && sudo cp agent/service/home-compute-agent.service agent/service/home-compute.slice /etc/systemd/system/
   sudo sed -i "s/@MEMORY_MAX@/6G/" /etc/systemd/system/home-compute.slice   # the most the jobs may use together
   sudo systemctl daemon-reload && sudo systemctl enable --now home-compute-agent
   ```

### Linux without Docker

A machine that is itself a container, with tini and no systemd and no
Docker daemon, uses `--runtime process`. Images stay the way a job is
shipped. The agent pulls the OCI image itself and runs it as a process.
Install bubblewrap (`apt-get install bubblewrap` or `dnf install
bubblewrap`) so jobs get a user namespace, a pid namespace and the image's
root filesystem. In a container that masks `/proc`, bubblewrap runs without
the pid namespace, and `doctor` warns that a job then sees the machine's
processes. bubblewrap needs unprivileged user namespaces; a container that
refuses them (Docker's default seccomp and AppArmor profiles do) has no
sandbox, and then **the machine claims nothing** and `doctor` fails: an
image's programs need the image's own libraries and paths at `/`, so
running them on the machine itself fails or, worse, uses the machine's
files. `process.sandbox: "plain"` allows that for images built to run that
way. `ca-certificates` is what the registry HTTPS client trusts. The
state directory is `/var/lib/home-compute` (there is no `docker` group).
Enrolment records the label `runtime=process`. A job that sets
`placement.requireLabels.runtime` to `docker` is not sent here; a job with
no runtime requirement can run.

1. Install:

   ```sh
   # Needs bubblewrap, ca-certificates, git, sudo and Node 22+ for every user (not through nvm). No Docker daemon and no systemd.
   git clone https://github.com/sprintengine/home-compute.git ~/home-compute
   cd ~/home-compute && npm ci && npm run build:agent
   sudo install -d /opt/home-compute/agent/current /opt/home-compute/node/bin
   sudo install -m 0644 agent/dist/home-compute-agent.mjs /opt/home-compute/agent/current/
   sudo install -m 0755 agent/service/home-compute-agent-foreground.sh /opt/home-compute/agent/current/
   sudo ln -sf "$(command -v node)" /opt/home-compute/node/bin/node
   sudo useradd --system --home-dir /var/lib/home-compute --shell /usr/sbin/nologin hcagent
   sudo install -d -m 0700 -o hcagent -g hcagent /var/lib/home-compute
   ```

2. Enrol: paste this line on its own, then the token when asked:

   ```sh
   printf 'Join token: '; read -rs HC_JOIN_TOKEN; echo; printf '%s' "$HC_JOIN_TOKEN" | sudo -u hcagent /opt/home-compute/node/bin/node /opt/home-compute/agent/current/home-compute-agent.mjs enrol --state-dir /var/lib/home-compute --server https://hc-core.<account>.workers.dev --join-token-stdin --runtime process --allow-images 'ghcr.io/sprintengine/*'; unset HC_JOIN_TOKEN
   ```

3. Check, then run in the foreground:

   ```sh
   sudo -u hcagent /opt/home-compute/node/bin/node /opt/home-compute/agent/current/home-compute-agent.mjs doctor --state-dir /var/lib/home-compute
   # Foreground, for tini or a shell: exit 0 stops; any other exit restarts after 5s.
   sudo -u hcagent /opt/home-compute/agent/current/home-compute-agent-foreground.sh
   ```

`home-compute-agent run` is the agent: one foreground process, and SIGTERM
or SIGINT makes it exit 0. The foreground script is the supervisor for a
host whose init will not restart it. Point tini at that script (or set it
as the container command). A clean exit stops the loop; any other exit
waits 5 seconds and starts the agent again.

The machine appears on the dashboard after its first sync (within 30
seconds). The dashboard's commands come from `installCommands()` in
`dashboard/lib.js`; `test/dashboard-lib.test.mjs` keeps them honest.

## Commands

| Command | What it does |
| --- | --- |
| `enrol --server URL --join-token-stdin [--name NAME] [--runtime docker\|colima\|process\|fake] [--allow-images 'a/*,b/*'] [--allow-local-images] [--colima-profile NAME] [--reenrol]` | Spends a join token (read from stdin, so it never shows in `ps`; `--join-token TOKEN` works but warns) for this machine's id and credential, and writes the configuration and credential. The name, labels and capabilities come from the token; `--name` (default: the host name) is used only if the token names none. Refuses to replace an existing credential without `--reenrol`. Says so when no image may run yet. The facts include `runtime`, which hc-core stores as the machine label the scheduler matches. |
| `run` | The service: adopts containers left from before a restart, sends what waits in the outbox, then syncs at the interval `hc-core` sets; with Colima it also runs the VM lifecycle. SIGTERM or SIGINT stops it at once; running containers (and the VM) are left alone and adopted next time. |
| `status [--json]` | Asks the running agent's local status server: connection, last and next sync, clock skew, drain, runtime, the VM (state, size, measured boot, what the lifecycle waits for), runs, outbox, upcoming slots. |
| `doctor [--start-vm]` | Checks the configuration, `allowImages` (it fails while the list is empty), file permissions, credential, the runtime and the control plane. Docker: it answers, and `docker run --rm hello-world` works under a run's restrictions. Colima: the profile's state; a stopped VM is left stopped unless `--start-vm` (and the service is not running), which starts it, checks Docker, records its boot time and stops it again. Process: the sandbox that will be used, whether memory can be a cgroup, and a tiny image run (`docker.io/library/busybox` unless `process.selfTestImage` says otherwise). Warnings (plain sandbox, no cgroup, shared network) are printed and the command still succeeds when the tiny run does. If the service is not running, makes one sync without claiming to prove the credential and measure clock skew. Exits 1 if anything failed. |
| `version` | The agent version and protocol. |

Every command takes `--state-dir DIR` (or `HC_AGENT_STATE_DIR`).

## State directory

| Default | When |
| --- | --- |
| `~/Library/Application Support/home-compute` | macOS |
| `/etc/home-compute` | Linux, as root or when that directory exists and is writable (the systemd install) |
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
| `outbox/<run>.json` | A run's final record, written (and flushed to disk) before it is sent and deleted after a 2xx. A 409 keeps it for later; a run the server no longer knows (404) drops it; any other refusal moves it to `outbox/rejected/` for a person to look at. |
| `runs/<run>.json` | A started run's claim and start time, for adoption after a restart: the names of its delivered secrets, never their values, and no registry credential. |
| `runs/<run>.log.gz` | The run's whole redacted log, kept 7 days. |
| `images.json` | The registry images (by digest) the agent pulled, and when each was last used: what it may prune. |
| `vm.json` | Colima: the last measured boot time (pre-warm uses it) and the disk the VM had used. |

## Configuration

`config.json`, written by `enrol`; edit it and restart the agent.

| Field | Default | Meaning |
| --- | --- | --- |
| `server` | | `hc-core`'s URL. |
| `machineId`, `name` | | From enrolment. |
| `runtime` | `"fake"` | `docker`, `colima`, `process` or `fake`. |
| `caps` | `{}` | `{cpus, memoryMiB, diskMiB, maxRuns}` this machine offers. Unset figures come from the runtime; `maxRuns` defaults to 2. For Colima this is the largest VM, not its current size (default: half the Mac's CPUs and memory, at most 8 GiB); the dashboard can cap it further. |
| `allowImages` | `[]` | Image patterns this machine runs (`*` matches anything), whatever the control plane says. **Empty runs nothing**: list what you trust, e.g. `["ghcr.io/sprintengine/*"]`. `doctor` fails while it is empty and warns while it is `["*"]`. |
| `allowLocalImages` | `false` | Whether images without a registry host (`wingfoil-forecast:local`, `alpine`) may run. |
| `envFile` | `<state>/env` | Where local secrets are read from (relative to the state directory). |
| `statusPort` | `4787` | The local status server's port on 127.0.0.1 (0 turns it off). |
| `stopGraceSeconds` | `30` | How long a stopped container gets before it is killed (timeouts, cancels). |
| `statsIntervalSeconds` | `3` | How often a running container's stats are sampled. |
| `pullTimeoutSeconds` | `1200` | A pull taking longer fails the run (§3.6). |
| `docker` | `{}` | `binary` (default `docker`, found on PATH); `host`, a `unix://` socket (default `DOCKER_HOST`, else the current docker context, else `/var/run/docker.sock`); `cgroupParent`, e.g. `"home-compute.slice"` on Linux (see Services). |
| `colima` | `{}` | `profile` (default `home-compute`; never `default`), `binary`, `home` (COLIMA_HOME), `vmType` (`vz`), `diskGiB` (60; a disk only grows), `minCpus` (2), `minMemoryMiB` (2048), `startTimeoutSeconds` (600), `mountHome` (false: the VM sees none of your files), and `idleStopSeconds`/`keepWarmSeconds`, which override the control plane's `config` when set (0 idle: never stop). |
| `process` | `{}` | `sandbox`: `auto` (default), `bwrap`, `userns`, `proot` or `plain`. `auto` uses the first of bubblewrap, bubblewrap without a pid namespace, util-linux `unshare` and proot that starts with a run's flags; when none does, `doctor` fails and the machine claims nothing. `plain` (the entrypoint run on this machine, with its loader, root and paths) is only used when named, and suits only self-contained images. Naming a sandbox that cannot start makes `doctor` and the run fail. `cacheDir` (default `<state>/cache`) holds unpacked images and per-run rootfs copies. `keepImages` (3) is how many digests of one repository to keep. `bwrap`, `proot` and `unshare` name those binaries. `selfTestImage` and `selfTestArgs` are what `doctor` runs. |
| `caffeinate` | `"auto"` | Hold `caffeinate -i -w <agent pid>` while a run is active or due on this machine soon: `"auto"` on a Mac with a real runtime, `true`, or `false`. |
| `awakeAheadSeconds` | `900` | How long before a slot this machine is preferred for (or the only one for) the Mac is held awake. |
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
  the runtime answers, its VM is not marked failed, and a run slot is free.
- **Body limits.** Tails are cut (oldest lines first) until a sync fits
  128 KB and a completion 256 KB in UTF-8, so wide or non-ASCII output never
  produces a body the server refuses; free figures never go below zero and
  runtime errors are cut to 300 characters.
- **A run (§3.1).** claimed → starting-vm (only while the VM boots) →
  pulling (only when the image is missing; 20 minutes at most) → running →
  reporting, timed by the monotonic clock. The machine's policy is checked
  first; then the free disk against the run's `diskMiB` (Docker cannot cap a
  container's disk portably). `runSeconds` counts from container start:
  `docker stop -t <grace>`, then kill. The final record (500 lines / 64 KB of
  tail) goes to the outbox before the container is removed, and the run is
  reported as `reporting` until the control plane has it.
- **`docker run` (§4.3)** is always exactly
  `run -d --name hc-<run> --label dev.homecompute.run=<run> --label dev.homecompute.job=<job>
  --memory Mm --memory-swap Mm --cpus C --cpu-shares 256 --pids-limit 4096
  --security-opt no-new-privileges --cap-drop ALL --init --network bridge|none
  --log-driver local --log-opt max-size=50m [--cgroup-parent SLICE]
  -e NAME=value… -e SECRET_NAME… [--entrypoint FIRST] IMAGE [REST…] ARGS…`.
  Secret values are only in the `docker` process's environment, never in
  argv or on the agent's disk. Secret names Docker itself reads
  (`DOCKER_*`, `PATH`, `HOME`…) are refused.
- **`process` runtime.** The same image reference, entrypoint, cmd, env,
  workdir, user, network (`bridge` or `none`) and `allowImages` policy as
  Docker. The image is pulled over HTTPS (a private registry uses
  `spec.registryAuth` for that pull only; the password is not written down).
  Layers are gzip or uncompressed tar; a zstd layer is refused, with that
  reason, rather than unpacked wrong.
  Each run gets its own copy of the unpacked rootfs; the host's
  `resolv.conf` and `hosts` are copied into it, never through a symlink the
  image has. bubblewrap is the
  sandbox when it starts (`--unshare-user`, a pid namespace, the image as
  `/`), then bubblewrap without the pid namespace,
  then `unshare --user --map-root-user --root`, then proot, each probed with
  a run's flags; never the process itself unless `process.sandbox` is
  `plain`. `network none` drops the network with bubblewrap or
  `unshare`; proot and plain mode share the machine's network, and `doctor`
  says so. `bridge` is the machine's own network namespace (there is no
  separate bridge). Memory and CPU limits are cgroup v2 when this process
  may create a child cgroup (the job's runner joins it before the job
  starts, so everything the job forks is inside); otherwise a resident-set
  watchdog enforces the memory limit (exit 137, `oomKilled`) and CPU is not
  hard-capped, which `doctor` warns about. Either way the job runs at nice
  10, as Docker's `--cpu-shares 256` puts a container behind the machine's
  own work. Logs are the process's stdout and stderr. Secret
  values are written to the runner's stdin and live in the job's
  environment, never in argv and never in the state directory. A name
  matching `LD_*`, `BWRAP_*` or `PROOT_*` is refused, because it would
  change how the sandbox starts. The runner is the job's parent, so a
  restart of the agent still collects the exit code. Unpacked digests beyond
  the 3 most recently used per repository are removed when nothing is
  running, same as Docker. The machine's label `runtime` is `process`, so a
  job that requires `runtime=docker` is scheduled elsewhere.
- **The machine's policy (§4.3)**, which the control plane cannot override:
  images must match `allowImages`, local images need `allowLocalImages`, the
  network is `bridge` or `none`, and a spec asking for privileges, volumes,
  mounts, devices, added capabilities, host namespaces or a cgroup parent is
  refused, not run without them. Nothing can mount the Docker socket.
- **Output (§4.6).** `docker logs -f --timestamps`: the timestamp is taken
  off, a line rewritten with carriage returns (a progress bar) keeps its last
  state, stdout and stderr both count, and if the stream breaks while the
  container runs it reattaches from the last timestamp without repeating
  lines. Every line is redacted on arrival (the run's secret values in their
  plain, URL- and base64-encoded forms, a registry password, and the
  credential patterns of `src/core/redact.mjs`); json-lines reports are kept
  apart from the tail. A failed run's error comes from its reports, a
  traceback, error lines, then OOM, timeout or exit code.
- **Stats (§4.6).** Engine API one-shot stats every `statsIntervalSeconds`
  (no process per sample): memory is `usage − inactive_file` (the figure
  `docker stats` shows) and its maximum is the peak; CPU % is the share of one
  CPU since the previous sample; `cpu_seconds` is the container's total. A
  workload's own `peak*` report fields (e.g. `peakRssBytes`) travel in its
  reports, where `reportMetrics` takes their maximum for the dashboard.
- **Images (§4.5).** A pinned `repo@sha256:…` is pulled only when Docker
  does not have it. A registry tag is pulled every time (that downloads
  nothing when it is current; if the registry is unreachable the copy already
  here runs). A local image is never pulled. The digest that ran is recorded:
  the pinned one, the repository digest of a pulled tag, or a local build's
  image id. When nothing runs, the agent removes digests beyond the 3 most
  recently used per repository, only among images it pulled itself. A
  registry secret delivered with a claim (`spec.registryAuth`:
  `{server, username, password}`, M5) is used with `docker login
  --password-stdin` in a throwaway `DOCKER_CONFIG` for that pull only, then
  logged out and deleted.
- **Colima (§4.4).** The VM of the agent's own profile starts on a claim, or
  `bootSeconds + 10 s` before the first upcoming slot this machine would
  take (a slot preferred for another machine does not count); the boot time
  is measured (from `colima start` until Docker answers), kept in `vm.json`
  and reported as `health.vmBootSeconds`. Its size is
  `clamp(ceil(Σ GiB of the runs expected at once in the next 15 min, at most maxRuns) + 0.75 GiB, min, cap)`
  and `clamp(max CPUs, min, cap)`. A different size is applied only while it
  holds no containers (stop, then start with the new flags); while it holds
  some, the agent offers the control plane only what fits beside them. It
  stops after `idleStopSeconds` without work when nothing is upcoming within
  `keepWarmSeconds` (the control plane's `config`, 300 s and 600 s, unless
  the machine sets its own). Starts use `--activate=false` (the current docker
  context never changes), `--ssh-config=false` and `--mount none`.
- **Runtime failures.** Three failed starts in a row (of a run's or a
  pre-warm's) make the machine report `health.vm: "failed"` and claim
  nothing; while idle it tries again every 5 minutes and claims again once a
  start works. A failed start is stopped with `colima stop --force` so it
  holds no memory.
- **Sleep.** On a Mac, `caffeinate -i -w <agent pid>` is held while any run
  is active, or a slot this machine would take is due within
  `awakeAheadSeconds`, and released when neither holds; it ends with the
  agent whatever happens.
- **Failures.** 5xx, 429, Cloudflare's 1027 or no network: exponential backoff
  with jitter, at most 5 minutes; runs carry on and results wait in the
  outbox. 401/403: revoked; it claims nothing more, finishes its runs, keeps
  their results, and looks at the credential file every 30 minutes (a
  re-enrolment replaces it). 426: the protocol is too old; it waits for an
  update (self-update is M7) and claims nothing.
- **Restarts (§3.4).** Containers labelled `dev.homecompute.run` are adopted
  and supervised again from their run records (Colima starts a stopped VM
  first when records expect containers in it); a run whose container is gone
  is reported failed ("the agent restarted and the container was gone").
  The adopted container's log is replayed from its start and redacted again.
- **Drain.** `POST /drain` on the status server (or `drain` from the
  dashboard): finish current work, claim nothing new.

### Secrets after a restart

Secret values delivered with a claim live only in the agent's memory; the
run record names them but never holds their values. After a restart the
agent reads `local:` values again from its env file, and reads the delivered
ones back from the container's own environment (`docker inspect`), which
Docker keeps until the container is removed, so the replayed log is redacted
as before. That is also the limitation: **Docker stores a container's
environment, secret values included, in its own state (inside the VM for
Colima) until the container is removed**, which the agent does as soon as the
result is in the outbox. The process runtime reads them back from
`/proc/<pid>/environ` while the job is still running; once it has exited
they are gone. If the container is gone, or a runtime cannot read it back,
only the credential patterns apply to what the adopted run prints from then
on.

## Services

Templates in [service/](service/):

- **Linux**: [home-compute-agent.service](service/home-compute-agent.service)
  runs the agent as `hcagent` (in the `docker` group, which is
  root-equivalent; rootless Docker is the cautious alternative, with
  `docker.host` set to its socket) at `Nice=10` with `Restart=always`.
  [home-compute.slice](service/home-compute.slice) holds the containers
  (`CPUWeight=20`, `MemoryMax=` the machine's cap): set
  `"docker": {"cgroupParent": "home-compute.slice"}` in `config.json`. Copy
  both to `/etc/systemd/system/`, fill in `@MEMORY_MAX@`, then
  `systemctl daemon-reload && systemctl enable --now home-compute-agent`.
- **macOS**: [dev.homecompute.agent.plist](service/dev.homecompute.agent.plist),
  a LaunchAgent with `KeepAlive`, a PATH that finds Homebrew's `colima` and
  `docker`, and `AbandonProcessGroup` so the VM outlives an agent restart.
  Replace `@HOME@`, save it in `~/Library/LaunchAgents/`, then
  `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.homecompute.agent.plist`.
- **Linux without systemd**: [home-compute-agent-foreground.sh](service/home-compute-agent-foreground.sh)
  runs `home-compute-agent run` in the foreground and restarts it after a
  non-zero exit. `run` already exits 0 on SIGTERM, and the script treats
  that as a stop. Use it under tini, or as the command of a container that
  has no Docker daemon (`--runtime process`, state directory
  `/var/lib/home-compute`).

The installer (M6) writes these; by hand they work as described.

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

- **Unit tests** (`test/*.test.mjs`) cover the state directory, the outbox,
  capture and redaction, the policy, FakeRuntime, supervision, the sync loop
  against a stand-in control plane and the command line. The Docker and
  Colima runtimes run against fakes on PATH, in the pattern of
  `macos/dev/fake-setup.sh`: [test/fake-bin/docker](test/fake-bin/docker)
  forwards each command (argv, environment, stdin) to an in-process fake
  Docker on a unix socket that also serves the Engine API
  ([test/fake-docker.mjs](test/fake-docker.mjs)), so tests assert the exact
  `docker run` argv and that secrets arrive only in its environment;
  [test/fake-bin/colima](test/fake-bin/colima) keeps a profile's state in a
  scratch `COLIMA_HOME` (with knobs for start failures, boot time and free
  disk); [test/fake-bin/caffeinate](test/fake-bin/caffeinate) records when it
  is held and released. `test/vm-plan.test.mjs` covers each lifecycle
  decision without any process.
- **Real Docker** (`test/docker-real.test.mjs`, and
  `cloud/test-node/docker-integration.test.mjs` through hc-core) build the
  fixture image in [test/fixture](test/fixture) and check redaction, reports,
  carriage returns, a 320 MiB peak, an OOM kill at 64 MiB, a timeout, a
  non-zero exit, adoption after a restart, digests and pulls. They use
  `HC_TEST_DOCKER_HOST` if set, else on Linux `DOCKER_HOST` or
  `/var/run/docker.sock`; on a Mac they never use the current docker context
  (often a VM someone relies on) and are skipped unless told. CI sets
  `HC_REQUIRE_DOCKER_TESTS=1`, which turns a missing Docker into a failure.
  On a Mac, run them in a throwaway Colima profile (created, then deleted
  however the tests end):

  ```sh
  agent/scripts/with-test-colima.sh node --test agent/test/docker-real.test.mjs cloud/test-node/docker-integration.test.mjs
  ```
- **Process runtime** (`test/oci.test.mjs`, `test/process-runtime.test.mjs`,
  `test/process-real.test.mjs`) pulls through a stand-in registry and, in
  `process-real`, from Docker Hub: `docker.io/library/busybox:1.36.1` is
  unpacked and run with no daemon. That test skips when the registry cannot
  be reached unless `HC_REQUIRE_PROCESS_E2E=1`.
- **Acceptance on a Mac**: [scripts/acceptance-colima.sh](scripts/acceptance-colima.sh)
  runs hc-web and hc-core under `wrangler dev`, enrols the bundled agent with
  runtime `colima` and a throwaway `hc-test` profile (1 CPU, 1 GiB, 20 s idle
  stop), runs a job three times (the first claim creates the VM, the second
  finds it warm, the third cold-starts it after an idle stop), and prints the
  phases, the measured boot times, the VM process's memory footprint, the
  redacted log and the idle stops, then deletes the profile.

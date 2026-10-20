# Hosted control plane and pull-based agent

Status: design proposal, 2026-10-11. Supersedes the Bacalhau architecture in
[implementation-plan.md](implementation-plan.md) once milestone M5 below ships.
*As built (2026-10-12):* M0–M4 and M5's vault are built; both Workers are
deployed in shadow mode (§9 phase 0) and the Mac mini's agent is enrolled
(phase 1). Alerts were pulled forward from M8 (§13). The runbook, including
the per-job cut-over checklist, is [deploy.md](deploy.md).

Home Compute today is a Node daemon on the Mac mini that submits jobs on a UTC
timetable to a local Bacalhau orchestrator+compute node, which runs them in
Colima's Docker VM. Colima holds 4 CPU / 6 GiB all day. This document replaces
that with:

1. a **control plane on Cloudflare's free plan**: two Workers, one D1 database,
   one Cron Trigger, the dashboard served as static assets, Cloudflare Access for
   people and per-machine tokens for agents;
2. a **pull-based agent** on each machine. It polls over outbound HTTPS, runs
   containers with the local `docker` CLI, starts Colima only when work is due
   and stops it when idle, and reports state, peak memory, json-lines reports
   and a redacted log tail.

The product stays generic: a job is an image, args, env, secret references,
resources, a timeout, a schedule and placement. Wingfoil is a preset.

---

## 0. Decisions at a glance

| Question | Decision |
| --- | --- |
| Store | **D1** (one database, `--location weur`). Durable Objects are not used in v1, except the optional Cloudflare Containers executor ([cloudflare-containers.md](cloudflare-containers.md)), which adds one SQLite-backed class on hc-core. |
| Due runs | **Cron Trigger `* * * * *`** materialises slots. Agent syncs also materialise lazily. Both are idempotent through `UNIQUE(job_id, slot_at)`. |
| Workers | **Two Workers, one codebase**: `hc-web` (dashboard + human API, behind Access) and `hc-core` (agent API + cron, per-machine tokens, never serves people). |
| Agent language | **Node 22, one dependency-free ESM file**, sharing `src/core/` with the Workers. Go is deferred (§4.1). |
| Protocol | Interval polling. The server sets the next poll time (30 s idle, 10 s while running, earlier just before a due slot). No long-poll and no WebSockets in v1. |
| Container runtime | `docker` CLI for pull/run/stop/rm. The Engine API over the local socket for inspect/stats. Colima uses a **dedicated `home-compute` profile**. |
| Source of truth | **The control plane**, once imported. `jobs.toml` remains the source for Wingfoil's Compose deployment and seeds the preset. Imports are explicit and diffed, never automatic (§8). |
| Secrets | Envelope-encrypted in D1. `hc-web` can only encrypt (public key). Only `hc-core` can decrypt, and only into the response to a claim. They are write-only in the UI. |
| Migration | **Per-job cut-over**: each job runs in exactly one system at any time, so there are no double runs and no gaps (§9). |

---

## 1. Architecture

```text
  Android phone / laptop                 admin CLI · menu bar app · Studio module
        │ HTTPS, Access login (Google/GitHub/OTP)      │ HTTPS + Access service token
        ▼                                              ▼
┌──────────────────────────── Cloudflare, Workers Free ────────────────────────────┐
│                                                                                  │
│  Access app ──► hc-web Worker                                                    │
│                  ├─ static assets: dashboard (PWA)            free, unlimited    │
│                  └─ /v1/* human API (same paths as today's local controller)     │
│                         │  reads/writes; encrypts secrets with the vault PUBLIC key
│                         ▼                                                        │
│                 D1 "home-compute": jobs · schedule_state · runs · run_logs ·     │
│                 machines · join_tokens · secrets · provisioning_tasks · audit    │
│                         ▲                                                        │
│  Cron * * * * * ──► hc-core Worker                                               │
│                  ├─ scheduled(): materialise slots, expire leases, timeouts,     │
│                  │               retention                                       │
│                  └─ /agent/v1/* : enrol · sync · complete · provisioning events  │
│                     (holds the vault PRIVATE key; decrypts only for a claim)     │
└──────────────────────────────────────▲───────────────────────────────────────────┘
                                       │ outbound HTTPS polling only (works behind NAT)
        ┌──────────────────────────────┼───────────────────────────────┐
  Mac mini agent                 Linux agent                  Windows agent (later)
  capability: provisioner        Docker Engine                WSL2 + Docker Engine
  Colima "home-compute"          systemd service              systemd inside WSL
  profile, on demand
     │  docker run … image@sha256 ─► workload I/O (R2, forecast providers)
     └─ ssh over the tailnet ──► new machine: install.sh, enrol, service
```

### Responsibilities

| Control plane (Cloudflare) | Agent (each machine) |
| --- | --- |
| Job definitions, validation, revisions, audit | Enrolment and credential storage (0600) |
| Timetable, creating due runs (slots), overlap and coalescing | Polling, claiming within its free capacity |
| Placement (labels, capacity, preference windows) | Colima lifecycle: pre-warm, right-size, idle stop |
| Leases, lost-agent detection, retries, timeouts (backstop) | Pull by digest, `docker run` with limits and low CPU priority |
| Encrypted secret store, delivery only with a claim | Secret injection without argv or disk; redaction before upload |
| Run history, outcomes, `published` tracking, retention | Log capture, error extraction, json-lines parsing, stats sampling |
| Dashboard, human API, Access/JWT, CSRF | Enforcing the run timeout, outbox for offline results |
| Provisioning task queue | Self-update (signed); the provisioner role over SSH |

### What disappears

- **Bacalhau** (orchestrator and compute node), its launch agent, `examples/systemd/bacalhau-*`,
  `src/bacalhau.mjs`.
- **The local controller daemon**: `cli.mjs daemon`, `scheduler.reconcile` against Bacalhau,
  `state.json` with its process lock, the loopback API on `:4786` and its token, `HistoryStore`'s files.
- The **always-on default Colima VM** and building `wingfoil-forecast:local` on the Mac
  (replaced by `ghcr.io/…@sha256` pulls; local images remain a dev option).
- Wingfoil's `macmini.sh` launch-agent management and `panel.py`'s service/controller probes.
  The R2 test and image-freshness checks move to the dashboard or are dropped.

### What is reused

| Today (path) | Reused as |
| --- | --- |
| `src/config.mjs` validation (`validateSchedule`, job id/env-name rules, `parseDuration`) | `src/core/job.mjs`, run in the Worker and the CLI |
| `src/scheduler.mjs` `previousSlot`, `nextSlot`, `isDue` | `src/core/schedule.mjs` (slot maths unchanged, UTC only) |
| `src/scheduler.mjs` `parseReports`, `outcomeOf`, `published` tracking in `recordFinished` | `src/core/reports.mjs`; the agent parses, the Worker settles |
| `feature/dashboard` `src/history.mjs` `completeRun`, `reportMetrics`, `boundedReports`, `summarizeRun` | `src/core/history.mjs` (pure). The storage becomes a D1 repository with the same `record/runs/find` shape. |
| `feature/dashboard` `src/redact.mjs` (`createRedactor`, `redactValue`, patterns) | Agent: value + pattern redaction. Worker: pattern redaction again before storing. |
| `feature/dashboard` `src/logs.mjs` (`classifyLines`, `tailLines`) | Agent: error extraction. Worker: line levels for the log view. |
| `feature/dashboard` `src/timetable.mjs` (`timetableArguments` validation) | Validation of `PATCH /v1/jobs/:id/timetable` (same body: `enabled`, `hours`, `minutes`) |
| `feature/dashboard` `src/auth.mjs` `sameOrigin` / `allowsChange` | CSRF rules in `hc-web` (identity comes from Access instead of sessions) |
| `feature/dashboard` `dashboard/*` (overview, job, run, log, timetable views, PWA manifest) | Static assets of `hc-web`, plus Machines, Provisioning and Secrets views |
| `/v1/snapshot`, `/v1/jobs/:id/runs`, `/v1/runs/:id/logs`, `run/pause/resume` shapes | Kept on `hc-web` so the dashboard, menu bar app and Studio module need only a base-URL and auth change |
| The v1 `home-compute.json` job format | Import format (`home-compute cloud import`), including Wingfoil's generated file |

To make this possible, pure modules must not import `node:*`. `redact.mjs` currently imports
`jobEnvironmentNames` from `bacalhau.mjs`; move that function to `src/core/job.mjs`.

---

## 2. Data model (D1)

All timestamps are `INTEGER` epoch milliseconds in UTC. IDs are prefixed ULIDs
(`r_01J…`, `m_01J…`, `p_01J…`). JSON columns are validated by `src/core` on write.

```sql
-- migrations/0001_init.sql
CREATE TABLE jobs (
  id               TEXT PRIMARY KEY,             -- ^[a-z0-9][a-z0-9-]{0,62}$, as today
  description      TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,   -- configuration switch (jobs.toml enabled)
  paused           INTEGER NOT NULL DEFAULT 0,   -- operator pause (today's record.paused)
  image            TEXT NOT NULL,                -- repo@sha256:… (preferred) or repo:tag
  entrypoint_json  TEXT,                         -- ["sh","-c","…"] or NULL
  args_json        TEXT NOT NULL DEFAULT '[]',
  env_json         TEXT NOT NULL DEFAULT '{}',   -- non-secret NAME -> value
  secret_env_json  TEXT NOT NULL DEFAULT '{}',   -- NAME -> "vault:<secret>" | "local:<NAME>"
  resources_json   TEXT NOT NULL,                -- {"cpus":1,"memoryMiB":1024,"diskMiB":12288}
  timeouts_json    TEXT NOT NULL,                -- {"runSeconds":3900,"maxLatenessSeconds":null}
  schedule_json    TEXT,                         -- {"at":{"hours":[8,10],"minutes":[20]}} | {"every":"6h"} | NULL
  placement_json   TEXT NOT NULL DEFAULT '{}',   -- {"requireLabels":{"arch":"arm64"},"preferMachines":["mac-mini"],"preferWaitSeconds":300}
  policy_json      TEXT NOT NULL DEFAULT '{}',   -- {"overlap":"coalesce","catchUp":"latest","retry":{…},"priority":0}
  report_json      TEXT,                         -- {"format":"json-lines","trackEvent":"forecast_complete","trackBy":"model"}
  network          TEXT NOT NULL DEFAULT 'bridge', -- bridge | none (never host)
  labels_json      TEXT NOT NULL DEFAULT '{}',
  preset           TEXT,                         -- "wingfoil" when imported from a preset
  revision         INTEGER NOT NULL DEFAULT 1,   -- optimistic concurrency (If-Match)
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT
);

CREATE TABLE schedule_state (
  job_id           TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  last_slot_at     INTEGER,     -- newest slot materialised or deliberately skipped
  next_due_at      INTEGER,     -- denormalised for the overview and agent look-ahead
  last_run_id TEXT, last_state TEXT, last_outcome TEXT, last_finished_at INTEGER,
  published_json   TEXT NOT NULL DEFAULT '{}'  -- trackBy value -> {run, at, seconds, runId}
);

CREATE TABLE machines (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,         -- "mac-mini"
  labels_json      TEXT NOT NULL DEFAULT '{}',   -- {"os":"darwin","arch":"arm64","runtime":"colima","site":"home"}
  capabilities     TEXT NOT NULL DEFAULT '',     -- "provisioner" or empty
  capacity_json    TEXT NOT NULL DEFAULT '{}',   -- caps: {"cpus":4,"memoryMiB":6144,"diskMiB":40960,"maxRuns":2}
  facts_json       TEXT NOT NULL DEFAULT '{}',   -- os version, docker version, colima version, VM state/size
  health_json      TEXT NOT NULL DEFAULT '{}',   -- {"docker":"ok","diskFreeMiB":…,"lastError":…,"vmBootSeconds":28}
  agent_version    TEXT,
  credential_hash  TEXT,                         -- sha256(credential); NULL once revoked
  credential_next_hash TEXT,                     -- during rotation
  drain            INTEGER NOT NULL DEFAULT 0,   -- finish current work, claim nothing new
  last_seen_at     INTEGER,                      -- written at most every 5 min unless state changes
  last_ip          TEXT, clock_skew_ms INTEGER,
  enrolled_at INTEGER NOT NULL, revoked_at INTEGER
);

CREATE TABLE join_tokens (
  token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used_at INTEGER,
  machine_name TEXT, labels_json TEXT, capabilities TEXT NOT NULL DEFAULT '',
  provisioning_task_id TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  job_revision INTEGER NOT NULL,           -- what definition it ran
  slot_at INTEGER,                        -- NULL for manual runs
  source TEXT NOT NULL,                   -- schedule | manual | retry | import
  state TEXT NOT NULL,                    -- see §3 state machine
  skip_reason TEXT,                       -- coalesced | overlap | expired | paused-at-slot
  outcome TEXT,                           -- published | unchanged | completed | failed (outcomeOf)
  attempt INTEGER NOT NULL DEFAULT 1, retry_of TEXT,
  due_at INTEGER NOT NULL, preferred_until INTEGER,
  machine_id TEXT, lease_expires_at INTEGER,
  claimed_at INTEGER, vm_started_at INTEGER, pull_started_at INTEGER,
  started_at INTEGER, reporting_at INTEGER, finished_at INTEGER,
  queue_ms INTEGER, duration_ms INTEGER, vm_wait_ms INTEGER, pull_ms INTEGER,
  exit_code INTEGER, oom_killed INTEGER, timed_out INTEGER,
  peak_memory_bytes INTEGER, memory_limit_bytes INTEGER,
  avg_cpu_pct REAL, peak_cpu_pct REAL, cpu_seconds REAL, stats_samples INTEGER,
  image_ref TEXT, image_digest TEXT,      -- what actually ran
  parameters_json TEXT,                   -- manual extraParameters
  error TEXT,                             -- one line, redacted
  error_detail TEXT,                      -- <= 4 KB: traceback / last error lines, redacted
  reports_json TEXT,                      -- <= 32 KB, boundedReports(), redacted
  metrics_json TEXT,                      -- reportMetrics()
  published_json TEXT,
  recovered INTEGER NOT NULL DEFAULT 0,   -- a late report arrived after the run was marked lost
  requested_by TEXT,                      -- email / service token / "schedule"
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX runs_slot       ON runs(job_id, slot_at) WHERE slot_at IS NOT NULL;   -- idempotent materialisation
CREATE UNIQUE INDEX runs_one_due    ON runs(job_id) WHERE state = 'due';                 -- coalescing
CREATE UNIQUE INDEX runs_one_active ON runs(job_id)
  WHERE state IN ('claimed','starting-vm','pulling','running','reporting');              -- no overlap
CREATE INDEX runs_by_state   ON runs(state, due_at);
CREATE INDEX runs_by_job     ON runs(job_id, due_at DESC);
CREATE INDEX runs_by_machine ON runs(machine_id, state);

CREATE TABLE run_logs (            -- separate so listing runs never touches big rows
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  tail TEXT NOT NULL,              -- redacted, <= 64 KB, <= 500 lines
  bytes_total INTEGER, lines_total INTEGER, truncated INTEGER,
  error_count INTEGER, final INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);

CREATE TABLE secrets (
  name TEXT PRIMARY KEY,           -- "wingfoil-r2-secret-key"
  envelope TEXT NOT NULL,          -- base64(RSA-OAEP(aesKey)) . base64(iv) . base64(AES-GCM(value))
  key_id TEXT NOT NULL,            -- vault key version
  hint TEXT,                       -- "…7Q2A" for key ids; NULL for secret keys
  allowed_labels_json TEXT NOT NULL DEFAULT '{}', -- only machines matching may receive it
  updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL
);

CREATE TABLE provisioning_tasks (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL,      -- install | upgrade | uninstall
  target_host TEXT NOT NULL, ssh_user TEXT NOT NULL, ssh_method TEXT NOT NULL, -- tailscale | openssh
  os_hint TEXT, machine_name TEXT NOT NULL, labels_json TEXT NOT NULL DEFAULT '{}',
  provisioner_id TEXT NOT NULL REFERENCES machines(id),
  state TEXT NOT NULL,                          -- queued|claimed|running|waiting-enrol|succeeded|failed|cancelled
  steps_json TEXT NOT NULL DEFAULT '[]',        -- [{step,status,detail,at}]
  log_tail TEXT, error TEXT, result_machine_id TEXT,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
  actor TEXT NOT NULL,             -- "conal@…", "service:menubar", "machine:m_…", "system"
  action TEXT NOT NULL,            -- job.update, job.run, secret.put, machine.revoke, provision.create …
  target TEXT, before_json TEXT, after_json TEXT, ip TEXT
);
CREATE INDEX audit_at ON audit_log(at DESC);

CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
-- global_pause, retention, agent_channel/desired_version, jobs_version (cache key), vault_public_key
```

Notes:
- `runs_one_active` means v1 jobs have concurrency 1. Allowing a per-job `concurrency > 1`
  later replaces that index with a count check at claim time.
- Secret values never appear in `jobs`. A job holds only `NAME -> vault:<secret>` references.
  `local:<NAME>` means "resolve from the agent's own env file". That value never leaves the machine.
- `jobs_version` in `settings` increases on every job write. Workers keep parsed job
  definitions in isolate memory keyed by it, so a sync reads 1 row instead of about 21.
- *As built (M2):* migration `0003` adds `machines.credential_issued_at` (rotation by age) and
  `machines.rotate_requested_at` (rotation asked for from the dashboard). `last_seen_at` is
  written at most once a **minute**, not every 5 minutes, because §3.5's offline test needs it
  fresh (see §3.5). `settings.machines_version` moves on dashboard machine edits, so
  `/v1/changes` notices a drain.
- *As built (M4):* migration `0004` adds `runs_by_machine_claimed ON runs(machine_id, claimed_at)`
  for a machine's 24-hour timeline. A machine's VM history lives in `facts_json` (`vmSince`,
  `vmHistory`: the last day's running spans), and `settings.desired_agent_version` says which
  agent machines should run (until M7's channel).

---

## 3. Scheduling semantics

### 3.1 Run state machine

```text
                       ┌──────────── skipped (coalesced | overlap | expired) ◄─┐
                       │                                                       │
  slot / run-now ──► due ──claim──► claimed ──► starting-vm ──► pulling ──► running ──► reporting
                       │              │  (Docker hosts skip     (only when the            │
                       │              │   starting-vm)           digest is missing)       ▼
                       └─cancel──► cancelled ◄── cancel (any non-terminal) ── succeeded | failed | timed-out
                                      │
           lease expired ─────────────┴──────► lost ──(late complete)──► succeeded/failed (recovered=1)
```

- **due** ("waiting" in the UI) is the brief's *due*. **succeeded/failed** is the run state;
  the **outcome** (`published | unchanged | completed | failed`) is `outcomeOf()` from today's scheduler.
  So `succeeded + unchanged` reads as "ran, nothing new". A non-zero exit, OOM or a `*_failed`
  report gives `failed`.
- Phase timestamps come from the server's receipt time. Durations (`duration_ms`, `pull_ms`,
  `vm_wait_ms`) come from the agent's monotonic clock, so clock skew cannot distort them.

### 3.2 Creating due runs: cron and lazy materialisation

`materialise(job, state, now)` is a pure function in `src/core/schedule.mjs`, so it can be unit-tested. It is called:

1. by **Cron `* * * * *`** on `hc-core` (one of the 5 cron triggers allowed per free account), for every job; and
2. **lazily on every agent sync**, for jobs whose `next_due_at <= now`. Cron runs "on underutilized
   machines" and may be some seconds late; a sync just after a slot creates the run itself.

Both write `INSERT … ON CONFLICT DO NOTHING` against `runs_slot`, so running both, or running
cron twice in the same minute, creates exactly one run per slot.

Rules (unchanged from the current controller where it already defines them):

- `at` slots are UTC only (`validateSchedule` already refuses other zones). Omitted `hours` means every hour; omitted `minutes` means `[0]`.
- `every` jobs become due at `last_finished_at + every` (from completion, as today), or immediately if they have never run.
- Disabled or paused jobs, or `global_pause`, materialise nothing. `last_slot_at` still advances, so resuming does not replay old slots.
- **Overlap policy** (`policy.overlap`):
  - `coalesce` (default, today's behaviour): if a run is active, the new slot becomes `due` and waits.
    If a `due` run already exists, the new slot is recorded as `skipped(coalesced)`, so history shows
    why 11:20 did not run separately.
  - `skip`: if a run is active, the slot is recorded as `skipped(overlap)`.
- **Catch-up** (`policy.catchUp`):
  - `latest` (default; Wingfoil): a `due` run never expires. It waits for a machine and is coalesced
    with later slots, so after downtime each job runs **once**. This matches "slots missed while the
    controller was down run once when it returns".
  - `none`: a `due` run older than `timeouts.maxLatenessSeconds` becomes `skipped(expired)`.

### 3.3 Claiming, leases and heartbeats

- On sync, an agent sends what it can take now: free CPU/memory/disk, free run slots and drain state.
- `hc-core` reads up to 20 `due` runs (`runs_by_state`, `due_at <= now`, no active run for that job).
  It filters them in JS by placement and capacity, orders them by `priority DESC, due_at`, and
  claims with a compare-and-set:
  `UPDATE runs SET state='claimed', machine_id=?, lease_expires_at=?, claimed_at=? WHERE id=? AND state='due'`.
  `meta.changes = 1` means this agent won. D1 serialises writes and `runs_one_active` backstops
  overlap, so two agents racing cannot both win.
- Lease: 90 s. Every sync renews the leases of that machine's runs (10 s cadence while it has work,
  so about 9 missed syncs before expiry).
- The server accepts a run update only from the machine that holds it and only in a non-terminal
  state, or in `lost` (a late report).
- *As built (M2):* a lease is renewed once it is 30 s old rather than on every sync, which
  writes a running run's row every 30 s instead of every 10 s (a lease then has 60–90 s left
  when its machine goes quiet). A run claimed for a machine that its next sync does not mention
  (the answer carrying the claim was lost) is sent again in `claims`. Scheduled and retry runs of
  a paused or disabled job, or under `global_pause`, are not claimed; **manual runs are**, so
  phase 1 of §9 can test a run while everything else is paused.

### 3.4 Lost agents, retry and reassignment

| Lease expired while… | Becomes | Automatic retry |
| --- | --- | --- |
| `claimed`, `starting-vm`, `pulling` (no side effects yet) | `lost` | **Yes**: a new `due` row (`attempt+1`, `retry_of`), up to `retry.maxAttempts` (default 3) |
| `running`, `reporting` | `lost` | Only if `retry.onLostRunning: true` (declares the workload idempotent), and only after `lostGraceSeconds` (default 600) so a network blip does not cause a double run |

- A **late `complete`** for a `lost` run is accepted: the row becomes `succeeded/failed` with
  `recovered=1`. If a retry has meanwhile started, both are kept, linked by `retry_of`.
- On restart, an agent **adopts** its containers (`docker ps --filter label=dev.homecompute.run`)
  and reattaches to their logs and stats. A Mac mini reboot during a run then becomes either
  `failed` (container gone, exit unknown, "agent restarted") or a normal completion.
- `retry.onFailed` (default 0 attempts; the next slot is the retry for scheduled importers) with `backoffSeconds`.
- *As built (M2):* the time a run became `lost` is its `updated_at` (nothing else touches a lost
  row), and the grace counts from it. No retry is made when a newer run of the job exists (its
  retry, a later slot or a manual run): under coalescing that run does the work. A late
  `complete` that recovers a run as succeeded **cancels its retry if that is still `due`**
  (one that started keeps going, as above), and does not replace a newer finished run in
  `schedule_state` (last run, `published`).

### 3.5 Queueing and placement

- `requireLabels`: all must match the machine's labels (`os`, `arch`, `runtime`, any custom label).
  `arch` matters until every image is multi-arch.
- `preferMachines` + `preferWaitSeconds` (default 300): `preferred_until = due_at + wait`.
  Until then, only a preferred machine may claim, **unless every preferred machine is offline
  (last sync more than 90 s ago), draining or unhealthy**, in which case others may claim at once.
  This keeps Wingfoil on the Mac mini without stranding it.
- Capacity: a machine claims only if `job.resources` fits its free capacity. For Colima the
  capacity is the configured cap (the maximum VM size), not the current VM size; the agent resizes (§4.4).
- A busy or offline machine simply does not claim. Runs stay `due` and the overview shows them
  as "waiting 12 min: preferred mac-mini busy".
- `drain` (dashboard or menu bar app): claim nothing new and finish current work. Useful when the
  Mac's owner needs the whole machine.
- *As built (M2):* "offline" is **150 s** without a recorded sync: the 90 s above plus the minute
  by which `last_seen_at` may lag. A drain set on the machine itself (the agent's status
  server) is reported in its syncs and shown as `localDrain`, separate from the dashboard's
  `drain` column; either stops claims. Until the vault exists (M5), a job naming a `vault:`
  secret is never claimed: the overview shows it as `blocked`, and every waiting run says why
  it waits (`waiting 12 min: preferred mac-mini busy`).

### 3.6 Timeouts

- `timeouts.runSeconds` counts from container start. The agent enforces it with `docker stop -t 30`,
  then kill, and the state becomes `timed-out`.
- Backstop: cron marks a run `timed-out` once `started_at + runSeconds + 300 s` has passed, and
  tells the agent on its next sync to cancel it.
- Bacalhau's `queueSeconds`/`totalSeconds` disappear. Import maps
  `runSeconds = totalSeconds - queueSeconds` (Wingfoil: importer timeout + 600 s start margin,
  e.g. 3300 + 600 = 3900). `queueSeconds` maps to `maxLatenessSeconds` only when `catchUp: none`.
- Pull time is not counted against `runSeconds`. It is bounded separately: 20 minutes, then `failed: pull timed out`.

### 3.7 Clocks

The server's clock (UTC) is authoritative for slots, leases and timeouts. Each sync returns
`serverTime`. The agent records the skew, and the machine shows a warning if it exceeds 30 s.
The agent schedules nothing by itself.

---

## 4. Agent design

### 4.1 Language: Node 22, one file

Recommended: `home-compute-agent.mjs`, esbuild-bundled from `agent/src` and `src/core`, with no npm
dependencies, using `fetch`, `child_process`, `http` (Docker socket) and `crypto`.

- **For**: the Workers and the CLI share one codebase and test runner (`node --test`), along with
  the schedule maths, report parsing, redaction and log classification that are already tested.
  It suits a solo maintainer. Self-update replaces one text file. The Mac mini already has Node.
- **Against**: Node is about 45 MB to download and about 110 MB on disk per machine. That is small
  next to Docker Engine/Colima plus a 1 GB worker image. The installer uses a pinned
  **private Node tarball** (`/opt/home-compute/node` or `~/Library/Application Support/home-compute/node`),
  verified against nodejs.org `SHASUMS256.txt`, so the system Node is never touched.
- **Go** would give a 10 MB static binary, which only matters for tiny devices or native Windows.
  The protocol is plain HTTPS+JSON, so a Go agent can be added later without changing the
  control plane. Deferred.

### 4.2 Poll protocol

HTTPS only, outbound only, so it works behind NAT and CGNAT. One endpoint does heartbeat,
progress and claim, which keeps the request count low:

```http
POST /agent/v1/sync            Authorization: Bearer hca_m_01J…_<secret>
{
  "agentVersion": "0.4.0", "protocol": 1, "agentTime": 1791700000000,
  "machine": { "drain": false,
    "vm": { "kind": "colima", "state": "stopped", "cpus": null, "memoryMiB": null },
    "free": { "cpus": 4, "memoryMiB": 6144, "diskMiB": 38000, "runs": 2 },
    "health": { "docker": "ok", "lastError": null } },
  "runs": [ { "id": "r_01J…", "phase": "running", "phaseAt": 1791699990000,
              "stats": { "peakMemoryBytes": 412000000, "cpuPct": 87 },
              "logTail": { "text": "…redacted…", "bytesTotal": 18233, "truncated": false } } ],
  "claim": true,
  "provisioning": [ { "id": "p_01J…", "steps": [ { "step": "docker", "status": "ok" } ] } ]
}
→ 200
{
  "serverTime": 1791700000412, "nextSyncInMs": 30000,
  "claims": [ { "run": { "id": "r_01J…", "jobId": "ecmwf", "attempt": 1, "leaseExpiresAt": … },
                "spec": { "image": "ghcr.io/sprintengine/wingfoil-forecast@sha256:…",
                          "args": ["--models","ecmwf","--ecmwf-cycle","00"],
                          "env": { "AWS_REGION": "auto", "FORCE5_SIDECARS": "0" },
                          "secretEnv": { "AWS_ACCESS_KEY_ID": "…", "AWS_SECRET_ACCESS_KEY": "…",
                                         "S3_BUCKET": "…", "S3_ENDPOINT_URL": "…" },
                          "localEnv": [],
                          "resources": { "cpus": 1, "memoryMiB": 1024, "diskMiB": 12288 },
                          "runSeconds": 3900, "network": "bridge",
                          "report": { "format": "json-lines", "trackEvent": "forecast_complete", "trackBy": "model" } } } ],
  "cancel": [], 
  "upcoming": [ { "jobId": "blend", "dueAt": 1791700300000, "memoryMiB": 512, "cpus": 1, "preferred": true } ],
  "config": { "idleStopSeconds": 300, "keepWarmSeconds": 600 },
  "update": null, "provisioningTasks": [], "rotateCredential": null
}
```

- **The server sets the interval**: 10 s while the machine has a non-terminal run; otherwise
  `min(30 s, time until the next upcoming slot for this machine + 2 s)`, so a 10:20:00 slot is
  claimed by about 10:20:03. A phone "Run now" takes at most about 30 s to start.
- `POST /agent/v1/runs/:id/complete` carries the final record (exit code, OOM flag, stats, reports,
  error, 64 KB tail). It is idempotent per run id. The agent writes it to a local **outbox**
  (`state/outbox/<run>.json`, 0600) before sending and deletes it after a 2xx.
- Responses that carry secrets have `Cache-Control: no-store`. The agent keeps secrets only in
  memory for the life of the run.
- Errors: 5xx, 429 or 1027 lead to exponential backoff with jitter (cap 5 min). Running containers
  continue. 401/403 (revoked) means: claim nothing, finish current runs, keep results in the outbox,
  and show "revoked" in local status. 426 (protocol too old) means self-update.
- *As built (M2):* `localEnv` entries are `{"name": "AWS_ACCESS_KEY_ID", "from": "WINGFOIL_KEY"}`
  (the container's name and the agent's env-file name may differ). `secretEnv` is `{}` until M5.
  A finished run whose result is still in the outbox stays in `runs` as `reporting`, so its lease
  holds until the result is delivered. The `complete` record also says `cancelled` (the agent
  stopped it for a cancel) and `failed` (it failed before it had an exit code: a refused image, a
  failed pull, a missing local secret). A 401 body says `{"code": "revoked"}` or
  `{"code": "unauthorized"}`; a request sent with the old credential just after a rotation was
  promoted is retried once with the new one rather than taken as a revocation. The agent's local
  status server listens on `statusPort` (default 4787).

### 4.3 Container runtime abstraction

```js
// agent/src/runtime/runtime.mjs
interface ContainerRuntime {
  ensureReady({ cpus, memoryMiB }) -> { bootMs }          // Colima: start/resize; Docker: ping
  idle() / stop()                                         // Colima: stop VM; Docker: no-op
  hasImage(digestRef) ; pull(ref, { auth }) -> { digest, ms }
  run(spec) -> handle { id, logs: AsyncIterable<line>, stats(): Sample, wait(): {exitCode, oomKilled}, stop(graceS) }
  adopt() -> handle[]                                     // containers labelled dev.homecompute.run
  facts() -> { kind, version, cpus, memoryMiB, diskFreeMiB }
}
```

Implementations: `DockerCliRuntime` (Docker Engine on Linux/WSL, Docker Desktop),
`ColimaRuntime` (wraps `DockerCliRuntime` with `DOCKER_HOST=unix://$HOME/.colima/home-compute/docker.sock`
and VM management), and `FakeRuntime` (scripted lines, exit codes, memory samples, delays,
OOM and hangs; used by tests).

*As built (M2):* two optional additions to the interface. `facts().vm` (`{state, cpus,
memoryMiB}` or null) tells the agent whether a run will wait for a VM, so it reports
`starting-vm` only then. `handle.remove()` replaces "removed after `inspect`" inside `wait()`:
the agent removes a container only after the run's result is in the outbox, so a crash between
the exit and the outbox loses nothing and adoption still finds the exited container. Handles
also carry `runId`/`jobId` from the labels. An image is "local" when it names no registry host
(`wingfoil-forecast:local`, `alpine`, `user/app`); those need `allowLocalImages`.

The CLI is used for `pull/run/stop/rm`, so `docker` handles contexts and credential helpers
(ghcr). The Engine API over the same unix socket is used for `inspect` (exit code, `OOMKilled`)
and one-shot `stats`, without spawning a process every few seconds.

Run command (secrets via `-e NAME` with the value in the child's environment only, never argv or disk):

```sh
docker run -d --name hc-r_01J… \
  --label dev.homecompute.run=r_01J… --label dev.homecompute.job=ecmwf \
  --memory 1024m --memory-swap 1024m --cpus 1 --cpu-shares 256 --pids-limit 4096 \
  --security-opt no-new-privileges --cap-drop ALL --init --network bridge \
  --log-driver local --log-opt max-size=50m \
  -e AWS_REGION=auto -e FORCE5_SIDECARS=0 \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e S3_BUCKET -e S3_ENDPOINT_URL \
  ghcr.io/sprintengine/wingfoil-forecast@sha256:… --models ecmwf --ecmwf-cycle 00
```

The container is removed after `inspect`. Local agent policy, which the server cannot override:
never `--privileged`, never host network, no bind mounts, no `docker.sock`; images must match
`allowImages` (e.g. `ghcr.io/sprintengine/*`); `local:` images only if `allowLocalImages: true`.
Disk cannot be enforced portably (`--storage-opt size` needs overlay2 on xfs with pquota), so
`diskMiB` is checked against free VM/host disk before claiming.

**Low CPU priority.** Linux: containers run under `--cgroup-parent=home-compute.slice`, a systemd
slice with `CPUWeight=20` and `MemoryMax=<cap>`, and the agent has `Nice=10`. macOS: the VM is
the boundary. Inside it, `--cpu-shares` only orders containers against each other. Lowering the
QoS of the VZ process (`taskpolicy`) is an open question (§12): Apple's background QoS confines
work to E-cores and may push imports past their timeouts.

*As built (M3):* `agent/src/runtime/docker-cli.mjs` and `colima.mjs`. The `docker run` argv
is exactly the one above (plus `--cgroup-parent` when `docker.cgroupParent` is set, and
`--entrypoint FIRST IMAGE REST… ARGS…` for an entrypoint list); nothing can add a privilege,
mount, device or host namespace, and a spec that *asks* for one (`privileged`, `volumes`,
`mounts`, `devices`, `capAdd`, `pid`, `network: host`, …) is refused rather than run without
it. Secret names the `docker` process reads itself (`DOCKER_*`, `PATH`, `HOME`, …) are
refused. `allowImages` is **empty by default** (nothing runs until the owner lists patterns;
`doctor` fails), `local:` images need `allowLocalImages`. The Engine API is reached only over
a unix socket. Interface additions, all optional for callers: `imageDigest(ref)`,
`released(runId)`, `setContext()`/`tick()` (the VM lifecycle, below), `selfTest()` (doctor),
and on handles `secretValues(names)` and `detach()`. `idle()` prunes images; `stop()` stops the
VM. A limitation to know: Docker keeps a container's environment, secret values included, in
its own state (inside the VM for Colima) until the container is removed, which the agent does
as soon as the result is in the outbox. After an agent restart the delivered values are read
back from there (`docker inspect`, kept in memory) so the replayed log is still redacted.

### 4.4 Colima on demand, right-sized

The agent uses its own profile, `home-compute`, so it never fights the owner's `default` profile
(which Bacalhau uses during migration). The image cache persists on the profile's disk across stop/start.

```text
 stopped ──(claim, or upcoming run within prewarm)──► starting ──► ready ──(no runs)──► idle
    ▲                                                                                │
    └──────── colima stop home-compute ◄── idle ≥ idleStopSeconds AND no upcoming run within keepWarmSeconds
```

- **Start**: `colima start home-compute --runtime docker --vm-type vz --cpu C --memory M --disk 60`.
  Pre-warm starts the VM `vmBootSeconds (measured) + 10 s` before the first `upcoming` slot for
  this machine, so the container starts on the minute.
- **Size**: `M = clamp(ceil(Σ memory of runs expected concurrently in the next 15 min, at most maxRuns) + 0.75 GiB, 2 GiB, cap)`,
  `C = clamp(max(cpus of those runs), 2, cap)`. A different size is applied **only while the VM
  holds no containers** (stop, then start with new flags; Colima applies new CPU/memory to a
  stopped instance, and its disk can only grow). If a larger run is due while smaller ones are
  running, the agent does not claim it. It is placed elsewhere or waits.
- **Stop**: no containers, no claims, and nothing upcoming within `keepWarmSeconds` (default
  600 s, roughly a boot plus a margin), after `idleStopSeconds` (default 300 s).
- **Failures**: if a start fails 3 times, `health.vm = "failed"`. The server stops offering runs
  to this machine and the dashboard shows the last `colima` error.
- **Sleep**: while a run is active the agent holds `caffeinate -i -w <pid>`.
  *As built:* also while a slot this machine is not merely a fallback for is due within
  `awakeAheadSeconds` (default 900, the sync's 15-minute look-ahead), so an idle Mac that could
  sleep does not sleep through its slot.

*As built (M3):* the start command is `colima start <profile> --runtime docker --vm-type vz
--cpus C --memory M --disk D --activate=false --ssh-config=false --mount none` (Colima 0.10
calls it `--cpus`; `--activate=false` leaves the current docker context alone, `--mount none`
shows the VM none of the owner's files). The boot time is measured from `colima start` until
Docker answers, kept in `vm.json` and reported as `health.vmBootSeconds`. `upcoming` entries
carry `preferredElsewhere: true` for a slot another machine is preferred for; those neither
pre-warm nor size the VM. A smaller size is applied only when it frees at least 1 GiB and the
restart ends before the next slot, and a VM already as large as the cap allows is never
restarted for a run the formula wants larger. The minimum (2 CPU, 2 GiB) is configurable
(`colima.minCpus`, `colima.minMemoryMiB`). `idleStopSeconds`/`keepWarmSeconds` come from the
sync's `config` unless the machine sets its own. A failed start is followed by
`colima stop --force`; failed pre-warms count toward the three failures, and while the machine
is gated only the 5-minute probe starts the VM. After an agent restart a stopped VM is started
only when run records expect containers in it. While containers run, the agent offers the
control plane only what fits beside them (VM memory less 0.75 GiB less what runs).
Measured on the owner's Mac with a 1 CPU / 1 GiB profile (`agent/scripts/acceptance-colima.sh`
and probes, 2026-10-11): creating the profile 13.7–28.8 s, starting a stopped one 9.5–19.4 s,
stopping it about 3 s; the `com.apple.Virtualization.VirtualMachine` process's footprint was
about 750 MB just after boot and up to about 980 MB (RSS 1.1–1.3 GiB) while running a job that
held 200 MiB. A VM's memory is not given back while it runs, so the idle stop is what frees it.
Colima 0.10 keeps a deleted profile's Docker data disk (`~/.colima/_lima/_disks/colima-<profile>`)
unless `colima delete` is given `--data`; uninstall's `--purge-runtime` (§6) needs it.

What this saves with Wingfoil's **current** timetable (every enabled job at 0.5–1 GiB; hourly
slots at :05 blend, :10 prune, :15 forecast-archive (+ sea-temperature, mi-swan), :50 wind-obs):
the VM boots at about :04, idles to about :22, boots again at :49 and stops at about :56. That is
roughly 25 min of every hour at about 2 GiB, instead of 60 min at 6 GiB: about 85% less VM memory
held over a day. Moving `wind-obs` to :20 would make one window per hour (about 30% uptime).
These are estimates; the dashboard measures `vm_wait_ms` and VM uptime per machine to confirm them.

### 4.5 Images

- Jobs should pin `repo@sha256:…`. A `repo:tag` job is allowed. The agent resolves and pulls it
  and records `image_digest` per run, so history always shows exactly what ran.
- The agent pulls only if the digest is missing. It keeps the 3 most recent digests per
  repository and prunes older ones when idle.
- Private ghcr packages: a `registry` secret type (`ghcr.io` user + read-only PAT) is delivered
  with the claim and used via `docker login --password-stdin` for that pull only.
- `local:` images (e.g. `wingfoil-forecast:local`) are for single-machine development. The job
  must require that machine's label.

*As built (M3):* a pinned digest is pulled only when Docker lacks it; a registry **tag** is
pulled every time (nothing is downloaded when it is current), and when the registry cannot be
reached the copy already present runs; a local image is never pulled. The recorded digest is the
pinned one, a pulled tag's repository digest, or a local build's image id. Pruning keeps the 3
most recently *used* digests per repository and only touches images the agent pulled itself
(`images.json`), never the owner's. The registry secret arrives as `spec.registryAuth`
(`{server, username, password}`, delivered by M5): `docker login --password-stdin` into a
throwaway `DOCKER_CONFIG` (0700, under the temp directory), the pull, `docker logout`, and the
directory deleted, so the credential is on disk only for the length of that pull. It is
redacted like the other secrets and never written to the run record.

### 4.6 Logs, errors, reports, stats

- **Capture**: `docker logs -f --timestamps` (stdout+stderr), line-split, then **redacted on
  arrival** before buffering. Redaction replaces the exact values of the run's secrets (plus their
  URL- and base64-encoded forms) and applies `redact.mjs`'s patterns.
- **Local copy**: the full redacted log is gzipped to `state/runs/<run>.log.gz` and kept for
  7 days. A "full log" button that asks the agent to upload it to an optional R2 binding is a later milestone.
- **Tail upload**: during a run, the last 200 lines / 32 KB on each sync, only if changed. At
  completion, 500 lines / 64 KB (`tailLines`).
- **Reports**: every line that `parseReports` accepts is kept **separately from the tail**, so a
  long log never loses a `forecast_complete`. They are bounded by `boundedReports` (32 KB).
  `reportMetrics` derives metrics, and the server updates `published` per `trackBy` value exactly
  as `recordFinished` does today.
- **Error extraction** (`classifyLines`), in order: the last `*_failed` report's `error`; the
  final line of the first Python traceback; the last error-level line; `out of memory (limit 1 GiB)`
  when `OOMKilled`; `timed out after 3900 s`; `exited with N`. `error_detail` is the traceback or
  last 40 error-context lines (4 KB).
- **Stats**: Engine API `GET /containers/{id}/stats?stream=false` every 3 s. Peak memory is
  `max(usage − inactive_file)`, the same figure `docker stats` shows. Average and peak CPU % and
  `cpu_seconds` come from the last sample. Runs shorter than one interval record `stats_samples=0`
  (the dashboard shows "too short to sample"). Workloads may also report `peak*` fields, such as
  `peakRssBytes` from `getrusage(RUSAGE_CHILDREN)`. `reportMetrics` already takes their maximum,
  and the dashboard prefers them when present.
- *As built (M3):* stats are one-shot Engine API samples (`stream=false&one-shot=true`), so CPU %
  is the share of one CPU since the previous sample (the first: since the container started);
  an answer from a container that already stopped (empty memory, zero CPU) is not a sample, and
  `cpu_seconds` is the largest total seen. `docker logs -f --timestamps` lines lose their
  timestamp, a line rewritten with `\r` keeps its last state, stderr counts, and a stream that
  breaks while the container runs is reattached with `--since` the last timestamp, without
  repeats; lines without a timestamp are the CLI's own and go to the agent's log, not the run's.
  The workload's `peak*` fields stay in its reports and metrics; `peak_memory_bytes` is always
  the sampled figure (the dashboard prefers the workload's, M4). Peak memory was measured at
  337 MB for a container holding 320 MiB, on real Docker.

### 4.7 Service, self-update, offline

- **macOS**: a LaunchAgent `dev.homecompute.agent` in the user's GUI domain with `KeepAlive`, as
  `macmini.sh` already does for Bacalhau. A headless Mac needs automatic login, which FileVault
  prevents. Whether a LaunchDaemon with `UserName` can run Colima's VZ VM is open (§12).
- **Linux**: a systemd unit (`User=hcagent`, `Nice=10`, `Restart=always`) plus the `home-compute.slice`.
  Membership of the `docker` group is root-equivalent; rootless Docker is a documented option.
- **Windows (later)**: an Ubuntu WSL2 distro with `systemd=true`, Docker Engine inside, and the
  agent as a systemd unit. A Windows Scheduled Task at boot runs `wsl.exe -d Ubuntu -- true` so WSL
  starts without a login. `.wslconfig` caps memory.
- **Local status**: `127.0.0.1:4787` (read-only, plus `POST /drain`), authenticated by a token in a
  0600 file, for the menu bar app.
- *As built (M2):* one state directory holds the configuration, credential, `env` (local
  secrets), status token, outbox and run records: `~/Library/Application Support/home-compute`
  on macOS; on Linux `/etc/home-compute` for root or when it exists and is writable (the systemd
  install), else `~/.local/state/home-compute`; `--state-dir`/`HC_AGENT_STATE_DIR` override it.
  The agent does not yet call `idle()`/`stop()` on its runtime: the VM lifecycle of §4.4 is M3.
- *As built (M3):* templates in `agent/service/`: `home-compute-agent.service` (`User=hcagent`,
  `SupplementaryGroups=docker`, `Nice=10`, `Restart=always`, light hardening),
  `home-compute.slice` (`CPUWeight=20`, `MemoryMax=@MEMORY_MAX@` for the installer to fill in;
  containers join it through `docker.cgroupParent`), and `dev.homecompute.agent.plist`
  (`KeepAlive`, a Homebrew PATH, `AbandonProcessGroup` so the VM outlives an agent restart,
  `ProcessType` Standard, not Background, which would lower the VM's QoS). Whether a
  LaunchDaemon with `UserName` can run the VZ VM is still untested (risk 5).
- **Self-update**: `update` in a sync gives `{version, url, sha256, signature}`. The agent verifies
  an **ed25519 signature against a public key compiled into the agent**, so even a compromised
  control plane cannot push code. It applies the update only when no runs are active: write
  `agent-<ver>.mjs`, atomically switch the `current` symlink, exit 0, and let launchd/systemd
  restart it. If the new version exits 3 times within 2 minutes, the launcher (a 10-line shell
  wrapper) switches back to `previous`.
- **Offline**: no claims means no new work. The agent does not keep a local schedule; the Wingfoil
  site keeps serving its last forecasts. Running containers finish, results wait in the outbox,
  and the VM stops after the idle timeout.

---

## 5. Security

**People.** `hc-web` sits behind a Cloudflare Access application. On `workers.dev` this is the
one-click "Enable Cloudflare Access"; on a custom domain it is a self-hosted Access app. The
policy allows the owner's email via Google/GitHub/one-time PIN. The Worker **validates
`Cf-Access-Jwt-Assertion` itself** (RS256 against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`
by `kid`, `iss`, and `aud` = the app's AUD tag), as Cloudflare's docs require, with the JWKS cached
in the isolate. Roles are `admin`, `operator` (run/pause/drain/timetable) and `viewer`, mapped from
email or service-token `common_name` in the `roles` setting. An admin edits that map from the
dashboard (Settings › Roles) or `PATCH /v1/settings`. Logins in `BOOTSTRAP_ADMINS` always stay
admin. The update is refused if it would remove the last admin or the caller's own admin role.

**Non-browser clients** (CLI import, menu bar app, Studio module) use Access **service tokens**
(`CF-Access-Client-Id/Secret`). Each has its own role; the menu bar app gets `operator`.

**CSRF.** Every mutating `/v1/*` request needs a JSON content type, a same-origin `Origin`,
`Sec-Fetch-Site: same-origin` when present, and an `X-HC-CSRF` header equal to
`HMAC(CSRF_KEY, sub + iat)` returned by `GET /v1/session`. These are the same checks as
`DashboardAuth.allowsChange`. CORS is never enabled.

**Agents: enrolment.**
1. An admin creates a **join token** (`hcj_<32 random bytes>`): single use, 60 min TTL, stored only
   as a hash, carrying the machine name, initial labels and optionally `provisioner`.
2. `agent enrol` sends it with machine facts. `hc-core` returns `{machineId, credential}`, where
   the credential is `hca_<machineId>_<32 random bytes>`, stored server-side as SHA-256 and on the
   machine in a 0600 file (`/etc/home-compute/credential` or `~/Library/Application Support/home-compute/credential`).
3. Rotation: `rotateCredential` in a sync sets `credential_next_hash`. The agent stores the new
   credential and uses it, and the first request with it promotes it.
4. Revocation (dashboard) clears the hash and audits it. The agent gets 401 and stops claiming.

**Secrets.**
- `hc-web` holds only the vault **public** key (RSA-OAEP-3072). `PUT /v1/secrets/:name` envelope-encrypts
  in the Worker (AES-256-GCM data key, AAD = name + key id) and stores ciphertext and a hint.
- `hc-core` holds the **private** key (Worker secret `VAULT_PRIVATE_KEY`). It decrypts only while
  building the response to a claim, and only for secrets whose `allowed_labels` match the claiming machine.
- Secrets are never returned by any `/v1` endpoint, never logged (no request/response body
  logging; Workers observability limited to status/latency), never in argv or on disk on agents,
  and redacted from logs and reports twice (agent, then Worker).
- Least privilege: the Wingfoil R2 token is an R2 API token with **Object Read & Write on that one bucket**.
- `local:` secrets let a cautious user keep a credential only on the machine that uses it.
- *As built (M5):* `src/core/vault.mjs`. RSA-OAEP-3072 with SHA-256 wraps a fresh AES-256-GCM key
  per value; the GCM additional data is `home-compute-vault\n<name>\n<key id>`, so an envelope copied
  to another name, or opened with another key, fails. The key id is `v1-` and 12 hex digits of
  SHA-256 over the public key's SPKI; hc-core refuses an envelope sealed under another id before
  decrypting. The public key is hc-web's secret `VAULT_PUBLIC_KEY` (not a setting, so a database
  write cannot swap it); the private key is hc-core's `VAULT_PRIVATE_KEY`. `/v1/secrets` (admin):
  `GET` lists names, key ids, hints, allowed labels, the jobs that use each and the names jobs need
  that are not set; `PUT /v1/secrets/:name {value, allowedLabels?}` seals in the Worker; `DELETE`.
  No answer carries a value or an envelope (a workerd test requests every `GET` route after a
  secret was set, claimed and run, and searches each body for the value in five encodings). Hints
  are the last four characters of identifiers only (`…-id`, `…-user`) of 16+ characters. hc-core
  keeps names and labels in isolate memory by `settings.secrets_version`, reads envelopes only for
  the claims it has just won, and keeps each envelope's unwrapped data key as a non-extractable
  `CryptoKey` (at most 64), so only an isolate's first claim of a secret pays the RSA operation
  (about 1–2.5 ms). A claim whose secret is gone, refused by labels or does not open fails at once
  with `vault: <name> <why>`; it never runs without it. A job blocked on an unset secret, or whose
  secrets no machine's labels allow, says so in the snapshot. The CLI: `cloud secrets list | put NAME
  (stdin) | put-env FILE --preset | delete`, and `cloud import --env-file --upload-secrets`; values
  are never in argv or printed. A private registry's credential is a secret holding
  `{server, username, password}` JSON, named by the job's new `registryAuth: "vault:<name>"`
  (migration `0006`), delivered as `spec.registryAuth` (§4.5).

**What a stolen agent credential can do:** claim runs that machine is eligible for, and so receive
those jobs' secrets; send false results for them; see their specs. It **cannot** read or edit jobs,
see other machines' runs, read secrets outside its labels, create join tokens or provision (unless
that machine is the provisioner). Mitigations: the machine page shows `last_ip` with a "new IP"
warning in the audit log, one-click revoke, narrowly scoped workload credentials, and credential rotation.

**What a stolen Access session can do:** run containers on enrolled machines, but only images
the agents' local `allowImages` permits, without privileges, host mounts or host network; it
cannot read secrets back. Provisioning runs a fixed script that ships signed inside the agent;
the control plane only sends validated parameters (§6). **The control plane never sends shell code.**

**Audit:** every human mutation (with before/after JSON), every secret write (name only), every
enrolment, revocation, run-now, cancel, provisioning task and update push.

---

## 6. Remote provisioning over the tailnet

**Who:** one machine with capability `provisioner` (the Mac mini), granted at enrolment by an admin.

### Prerequisites on the target

| OS | Needs |
| --- | --- |
| Linux (Debian/Ubuntu/Fedora) | On the tailnet. **Either** Tailscale SSH (`tailscale up --ssh`) with an ACL rule `src: tag:hc-provisioner → dst: tag:hc-target, users: [hc-admin], action: "accept"` (`check` mode needs periodic browser re-authentication, so it is unsuitable unattended), **or** OpenSSH with the provisioner's dedicated key in `authorized_keys`. A user with passwordless `sudo` for the install. |
| macOS | Remote Login on (System Settings › General › Sharing), an admin user, **Homebrew already installed** (its first install is interactive), and the provisioner's key. The Tailscale SSH server on macOS works only with the open-source `tailscaled`; plain OpenSSH over the tailnet IP is the default. |
| Windows | Later milestone. The Tailscale SSH server does not run on Windows; this needs Windows OpenSSH plus WSL2 Ubuntu, then the Linux script inside WSL. |

### Flow

1. Dashboard › Machines › **Add machine**: tailnet host (`*.ts.net` name or `100.64.0.0/10` address,
   validated), SSH user, method, OS hint, name and labels. `hc-web` creates a `provisioning_task`
   and a join token bound to it, and audits both.
2. The provisioner claims the task on its next sync (provisioning tasks travel in the same sync).
3. The provisioner runs **its own bundled, signed** `install.sh` (never one supplied by the server):
   `ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new user@host 'bash -s -- install' < install.sh`.
   It sends the join token and parameters **on stdin** after the script (as an env block the script
   reads), never in argv. It also copies the agent `.mjs` over the same SSH session, so the target
   needs no trust in a download URL for the agent itself. The host key fingerprint is recorded in the task.
4. The script prints `HC-STEP {"step":"…","status":"start|ok|skip|fail","detail":"…"}` lines. The
   provisioner relays them in its syncs, and the dashboard shows a live step list plus a 32 KB
   redacted output tail.
5. The new agent enrols with the join token and syncs. The task becomes `succeeded` with
   `result_machine_id`. If no enrolment arrives within 10 minutes, it becomes `failed`.

### install.sh steps (each checks before acting; running it twice gives all `skip`)

| # | Step | Linux | macOS |
| --- | --- | --- | --- |
| 1 | `preflight` | OS/arch, `sudo -n true`, free disk ≥ 20 GB, outbound HTTPS to the control plane and ghcr.io | same, plus `brew` present |
| 2 | `runtime` | Docker Engine from the distribution's or Docker's signed apt/dnf repository; `systemctl enable --now docker` | `brew install colima docker` (CLI only); VM **not** started |
| 3 | `node` | Pinned Node 22 tarball to `/opt/home-compute/node`, SHA-256 checked | same, to `~/Library/Application Support/home-compute/node` |
| 4 | `agent` | Agent file to `/opt/home-compute/agent/<ver>/`, `current` symlink, `hcagent` user in the `docker` group | user-local equivalent |
| 5 | `enrol` | `agent enrol --server … --join-token-stdin` (skipped if a valid credential exists, unless `--reenrol`) | same |
| 6 | `service` | systemd unit + slice, `enable --now` (rewritten only if changed) | LaunchAgent plist, `launchctl bootstrap` |
| 7 | `verify` | `agent doctor`: Docker answers, runs `docker run --rm hello-world`, first sync OK | same; also starts and stops Colima once to measure boot time |

**Uninstall** (`kind: uninstall`): stop and remove the service, revoke the machine, delete agent
files and state. `--purge-runtime` also removes Docker/Colima, the profile and images; this is not
the default. **Upgrade** reuses the steps; step 4 wins.

---

## 7. Dashboard and API

### Pages (mobile-first PWA, built on the `feature/dashboard` app)

1. **Overview**, in order: **running now** (job, machine, phase, elapsed, live peak memory; the
   longest-running first); **next up** (next 6 slots, soonest first, with expected machine; the very
   next one largest); **attention** (failed last runs, `lost`, runs waiting more than 10 minutes,
   offline or unhealthy machines, agents needing an update); **jobs**
   (card per job: schedule text, last outcome chip, `published` per model, a 20-run duration sparkline).
2. **Job**: state and controls (Run now with optional extra args, Pause/Resume, Enable); **timetable
   editor** (hour chips, minute chips, Every hour, as in the Mac app); **placement** (required
   labels, preferred machine, wait); **resources** (memory picker with a hint such as "peak 410 MiB
   over 20 runs; limit 1 GiB"); image (digest, "promote tag → digest"); history table (time, machine,
   queue wait, duration, peak memory, outcome, error) with infinite scroll.
3. **Run**: a phase timeline (due → claimed → VM → pull → run → report with durations), stats,
   reports (model/run/frames/phases), error summary, and the **log tail** with error lines
   highlighted (`classifyLines`), a "jump to first error" button, and Cancel/Retry.
4. **Machines**: status (online/offline/draining/unhealthy), the VM (stopped / running 2 CPU 2 GiB),
   the current run, capacity caps, labels, agent version, last seen, clock skew. Actions: drain,
   edit labels/caps, rename, update agent, revoke. Machine detail adds a 24 h timeline of what it
   ran and VM uptime.
5. **Timetable**: all jobs on a 24-hour UTC grid (a vertical list on phones), with local time shown
   beside it (Irish time for the owner), disabled jobs folded into one line.
6. **Add machine / Provisioning**: the wizard and live task steps; join tokens for manual install
   (shows a copy-paste one-liner once).
7. **Secrets** (write-only, hints only), **Settings** (retention, global pause, agent channel), **Audit**.

Live updates: the visible page polls `GET /v1/changes?since=<cursor>` every 10 s, which returns
an empty body when nothing changed (cursor = `max(runs.updated_at, jobs_version, machines change)`),
and fetches the snapshot only when something did. Polling stops while the page is hidden. Push is a later option (§12).

*As built (M4):* the pages above except Provisioning (M6) and Secrets (M5, shown once the API
lists `secrets` among its features); Add machine makes join tokens, shown once with copy-paste
install and enrol commands (agent/README.md, "Install by hand") that read the token at a prompt,
never from argv. Navigation is a bottom tab bar on phones and a sidebar on desktops. The
dashboard stays plain ES modules with no build step, served by hc-web (and, until M7, by the
local controller, which it still supports); `sw.js` caches its files network-first for offline
use and never the API. Beyond §7's list: `PATCH /v1/jobs/:id/placement` and `/resources` are
operator, `/image` admin; `GET /v1/machines/:id/runs?since=` feeds the machine timeline; job
history takes `skipped=0`; the snapshot adds (never changes) per-job `placement` and `durations`
(20 finished runs, read with a narrow query of its own), `upcoming` (next six slots with the
expected machine, from the same placement rules hc-core claims by, without capacity),
`lostRuns`, `desiredAgentVersion`, and per machine `vmSince`, `vmHistory` and
`updateAvailable`. "Agents needing an update" compares against `settings.desiredAgentVersion`,
else the newest version any enrolled machine runs. Schedules show UTC with Irish time
(`Europe/Dublin`) beside them, omitted when the two agree. The workload's own `peak*` memory is
preferred over the sampled peak wherever both exist (§4.6).

### Human API (`hc-web`, Access + CSRF; paths compatible with today's local controller)

```text
GET    /v1/session                          who am I, role, CSRF token
GET    /v1/snapshot                         jobs (+ recentRuns, nextDueAt, published), machines, `nodes` alias
GET    /v1/changes?since=
GET    /v1/jobs/:id                         full definition + revision
PUT    /v1/jobs/:id                         create/replace (If-Match: revision)       admin
PATCH  /v1/jobs/:id/timetable               {enabled?, hours?|"every", minutes?}       operator
PATCH  /v1/jobs/:id/placement | /resources | /image                                    operator/admin
POST   /v1/jobs/:id/run                     {extraParameters?, machine?, force?}       operator
POST   /v1/jobs/:id/pause | /resume                                                    operator
POST   /v1/pause-all | /v1/resume-all                                                  operator
DELETE /v1/jobs/:id                                                                    admin
GET    /v1/jobs/:id/runs?before=&limit=
GET    /v1/runs/:id        GET /v1/runs/:id/logs       POST /v1/runs/:id/cancel | /retry
GET    /v1/machines        PATCH /v1/machines/:id     DELETE /v1/machines/:id (revoke)
POST   /v1/machines/:id/update-agent
POST   /v1/join-tokens                      returns the token once                     admin
GET|POST /v1/provisioning  GET /v1/provisioning/:id  POST /v1/provisioning/:id/cancel  admin
GET    /v1/secrets         PUT|DELETE /v1/secrets/:name                                admin
POST   /v1/import?dryRun=1                  job set → diff / apply                     admin
GET    /v1/audit?before=
```

### Agent API (`hc-core`, bearer machine credential)

```text
POST /agent/v1/enrol                   {joinToken, name, facts, publicFacts} → {machineId, credential}
POST /agent/v1/sync                    §4.2
POST /agent/v1/runs/:id/complete       final record (idempotent)
POST /agent/v1/provisioning/:id/events step lines (provisioner only)
```

Requests are size-capped at 128 KB (sync) and 256 KB (complete) to stay inside the 10 ms CPU budget.

---

## 8. Wingfoil preset

**Import path.** `deploy/schedules.py` already compiles `jobs.toml` into the v1 Home Compute format
(`deploy/home-compute/home-compute.json`): resources, timeouts, the prune entrypoint, required
env and json-lines reports. The importer therefore reads **that generic file**, not TOML:

```sh
home-compute cloud import ../wingfoil/deploy/home-compute/home-compute.json \
  --preset wingfoil \
  --image ghcr.io/sprintengine/wingfoil-forecast@sha256:<production digest> \
  --env-file ../wingfoil/deploy/home-compute/.env --upload-secrets \
  --dry-run            # prints a per-job diff; rerun without it to apply
```

`presets/wingfoil.json` holds what the v1 file does not:

```json
{
  "id": "wingfoil",
  "secrets": { "S3_BUCKET": "wingfoil-r2-bucket", "S3_ENDPOINT_URL": "wingfoil-r2-endpoint",
               "AWS_ACCESS_KEY_ID": "wingfoil-r2-key-id", "AWS_SECRET_ACCESS_KEY": "wingfoil-r2-secret" },
  "env": { "AWS_REGION": "auto", "FORCE5_SIDECARS": "0", "ECMWF_SOURCE": "ecmwf" },
  "placement": { "preferMachines": ["mac-mini"], "preferWaitSeconds": 300 },
  "policy": { "overlap": "coalesce", "catchUp": "latest",
              "retry": { "maxAttempts": 3, "onLostRunning": true, "onFailed": 0 } },
  "network": "bridge"
}
```

- `onLostRunning: true` is safe for Wingfoil because each importer reads the bucket's published
  run first (`readsPublishedRun`) and publishing is idempotent. `tides` and `sea-temperature`
  re-import, which wastes work but does no harm.
- The bucket name and endpoint (it contains the account id) are stored as secrets because they are
  locators. `secretValues()` in `redact.mjs` already treats `*_URL`/`*ENDPOINT*` values that way.
- `${WINGFOIL_IMAGE}` resolves to `--image`, which defaults to resolving
  `ghcr.io/sprintengine/wingfoil-forecast:production` to its digest (macmini.sh's `RELEASED_IMAGE`).
- Run history can be carried over: `home-compute cloud import-history ../wingfoil/deploy/home-compute/state/history/`
  copies the `feature/dashboard` per-job files (`source: "import"`), so the dashboard shows continuity.

**Source of truth: the control plane.** Editing from a phone is the requirement, and a git
round-trip from a phone is not realistic. The menu bar app's Timetable tab writes `jobs.toml`
through `macmini.sh jobs set` today; it becomes a client of `PATCH /v1/jobs/:id/timetable` (same
body). `jobs.toml` remains authoritative for the **Compose** deployment and the **seed** for the
preset. Drift is visible, not silent: `home-compute cloud diff <file> --preset wingfoil` lists
differing fields, and the job page shows a "differs from preset" badge. Re-importing never
overwrites a field edited in the dashboard since the last import unless `--force` is given. For
anyone who wants the repo to follow, `home-compute cloud export --preset wingfoil --as schedules-set`
prints the `schedules.py --set …` commands that would bring `jobs.toml` up to date.

Wingfoil's separate Cloudflare Containers deployment (`deploy/cloudflare/`) has been removed:
a job runs on Cloudflare Containers through this control plane instead, by its placement
([cloudflare-containers.md](cloudflare-containers.md)).

---

## 9. Migration from the live Bacalhau setup (no forecast gaps)

Principle: **cut over one job at a time.** At every moment each job is enabled in exactly one
system, so there are no double runs and no gaps, and each step is reversible on its own. Switches
happen between a job's slots.

| Phase | What | Check | Rollback |
| --- | --- | --- | --- |
| 0. Shadow | Deploy `hc-web`/`hc-core`. Import all Wingfoil jobs with **global pause on**. Cron records slots as `skipped(paused-at-slot)`. | For 48 h, the hosted timetable's slots match the Bacalhau controller's submissions (compare with `controller.log`). | Delete the Workers. |
| 1. Agent | Enrol the Mac mini agent with a `home-compute` Colima profile capped at **2 CPU / 3 GiB** while Bacalhau's `default` profile is still up. Run a non-Wingfoil `hello` job and one manual Wingfoil run against a **test prefix** (`S3_PREFIX=staging/`). | Peak memory, logs, reports and outcome show up. The VM stops after idle. | `agent uninstall`. |
| 2. Low-risk jobs | Per job: **pause it on the old controller** (`POST :4786/v1/jobs/<id>/pause`, durable state, `jobs.toml` untouched), then **resume it hosted**. Order: `verify`, `tides`, `icon-eu-weather`, `icon-eu`. | `panel.py r2-test` / dashboard `published`: each model's manifest run advances on schedule and stays within `maxAgeHours`. | Resume on the old controller, pause hosted. |
| 3. Hourly jobs | `blend`, `wind-obs`, `forecast-archive`, `sea-temperature`, `mi-swan`, `gfs`, `gfs-wave`, `harmonie`, `ecmwf`. Then shrink Bacalhau: `colima stop && colima start --memory 2`, `macmini.sh setup` to rewrite its capacity. | No `due` run waits more than 5 min. The Mac stays responsive (`memory_pressure`). | Per job, as above. |
| 4. Prune last | `prune` moves last, alone. Two sweeps must never race. | Superseded runs are still removed 6–7 h after replacement. | As above. |
| 5. Soak | 7 days with all jobs hosted and Bacalhau idle but **installed**. | Zero `lost` without recovery; no model stale beyond its `maxAgeHours`. | `macmini.sh start`, resume all on the old controller, `pause-all` hosted (about 2 min). |
| 6. Decommission | `macmini.sh stop`; remove both plists; `colima delete default` (after confirming nothing else uses it); remove `~/.local/bin/bacalhau`. Home Compute: delete `src/bacalhau.mjs`, `cli daemon`, `examples/systemd/bacalhau-*`; update the README requirements. Wingfoil: `schedules.py` stops writing `home-compute.json` (or keeps it as the import source); retire `macmini.sh` and `panel.py` service commands; update `deploy/home-compute/README.md`. | | Tagged release `v0.2-bacalhau` remains installable. |

Double runs during a mistaken overlap are harmless (`readsPublishedRun`) but wasteful. The
per-job switch avoids them, except for `prune`, which phase 4 isolates.

*As built (2026-10-12):* phase 0 began at 15:49 UTC: D1 in `weur`, both Workers on
`workers.dev`, all 21 Wingfoil jobs imported paused **and** under the global pause (so lifting the
global pause before the cut-over still runs nothing, and each job is then resumed alone). The
comparison is `cloud/scripts/shadow-compare.mjs`, run twice an hour by a LaunchAgent: it keeps a
ledger of the controller's submissions (its history files keep only 50 runs; `controller.log` had
no timestamps, which it now has) and compares them slot by slot with the hosted rows. Phase 1:
the Mac mini's agent is enrolled with labels `site=home` and caps 2 CPU / 3 GiB, ran `hello`
(Alpine) and one manual `wind-obs` into `staging/` with the vault's R2 secrets
(`wingfoil-forecast:local`, published, 11 s, peak 82 MB). Robustness tests are in
[deploy.md](deploy.md) §6. Bacalhau's `default` profile is 2 CPU / 3 GiB already, not the 6 GiB
this document assumed, so phase 3's shrink is not needed.

---

## 10. Menu bar app and Studio module

**Menu bar app (Home Compute Bar).** It becomes two things:
1. A **hosted client**: `menubar.json` gains `url` (the `hc-web` hostname) plus an Access service
   token in place of the `:4786` bearer token. `APIClient.swift` adds the `CF-Access-Client-*`
   headers. The popover, notifications and run/pause/resume work unchanged because `/v1/snapshot`
   keeps its shape (`nodes` aliases machines; run ids change from `j-…` to `r_…`). SSE `/v1/events`
   is replaced by polling `/v1/changes`, which `Store.swift` already falls back to every 15 s.
2. The **local agent's face** on that Mac, via `127.0.0.1:4787`: agent and Colima state, current
   run, VM size and uptime, a **"Using this Mac: drain"** toggle, and "Open dashboard".

Settings tabs: *Services* → agent + Colima (start/stop agent, Colima profile status, logs folder).
*Storage* → removed (secrets live in the dashboard; the app may link to it). *Worker image* →
replaced by the job's image/digest view on the dashboard. *Timetable* → calls the hosted API.
*Connection* → URL + service token. `macmini.sh`/`panel.py` integration is removed after decommission.

**Studio module.** Studio is only a client today and stays one. Its main-process bridge points at
the hosted URL with a service token; its worker cards show machines (VM state, current run)
instead of Bacalhau nodes. The manifest permissions are unchanged (`network`, `storage`). The
module is a small change (base URL, headers, `machines` field), and its marketplace signing plan is unaffected.

---

## 11. Build plan

Each milestone can be shipped and tested on its own. Effort assumes one developer with AI
assistance, in focused days.

| # | Milestone | Ships | Tests | Effort |
| --- | --- | --- | --- | --- |
| M0 | **Core extraction** | `src/core/{job,schedule,reports,history,redact,logs}.mjs` with no `node:` imports; old code imports from it; `feature/dashboard` merged first | Existing `node --test` suite passes unchanged; new tests for `materialise()` (coalesce/skip/catch-up/pause, `every` anchoring) and `transition(run, event)` | 2 d |
| M1 | **Control plane skeleton** | `cloud/` workspace: `wrangler.web.jsonc` + `wrangler.core.jsonc`, `migrations/0001_init.sql`, cron materialisation, job CRUD, `/v1/snapshot`, `cloud import` (dry-run diff), deployed in **shadow mode** | `@cloudflare/vitest-pool-workers` (workerd + local D1, migrations applied): cron twice in one minute → one run; coalescing; pause; import idempotency; Access JWT checks against a test JWKS; CSRF refusals | 5 d |
| M2 | **Agent MVP (fake runtime)** | Enrol, sync, claim, leases, lost/retry, complete, outbox, adopt-on-restart | Integration in `node --test`: Miniflare/`unstable_dev` hosting `hc-core` + agent with `FakeRuntime` and a fake clock. Two agents race for one run → one winner; agent killed mid-run → `lost` → retry; late complete → `recovered`; offline control plane → outbox drains later. *Built: `cloud/test-node/agent-integration.test.mjs` (Miniflare, a clock both sides share).* | 5 d |
| M3 | **Docker + Colima runtime** | `DockerCliRuntime`, `ColimaRuntime` (pre-warm, size, idle stop), stats, OOM/timeout, redaction, policy (`allowImages`) | CI (ubuntu-latest has Docker): a fixture image that prints json-lines, echoes a secret (must be `<redacted>` server-side), allocates 300 MB (peak ≥ 300 MB), OOMs at `--memory 64m`, sleeps past `runSeconds`. Colima: unit tests against a fake `colima` binary (the `macos/dev/fake-setup.sh` pattern) for start/resize/stop decisions; a manual acceptance script on the Mac mini (GitHub's macOS runners cannot run nested VMs). *Built: fake `docker`/`colima`/`caffeinate` binaries on PATH (`agent/test/fake-bin/`) with a fake Engine on a unix socket; `agent/test/docker-real.test.mjs` and `cloud/test-node/docker-integration.test.mjs` on real Docker (CI requires them; on a Mac they run in a throwaway profile via `agent/scripts/with-test-colima.sh`); `agent/scripts/acceptance-colima.sh`.* | 6 d |
| M4 | **Hosted dashboard** | Port `feature/dashboard` app to `hc-web` assets; Access sign-in; Machines, Timetable grid, run detail with phases/stats; `/v1/changes` polling | Existing `test/dashboard.test.mjs` approach against the Worker; Playwright smoke at a 390×844 viewport (overview, run now, timetable edit) *Built: `test/dashboard-lib.test.mjs` (the page logic in Node), `cloud/test/dashboard-api.test.mjs` (workerd), and `cloud/test-node/dashboard-browser.test.mjs`: Chromium through `playwright-core` at 390×844 and 1440×900 against both Workers under `wrangler dev`, seeded with Wingfoil's timetable, a FakeRuntime agent and runs in several states; `cloud/scripts/dashboard-screenshots.mjs` shoots every page.* | 4 d |
| M5 | **Secrets + Wingfoil cut-over** | Vault (RSA-OAEP envelope, split keys), Wingfoil preset, `import-history`, migration phases 1–4 | Worker tests: no `/v1` response contains a secret value (grep every endpoint's body); claims to non-matching labels get no secrets. Migration checklist per job | 3 d + 1–2 wk soak |
| | | *Built (2026-10-12): the vault (§5 as built), registry credentials, the dashboard's Secrets page, phase 0 (deployed, shadow) and phase 1 (agent enrolled, `hello` and a staging Wingfoil run). Tests: `test/core-vault.test.mjs`, `cloud/test/vault.test.mjs`. Not yet: `import-history`, phases 2–4 (the checklist is [deploy.md](deploy.md) §8).* | | |
| M6 | **Provisioning (Linux, then macOS)** | Provisioner capability, `install.sh`, task UI, uninstall | `shellcheck`; `install.sh --dry-run` with stubbed `apt`/`systemctl`/`brew` asserting step order and second-run `skip`; real run against a tailnet Linux VM and a spare Mac (checklist) | 5 d |
| M7 | **Self-update, clients, Bacalhau removal** | Signed releases (ed25519), launcher rollback, menu bar app retarget, Studio retarget, phase 6 decommission | Update test: signed v+1 applies only when idle; bad signature refused; crash-looping update rolls back. `swift test` for the app with the fake controller updated to the hosted shape | 4 d |
| M8 | **Later** | Windows/WSL2, Web Push or email on failure, full logs to R2, push via a hibernating Durable Object, a Cloudflare Containers "burst machine" | | — |
| | | *Email alerts and a dead-man check were pulled forward (§13).* | | |

Total for M0–M7 is about **34 working days** plus the soak. CI runs `npm run check` (core + agent +
Studio), `npm run test --workspace cloud` (workerd), and the Docker integration job.

---

## 12. Free-tier headroom, risks and open questions

### Verified limits (Cloudflare docs, checked 2026-10-11)

| Limit (Workers Free) | Value | Source |
| --- | --- | --- |
| Worker requests | 100,000/day, reset 00:00 UTC; over the limit → Error 1027 | https://developers.cloudflare.com/workers/platform/limits/ |
| CPU per HTTP request / per Cron invocation | 10 ms / 10 ms | same |
| Subrequests per invocation; memory | 50; 128 MB | same |
| Cron Triggers per account | 5 | same |
| Static assets | requests "free and unlimited"; 20,000 files, 25 MiB each | https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/ |
| Cron behaviour | UTC; runs "on underutilized machines"; trigger changes take up to 15 min to propagate | https://developers.cloudflare.com/workers/configuration/cron-triggers/ |
| D1 | 10 DBs, 500 MB per DB, 5 GB per account, 50 queries per invocation | https://developers.cloudflare.com/d1/platform/limits/ |
| D1 daily | 5M rows read, 100k rows written; over the limit → queries error until 00:00 UTC; rows read = rows scanned | https://developers.cloudflare.com/d1/platform/pricing/ |
| D1 Time Travel | 7 days on Free, always on | https://developers.cloudflare.com/d1/reference/time-travel/ |
| Durable Objects (not used in v1) | SQLite-backed only on Free; 100k requests/day (including alarms), 13,000 GB-s/day, 5M rows read / 100k written per day, 5 GB | https://developers.cloudflare.com/durable-objects/platform/pricing/ |
| Access | 500 apps, 50 service tokens per account | https://developers.cloudflare.com/cloudflare-one/account-limits/ |
| Access JWT | Workers behind Access must still validate `Cf-Access-Jwt-Assertion` | https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/ |
| One-click Access for `workers.dev` | available | https://developers.cloudflare.com/changelog/2025-10-03-one-click-access-for-workers |
| R2 (optional full logs) | 10 GB-month, 1M Class A, 10M Class B per month | https://developers.cloudflare.com/r2/pricing/ |
| Tailscale SSH server | Linux and macOS (open-source `tailscaled` only); `check` needs periodic re-authentication | https://tailscale.com/kb/1193/tailscale-ssh |

Not confirmed on a current Cloudflare page: **Access free for up to 50 users** appears only in
Cloudflare's launch post (https://blog.cloudflare.com/teams-plans) and third-party pricing pages.
Whether **Cron invocations count toward the 100k requests** is not stated, so the budget below
counts them. The Durable Objects limits page gives both 1 GB and 10 GB as the Free per-object storage.

### Budget (3 machines, current Wingfoil timetable: 123 runs/day)

| Resource | Estimate/day | Share of free limit |
| --- | --- | --- |
| Requests: agent idle syncs (3 × 2,880 at 30 s) | 8,640 | |
| Requests: syncs during runs (10 s; ~1 min average run) + completes | ~900 | |
| Requests: cron (counted although it may not be) | 1,440 | |
| Requests: dashboard (1 h/day visible, 10 s polling) + CLI | ~500 | |
| **Total requests** | **~11,500** | **11.5%**; about 16 machines at 30 s before 50% |
| D1 rows written: runs (~22 per run including indexes) | ~2,700 | |
| D1 rows written: lease renewals, throttled `last_seen`, log-tail upserts, retention deletes, audit | ~3,000 | |
| **Total rows written** | **~5,700** | **~6%** |
| D1 rows read: syncs (~10 rows with the cached job set) + cron (~60) + dashboard (~150 per refresh) | ~250,000 | **~5%** |
| D1 storage at steady state (runs 180 d at ~2 KB; success tails 14 d / failure tails 90 d at ≤ 64 KB) | ~100–150 MB | 20–30% of 500 MB |
| CPU per request | target p99 < 4 ms (D1 waiting is not CPU; bodies capped; JWKS cached) | 10 ms limit |
| Cron triggers | 1 | of 5 |

Retention, run hourly by cron in batches of 500: `skipped` rows 14 d; runs 180 d (always keeping
the last 50 per job); `run_logs` 14 d for successes and 90 d for failures; audit 365 d.
Backups: D1 Time Travel (7 d) plus a weekly Home Compute job that runs `wrangler d1 export` to R2.

### Risks

1. **Request-quota exhaustion by strangers.** `hc-core` is public. Unauthenticated requests are
   rejected cheaply but still count toward 100k/day. If exhausted, scheduling stops until 00:00 UTC
   while running containers finish. Mitigation: use a custom domain and a free WAF rate-limiting
   rule in front of `/agent/*`; agents back off on 1027/429.
2. **The 10 ms CPU limit.** Large log uploads and regex redaction are the hot spots. Caps: 32 KB
   during runs, 64 KB at completion. Redaction is done first on the agent, and the Worker's pass is
   linear-time patterns only. Measure with `wrangler tail` CPU metrics in M1.
3. **Cron jitter.** Cron may be late, which lazy materialisation on sync covers. Cron propagation
   takes up to 15 minutes, so deploy the cron trigger once.
4. **Colima on demand.** Boot takes time (measured and pre-warmed); `vz` can break after macOS
   updates; there is only a CLI, no API. Health gating and a clear error on the machine page
   handle it; a fixed always-on mode (`idleStopSeconds: 0`) is the fallback.
5. **Headless macOS service context.** A LaunchAgent needs a logged-in user, and automatic login
   conflicts with FileVault. Whether Colima's VZ VM runs from a LaunchDaemon with `UserName` is
   **open**; test it in M3.
6. **macOS CPU priority.** Whether `taskpolicy`/`renice` on the VZ process helps without pushing
   imports past their timeouts is **open**; default to normal priority.
7. **ghcr visibility.** Is `wingfoil-forecast` public? If private, a read-only PAT is needed as a
   registry secret (M5). Every machine needs the right architecture until the image is multi-arch
   (`docker buildx … linux/amd64,linux/arm64` as in the original README).
8. **Long network blips while running.** These are marked `lost` and retried after the grace
   period; double execution is possible for jobs that declare `onLostRunning`. That is acceptable
   for Wingfoil, and the default is off for generic jobs.
9. **Single point of control.** If the Cloudflare account or `hc-core` is compromised, attackers
   can run allowed images and obtain the secrets of the jobs they can claim. Mitigations: the split
   vault keys, label-scoped secrets, agent-side `allowImages`, signed agent updates, fixed
   provisioning scripts, and narrowly scoped R2 tokens.
10. **Pausing the old controller per job** relies on its durable pause state surviving restarts;
    it does (`record.paused` in `state.json`), but verify after any `macmini.sh restart`.

### Open questions for the owner

- A custom hostname (e.g. on a zone already in Cloudflare) or `workers.dev`? A custom domain
  enables the WAF rate-limit rule in risk 1; `workers.dev` works with the two-Worker split.
- Should the hourly Wingfoil slots be clustered (e.g. `wind-obs` at :20) to get one VM window per hour?
- What should notifications on failure use: Web Push, email, or the menu bar app only?
  *Answered (2026-10-12): email through Email Routing, plus a GitHub issue from the dead-man
  check (§13).*
- Should the Cloudflare Containers executor also act as a "burst machine", picking up `due` runs
  when no home machine is online for more than N minutes? Today a job runs there only when its
  placement asks for `runtime=cloudflare-container` ([cloudflare-containers.md](cloudflare-containers.md)).

---

## 13. Alerts (pulled forward from M8)

*As built (2026-10-12).* The owner hears about these without opening anything:

| Kind | Opens when | Resolves when |
| --- | --- | --- |
| `job-failing` | a job's last two runs failed (`schedule_state.fail_streak`, kept where runs settle: completion, the timeout backstop, a claim refused a secret) | a run succeeds |
| `stale` | a tracked output's newest `run` is older than its `maxAgeHours` and the job's first slot after that point, plus an hour, has passed | a newer run is published |
| `no-machine` | machines are enrolled and none synced for 10 minutes | a sync |
| `waiting` | a run due more than 15 minutes ago is unclaimed (scheduled runs held by a pause do not count) | it is claimed |

- **Freshness.** A job's `report.freshness` is `{"<trackBy value>": {maxAgeHours, url?}}`. The
  Wingfoil preset fills it per model from `registry.py`'s `maxAgeHours` and the model's pointer on
  the data domain. The age is the newer of the job's own `published` and the pointer's `run`, which
  hc-core reads every 15 minutes (13 small fetches; a failed read keeps the last good value), so the
  alert covers jobs still on the old controller. Waiting for the next slot keeps a model like GFS,
  whose newest run is 10–16 hours old in normal operation against a 12-hour limit, from alerting
  twice a day; it alerts if a slot that should have refreshed it did not.
- **Delivery.** `alerts` rows (migration `0005`), one open row per key. hc-core's cron (last in
  its minute, so a failure there never stops scheduling) opens, updates and resolves them, and
  sends one plain-text email per change through the `send_email` binding `ALERT_EMAIL` to
  `ALERT_EMAIL_TO` (a verified Email Routing destination), at most one per 5 minutes, a reminder
  daily while open; a failed send is retried after 10 minutes and shown on the dashboard. Every
  write is one statement per kind of change (D1's 50 queries per invocation).
- **The dashboard** shows open alerts, a stopped cron and failing email at the top of every page;
  Settings has an Alerts card with *Send a test alert* (`POST /v1/alerts/test`, admin), which the
  next cron minute emails and then resolves quietly. `GET /v1/alerts` (viewer) lists open alerts,
  the last week's resolved ones, the cron's last tick and email status; the snapshot carries the
  same as `alerts` and `controller.cron`.
- **The cron itself** writes `settings.cron_last_tick` every minute. `GET /health` on hc-core is
  liveness (200); `GET /health/cron` is 503 once the tick is 5 minutes old or D1 does not answer.
  `.github/workflows/deadman.yml` asks it every 10 minutes from outside Cloudflare and opens a
  GitHub issue (label `deadman`) when it fails twice a minute apart, closing it when it recovers.

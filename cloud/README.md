# Hosted control plane (Cloudflare Workers)

This workspace is the control plane of
[docs/hosted-control-plane.md](../docs/hosted-control-plane.md), milestones M0
to M4: two Workers from one codebase and one D1 database. The agent that
talks to `hc-core` is in [../agent](../agent/README.md).

| Worker | Config | What it does |
| --- | --- | --- |
| `hc-web` | `wrangler.web.jsonc` | The dashboard (static assets from `../dashboard`) and the `/v1` human API, behind Cloudflare Access. |
| `hc-core` | `wrangler.core.jsonc` | The agent API (`/agent/v1/*`: enrol, sync, complete), and the `* * * * *` cron: creates due runs, marks expired leases `lost` and retries them by policy, times out unfinished runs, applies retention hourly, then starts any job that targets the Cloudflare Containers executor ([docs/cloudflare-containers.md](../docs/cloudflare-containers.md)). |

Both import the pure modules in `../src/core`, which the local controller and
the agent share. Nothing here is deployed yet: the steps at the end are for
later.

## Running it locally

From the repository root, `npm ci` installs this workspace too (wrangler,
vitest and `@cloudflare/vitest-plugin`; the Workers have no runtime
dependencies).

```sh
cd cloud
cp .dev.vars.example .dev.vars     # CSRF_KEY, and DEV_ACCESS_EMAIL to stand in for Access
npm run migrate:local              # applies migrations/ to a local D1 in .wrangler/state
npm run dev:web                    # http://localhost:8787: the dashboard and /v1
npm run dev:core                   # http://localhost:8788, sharing the same local D1
curl "http://localhost:8788/__scheduled?cron=*+*+*+*+*"   # run one cron minute by hand
```

Locally there is no Access in front, so `DEV_ACCESS_EMAIL` signs every request
from `localhost` in as that person (list them in `BOOTSTRAP_ADMINS` to make
them an admin). It is ignored for any other host name, so a deployed Worker
never honours it; do not set it as a deployed var anyway.

Import Wingfoil's timetable into the local Worker, then open the dashboard:

```sh
HC_URL=http://localhost:8787 node ../src/cli.mjs cloud import \
  ../../wingfoil/deploy/home-compute/home-compute.json --preset wingfoil --dry-run
```

With `DEV_ACCESS_EMAIL` the CLI needs no token locally. Against a deployed
`hc-web` it sends an Access service token from `HC_ACCESS_CLIENT_ID` and
`HC_ACCESS_CLIENT_SECRET`.

Enrol an agent (with its fake runtime, so no Docker is needed) against the
local `hc-core`, then run something on it:

```sh
curl -s -X POST localhost:8787/v1/join-tokens -H 'content-type: application/json' \
  -d '{"name":"dev-box"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token' > /tmp/join-token
npm run build:agent --prefix ..
node ../agent/dist/home-compute-agent.mjs enrol --server http://localhost:8788 \
  --join-token-stdin --state-dir /tmp/hc-agent < /tmp/join-token
node ../agent/dist/home-compute-agent.mjs run --state-dir /tmp/hc-agent &
curl -s -X PUT localhost:8787/v1/jobs/hello -H 'content-type: application/json' \
  -d '{"image":"ghcr.io/example/hello@sha256:1234","schedule":null}'
curl -s -X POST localhost:8787/v1/jobs/hello/run -H 'content-type: application/json' -d '{}'
```

The agent claims the run on its next sync (at most 30 s while idle) and
`GET /v1/snapshot` shows the machine, the run and its result.

To see the dashboard with something on every page, start both Workers with a
seeded local D1 (Wingfoil's timetable, demo jobs, a FakeRuntime agent, a
failed, a lost and a waiting run, an offline machine and one whose VM
failed):

```sh
node scripts/dashboard-screenshots.mjs --serve   # prints the URL; Ctrl-C stops it and deletes the state
node scripts/dashboard-screenshots.mjs /tmp/hc-m4  # or: every page at 390×844 and 1440×900, as PNGs
```

Both need Playwright's Chromium for screenshots (`npx playwright-core install
chromium`); `--serve` does not.

## Tests

```sh
npm test --workspace @home-compute/cloud
```

The `test-node` files run with `--test-force-exit` and a five-minute
default timeout per test, so a server, agent or timer a failed test leaves
behind cannot hold the run open (a failed seed once kept CI waiting six
hours); CI also stops the whole job after 30 minutes.

- `test/*.test.mjs` run inside workerd with a local D1 that has the real
  migrations applied (`@cloudflare/vitest-plugin` 1.4 with Vitest 5, the
  successor to `@cloudflare/vitest-pool-workers`, per Cloudflare's docs on
  2026-10-11). They cover the schema, cron idempotency, coalescing, skip and
  catch-up, pauses, If-Match, Access tokens against a test JWKS, roles, CSRF,
  audit rows, the snapshot's shape and imports of the Wingfoil timetable;
  and for the agent API (`agent-api.test.mjs`, `machines.test.mjs`): join
  tokens and enrolment, credentials (401, revoked), body caps (413), the
  protocol check (426), compare-and-set claims with labels, preferences,
  caps, drain and health, lazy materialisation, progress and leases,
  completion (idempotent, published tracking, retries), lost runs and their
  retries, cancels and the timeout backstop, rotation, and the machine and
  run endpoints of hc-web.
- `test-node/agent-integration.test.mjs` runs hc-core in Miniflare (workerd)
  with a local D1 and drives it with real agents from `../agent` on
  FakeRuntime and one movable clock (§11 M2: the race for one run, preferred
  machines, capacity, a killed agent's lost run and its retry and recovered
  late result, the outbox, revocation, timeout, OOM, redaction, published
  tracking, lazy materialisation, cancels, rotation, the service loop). The
  Worker is bundled from `test-node/support/core-under-test.mjs`, a test-only
  entry that takes the time from an `x-hc-test-now` header; the deployed
  Worker never reads it.
- `test-node/docker-integration.test.mjs` (M3) drives hc-core with a real
  agent on a real Docker and the fixture image of `agent/test/fixture`: the
  secret it prints is stored `<redacted>`, with its report, metrics and
  digest. It is skipped without a test Docker (see the agent's README: on
  Linux the local socket; on a Mac only an explicit `HC_TEST_DOCKER_HOST`,
  e.g. through `agent/scripts/with-test-colima.sh`). CI requires it.
- `test-node/local-worker.test.mjs` runs hc-web under `wrangler dev` and drives
  it with `home-compute cloud import`, as above.
- `test/dashboard-api.test.mjs` covers what the dashboard added (M4): job
  parts (placement, resources, image) with their roles, audit and CSRF; a
  machine's day of runs and VM spans; agents behind the desired version; the
  snapshot's next slots, sparklines and lost runs.
- `test-node/dashboard-browser.test.mjs` (M4) runs the dashboard in Chromium
  (`playwright-core`) at 390×844 and 1440×900 against both Workers under
  `wrangler dev`, seeded by `test-node/support/dashboard-seed.mjs`: the
  overview's order (running now, the next runs soonest first, attention)
  and its empty states, a change made elsewhere appearing through
  `/v1/changes` (and no polling while hidden), Run now with arguments, a
  timetable edit that persists, drain and revoke, a join token shown once,
  the CSRF refusal, a viewer who sees no controls and is refused anyway, the
  log's errors-only filter, and DEV_ACCESS_EMAIL. It is skipped without
  Playwright's Chromium unless `HC_REQUIRE_BROWSER_TESTS=1` (CI sets it and
  installs Chromium).
- `test-node/cpu.test.mjs` estimates CPU per request on the hot paths.

## API

All under `/v1`, each needing an Access identity with a role (`viewer` <
`operator` < `admin`). Changes need JSON; a browser also needs its own
`Origin`, `Sec-Fetch-Site: same-origin` when sent, and `X-HC-CSRF` (or the
dashboard's `X-CSRF-Token`) from `GET /v1/session`.

| Request | Role | Notes |
| --- | --- | --- |
| `GET /v1/session` | any | Login, role, CSRF token. |
| `GET /v1/snapshot` | viewer | The local controller's shape; `nodes` aliases `machines`. Also `activeRuns` (waiting ones say why), `recentRuns` (the latest 20 changes), and per job `lastReports`, `blocked` and `waiting`. |
| `GET /v1/changes?since=` | viewer | 204 while nothing changed. |
| `GET /v1/jobs/:id` | viewer | Definition, `paused`, `revision` (also the ETag). |
| `PUT /v1/jobs/:id` | admin | Create (no If-Match) or replace (`If-Match: <revision>`; 428 without, 412 when stale). |
| `PATCH /v1/jobs/:id/timetable` | operator | `{enabled?, hours?: [..] \| "every", minutes?}`. `POST` works too, as today's clients send it. |
| `PATCH /v1/jobs/:id/placement` \| `/resources` | operator | `{requireLabels?, preferMachines?, preferWaitSeconds?}` (null removes a field) \| `{cpus?, memoryMiB?, diskMiB?}`. Checked by the job's own rules, audited, a new revision; If-Match honoured when sent. |
| `PATCH /v1/jobs/:id/image` | admin | `{image}`: what runs is an admin's choice (the dashboard's "pin to the digest that last ran"). |
| `POST /v1/jobs/:id/run` \| `/pause` \| `/resume` | operator | Run now: `{extraParameters?, force?}`. |
| `GET /v1/jobs/:id/runs?before=&limit=&skipped=0` | viewer | Newest first, skipped slots included unless `skipped=0`. |
| `GET /v1/runs/:id`, `/v1/runs/:id/logs` | viewer | The log is the agent's redacted tail: up to 200 lines while running, 500 at the end. |
| `POST /v1/runs/:id/cancel` | operator | A waiting or active run; its agent stops it on its next sync. |
| `POST /v1/runs/:id/retry` | operator | A finished or lost run again: `attempt + 1`, `retry_of`. `{force?}` as Run now. |
| `GET /v1/containers` | viewer | Container-seconds and the list-price upper bound for the Cloudflare executor over 30 days, including runs still going. Empty until a job targets it. |
| `GET /v1/machines?all=1`, `/v1/machines/:id` | viewer | Status (online, offline, draining, unhealthy, revoked), VM (with `vmSince` and the last day's `vmHistory` spans), free capacity, caps, labels, agent (`updateAvailable` when older than the desired version), clock skew, current runs. `all` adds revoked ones. The `cloudflare` machine is the Containers executor: no VM, drain only. |
| `GET /v1/machines/:id/runs?since=` | viewer | What it ran from `since` (default 24 hours ago), newest first. |
| `PATCH /v1/machines/:id` | operator / admin | `{drain}` for an operator; `{name, labels, capacity, capabilities, rotateCredential: true}` need an admin. |
| `DELETE /v1/machines/:id` | admin | Revokes it: its next request gets 401. |
| `POST /v1/join-tokens` | admin | `{name?, labels?, capabilities?, ttlMinutes?}` → `{token, expiresAt, server, enrolCommand}`, shown once. |
| `POST /v1/pause-all` \| `/v1/resume-all` | operator | The global pause. |
| `GET` \| `PATCH /v1/settings` | admin | `globalPause`, `retention`, `roles`, `desiredAgentVersion` (null: the newest any enrolled machine runs). |
| `POST /v1/import?dryRun=1` | admin | `{config: {jobs}, preset, variables, force?, pause?}` → per-job diff. |
| `GET /v1/audit?before=&limit=` | admin | Every mutation with before/after. |
| `GET /v1/secrets` | admin | The vault: names, key ids, hints, allowed labels, the jobs using each, and names jobs need that are not set. Never a value. |
| `PUT` \| `DELETE /v1/secrets/:name` | admin | `{value, allowedLabels?}`, sealed in the Worker with `VAULT_PUBLIC_KEY`; the answer has the name, key id and hint only. |
| `GET /v1/alerts` | viewer | Open alerts, the last week's resolved ones, the cron's last tick, email delivery. |
| `POST /v1/alerts/test` | admin | A test alert the next cron minute emails, then resolves. |

Roles come from the `roles` setting (`{"me@example.com": "admin",
"service:<client-id>": "operator"}`) plus the `BOOTSTRAP_ADMINS` var.

### Agent API (hc-core)

Agents authenticate with `Authorization: Bearer hca_<machineId>_<secret>`;
hc-core keeps its SHA-256 only. Every body carries `protocol` (an older
one gets 426) and is refused past its size before it is parsed (413).
Answers are `Cache-Control: no-store`.

| Request | Body limit | What it does |
| --- | --- | --- |
| `POST /agent/v1/enrol` | 16 KB | `{protocol, joinToken, name?, facts}` → 201 `{machineId, credential, name, labels, capabilities}`. The token is single use and expires (60 minutes by default); its name, labels and capabilities win over the agent's. 401 `invalid_join_token` / `join_token_used` / `join_token_expired`, 409 for a name in use. |
| `POST /agent/v1/sync` | 128 KB | §4.2: heartbeat, run progress and claim in one. Answers `{serverTime, nextSyncInMs, claims, cancel, upcoming, config, update: null, provisioningTasks: [], rotateCredential}`. An `upcoming` slot another machine is preferred for says `preferredElsewhere: true` (the agent does not pre-warm its VM for it). |
| `POST /agent/v1/runs/:id/complete` | 256 KB | The final record. Idempotent; a lost run's late record settles it with `recovered`. |
| `POST /agent/v1/provisioning/:id/events` | | 501 until M6. |
| `GET /health`, `GET /health/cron` | | Liveness (200), and the cron's heartbeat: 503 once it is 5 minutes old (the dead-man check). |

A 401 says `{"code": "revoked"}` for a revoked machine and
`{"code": "unauthorized"}` otherwise.

## Deploying

Deployed on 2026-10-12 in shadow mode. The runbook (first deployment,
changes, Access, secrets, alerts, the Mac mini's agent and the per-job
cut-over) is [docs/deploy.md](../docs/deploy.md). In short: migrations
first (`npx wrangler d1 migrations apply home-compute --remote -c
wrangler.web.jsonc`), then `npx wrangler deploy -c wrangler.core.jsonc` and
`-c wrangler.web.jsonc`. Owner-specific values (the bootstrap admin, hc-core's
URL, the vault keys, the alert addresses, and hc-web's Access team and
audience) are Worker secrets, never in these files. Until Access is set up,
`scripts/local-admin.sh` runs hc-web locally
against the deployed database as an admin.

## Notes on the implementation

- **Migrations.** `0001_init.sql` is the design's §2 schema verbatim. SQLite (and
  D1) support the partial unique indexes it relies on. `0002` adds
  `runs_by_updated` so `GET /v1/changes` reads one row rather than scanning
  `runs`.
- **New jobs wait for their next slot.** Creating or importing a job counts its
  latest past slot as done, and moving a slot earlier does not fire the one just
  passed, so an import never starts every job at once (Run now does that). A
  never-run interval job is due one interval after creation.
- **Missed slots.** After downtime only the newest slot is recorded (and runs,
  under `catchUp: latest`); intermediate slots are not written as skipped rows.
- **Disabled vs paused.** A disabled job (configuration) records nothing; a
  paused job, or every job under the global pause, records its slots as
  `skipped(paused-at-slot)`, as §9's shadow mode needs. Both keep their place.
- **Few queries.** Bulk writes take one JSON parameter expanded with
  `json_each`, so a 21-job import is five statements (D1 allows 50 queries per
  invocation on Free). The snapshot is one batch of five indexed reads; D1
  refuses large `UNION ALL`s, so recent runs use a correlated `IN (… LIMIT 5)`.
- **Atomic audit.** A conditional change and its audit row run in one batch,
  the audit row guarded by `changes() = 1`, so a lost If-Match race writes
  nothing.
- **CSRF for service tokens.** A service token is a header credential that
  browsers never attach, so (like the local controller's bearer token) it needs
  JSON and, if sent, a same-origin `Origin`, but no CSRF token: its JWT is
  issued per request, so an `iat`-based token could not be echoed.
- **Import variables.** The Wingfoil preset also has `variables`
  (`WINGFOIL_IMAGE` defaults to the `:production` tag); `--image` overrides
  them. Resolving the tag to a digest is left to M5. Optional env names the
  preset does not set (`S3_PREFIX`, `FORCE5_BROTLI_QUALITY`) are not passed and
  the diff says so; a required name the preset does not cover becomes
  `local:<NAME>`, resolved from the agent's own env file.
- **Secrets.** Imports record `vault:<name>` references only; the vault is M5.
  Until then hc-core claims no run whose job names a `vault:` secret (the
  snapshot shows the job as `blocked` and its waiting run says why), so
  nothing ever starts without a secret it needs. `local:` references go to
  the agent by name (`localEnv: [{name, from}]`), which reads them from its
  own env file.

### The agent API (M2)

- **Round trips per sync.** Authentication (the machine row), one batch of
  reads (settings, the machine's runs and those it reports, schedule state
  for `upcoming`, up to 20 due runs, the machines for preference checks), the
  job set from isolate memory (re-read only when `jobs_version` moves), and
  one batch of writes holding progress, log tails, the machine's row and the
  claims. An idle sync writes nothing but, once a minute, `last_seen_at`.
- **Lazy materialisation.** A sync that asks for work runs
  `materialiseAll(db, now, {jobIds})` for jobs whose `next_due_at` has
  passed, then claims what it created. The cron has to have run once for a
  job's `next_due_at` to be known.
- **Claims.** Compare-and-set (`WHERE state = 'due'` and no active run of the
  job), all in the sync's one write batch; the batch's results say which
  were won. Scheduled and retry runs of a paused or disabled job, or under
  the global pause, are not claimed; manual runs are (shadow mode's test run
  needs that). A claimed run its agent does not report in its next sync (the
  answer was lost) is sent again, and counts against the machine's free
  capacity. If none of the 20 oldest due runs is for this machine, a second
  read looks only among jobs it could take, so blocked or mislabelled runs
  cannot starve it. What an agent reports about itself (free capacity,
  health) is clamped rather than refused: a refused sync renews no lease.
- **Leases and last seen.** A lease is renewed once it is 30 s old rather
  than on every sync, and `last_seen_at` is written at most once a minute, so
  a machine counts as offline after 150 s without a recorded sync (the
  design's 90 s plus that lag). An idle machine writes about 1,440 rows a day.
- **Credential rotation.** `PATCH /v1/machines/:id {rotateCredential: true}`
  or a credential older than 90 days makes the next sync answer with a new
  one (`credential_next_hash`); the first request that presents it promotes
  it, and the old one stops working. Migration `0003` adds
  `credential_issued_at` and `rotate_requested_at` to `machines`.
- **Completion.** `transition()` settles the run (`failed: true` marks one
  that failed before it had an exit code: a refused image, a failed pull).
  Reports are redacted again (patterns), bounded and turned into metrics;
  `schedule_state` gets the last run, its outcome, `published` per `trackBy`
  (`trackPublished`) and, for an interval job, its next slot. `retry.onFailed`
  makes a retry `backoffSeconds` later. Everything after the run's own update
  is guarded on it, so a lost race (the cron marking it lost meanwhile)
  writes nothing and is settled again as what it became. A late, recovered
  result never replaces a newer finished run as the job's last (nor its
  `published`), and cancels its own retry if that has not started yet.
- **Cloudflare Containers.** After the same lease, retry and timeout steps, the cron starts runs whose placement requires `runtime=cloudflare-container`. No such job means one read and no machine row. The run is a Durable Object (`HcContainerBasic`) that outlives the cron; completion goes through the same `complete()` path, keeping the instance type in `metrics_json` and adding `containerSeconds`. Agents never claim these runs. See [docs/cloudflare-containers.md](../docs/cloudflare-containers.md).
- **Lost runs.** The cron marks expired leases `lost` and retries per §3.4:
  at once if the run never started, after `lostGraceSeconds` if it was
  running and the job says `onLostRunning`, at most `maxAttempts` attempts,
  and never when a newer run of the job exists (under coalescing it does the
  work). `updated_at` at expiry is when it was lost.
- **Cancels.** A run the dashboard cancelled, or the cron timed out, is in
  the `cancel` list of its machine's next sync; the agent's completion then
  only adds its final log.

### The dashboard (M4)

The dashboard in `../dashboard` is hc-web's static assets: plain ES modules,
no build step, nothing from another origin (the CSP allows only `'self'`).
`lib.js` holds what can be tested without a browser; `app.js` boots it, and
there is a module per page. See [docs/dashboard.md](../docs/dashboard.md)
for what each page shows.

- **Sign-in.** Access signs people in; the page asks `GET /v1/session` for
  the login, role and CSRF token, and sends the token (`X-HC-CSRF`) with
  every change. A viewer sees no controls (the API refuses anyway); a login
  Access let in but with no role is told so. Under `wrangler dev`,
  `DEV_ACCESS_EMAIL` stands in on loopback hosts only.
- **Live updates.** While visible, `GET /v1/changes?since=` every 10 s (204
  while nothing moved); a moved cursor reloads the snapshot and the open
  page's data (its job, history, run and log, machine timeline). Hidden, it
  stops; visible again, it asks at once. An idle dashboard costs one request
  and three indexed reads per 10 s.
- **Snapshot additions** (fields only added, so the menu bar app and Studio
  module are unaffected): per job `placement` and `durations` (the last 20
  finished runs, read with a narrow query of their own; `recentRuns` keeps
  its 5); `upcoming` (the next six slots across jobs, each with the machine
  expected to take it or why none can), `lostRuns` (the last day's),
  `desiredAgentVersion`, and per machine `vmSince`, `vmHistory` and
  `updateAvailable`. The snapshot is now one batch of nine indexed reads.
- **VM uptime.** hc-core stamps `vmSince` when a sync reports a new VM state
  and keeps the running spans of the last 24 hours (at most 48) in the
  machine's facts. A change of state already writes the row, so this adds
  no writes; the times are the server's receipt times (within a sync).
- **Offline.** `sw.js` caches the dashboard's own files, network first, so
  the shell opens offline and a release never mixes old and new modules. It
  never caches `/v1/*` or Access's `/cdn-cgi/*`, nor any redirect.
- **Migration `0004`** indexes runs by `(machine_id, claimed_at)` for a
  machine's day of runs; without it that read scans every run the machine
  ever held.

### Measured cost (2026-10-11)

| | |
| --- | --- |
| Bundles (`npm run build`) | hc-web 102.4 KiB (27.1 KiB gzip), hc-core 79.8 KiB (21.8 KiB gzip) |
| CPU, warm, Node (`test-node/cpu.test.mjs`) | import plan for 21 jobs 0.15 ms; cron decisions for 21 jobs 0.05 ms; snapshot run mapping (105 runs) 0.8 ms; Access JWT check 0.04 ms; a busy sync's parsing and redaction (two 32 KB tails) 0.39 ms; a claim decision (20 due runs, 21 jobs) 0.01 ms; a large completion (64 KB tail, 120 reports) 0.92 ms; a credential hash 0.02 ms |
| Wall time in local workerd, D1 included | first request of an isolate (import dry run) 7–8 ms; warm import 2–3 ms; snapshot 1–2 ms; cron minute 1–2 ms; agent sync p50 2.5 ms, p95 5.5 ms; complete p50 2.5 ms, p95 5.4 ms; enrol p50 8 ms (`agent-integration.test.mjs` prints these) |

Production CPU is still to be confirmed with `wrangler tail` once deployed (risk 2 in §12).

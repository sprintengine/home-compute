# Hosted control plane (Cloudflare Workers)

This workspace is the control plane of
[docs/hosted-control-plane.md](../docs/hosted-control-plane.md), milestones M0
and M1: two Workers from one codebase and one D1 database.

| Worker | Config | What it does |
| --- | --- | --- |
| `hc-web` | `wrangler.web.jsonc` | The dashboard (static assets from `../dashboard`) and the `/v1` human API, behind Cloudflare Access. |
| `hc-core` | `wrangler.core.jsonc` | The `* * * * *` cron: creates due runs, marks expired leases `lost`, times out unfinished runs, applies retention hourly. The agent API (`/agent/v1/*`) answers 501 until M2. |

Both import the pure modules in `../src/core`, which the local controller and
(from M2) the agent share. Nothing here is deployed yet: the steps at the end
are for later.

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

## Tests

```sh
npm test --workspace @home-compute/cloud
```

- `test/*.test.mjs` run inside workerd with a local D1 that has the real
  migrations applied (`@cloudflare/vitest-plugin` 1.4 with Vitest 5, the
  successor to `@cloudflare/vitest-pool-workers`, per Cloudflare's docs on
  2026-10-11). They cover the schema, cron idempotency, coalescing, skip and
  catch-up, pauses, If-Match, Access tokens against a test JWKS, roles, CSRF,
  audit rows, the snapshot's shape and imports of the Wingfoil timetable.
- `test-node/local-worker.test.mjs` runs hc-web under `wrangler dev` and drives
  it with `home-compute cloud import`, as above.
- `test-node/cpu.test.mjs` estimates CPU per request on the hot paths.

## API (M1)

All under `/v1`, each needing an Access identity with a role (`viewer` <
`operator` < `admin`). Changes need JSON; a browser also needs its own
`Origin`, `Sec-Fetch-Site: same-origin` when sent, and `X-HC-CSRF` (or the
dashboard's `X-CSRF-Token`) from `GET /v1/session`.

| Request | Role | Notes |
| --- | --- | --- |
| `GET /v1/session` | any | Login, role, CSRF token. |
| `GET /v1/snapshot` | viewer | The local controller's shape; `nodes` aliases `machines`. |
| `GET /v1/changes?since=` | viewer | 204 while nothing changed. |
| `GET /v1/jobs/:id` | viewer | Definition, `paused`, `revision` (also the ETag). |
| `PUT /v1/jobs/:id` | admin | Create (no If-Match) or replace (`If-Match: <revision>`; 428 without, 412 when stale). |
| `PATCH /v1/jobs/:id/timetable` | operator | `{enabled?, hours?: [..] \| "every", minutes?}`. `POST` works too, as today's clients send it. |
| `POST /v1/jobs/:id/run` \| `/pause` \| `/resume` | operator | Run now: `{extraParameters?, force?}`. |
| `GET /v1/jobs/:id/runs?before=&limit=` | viewer | Newest first, skipped slots included. |
| `GET /v1/runs/:id`, `/v1/runs/:id/logs` | viewer | Logs are empty until agents report (M2). |
| `POST /v1/pause-all` \| `/v1/resume-all` | operator | The global pause. |
| `GET` \| `PATCH /v1/settings` | admin | `globalPause`, `retention`, `roles`. |
| `POST /v1/import?dryRun=1` | admin | `{config: {jobs}, preset, variables, force?, pause?}` → per-job diff. |
| `GET /v1/audit?before=&limit=` | admin | Every mutation with before/after. |

Roles come from the `roles` setting (`{"me@example.com": "admin",
"service:<client-id>": "operator"}`) plus the `BOOTSTRAP_ADMINS` var.

## Deploying (later; not done yet)

1. **Database.** `npx wrangler d1 create home-compute --location weur`, then put
   the printed `database_id` in both `wrangler.*.jsonc` files.
2. **Schema.** `npx wrangler d1 migrations apply home-compute --remote -c wrangler.web.jsonc`.
3. **hc-core.** `npx wrangler deploy -c wrangler.core.jsonc`. Deploy the cron
   once and leave it: trigger changes take up to 15 minutes to propagate.
   For shadow mode (§9 phase 0), set the global pause before importing.
4. **hc-web.** `npx wrangler secret put CSRF_KEY -c wrangler.web.jsonc` (32+
   random bytes), then `npx wrangler deploy -c wrangler.web.jsonc`.
5. **Access.** On `workers.dev`, enable Cloudflare Access on `hc-web` (Workers ›
   hc-web › Settings › Domains & Routes); on a custom domain, add a self-hosted
   Access application. Allow the owner's email (Google, GitHub or one-time PIN).
   Copy the application's **AUD tag** and the team domain
   (`<team>.cloudflareaccess.com`) into `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN`,
   set `BOOTSTRAP_ADMINS` to the owner's email, and deploy hc-web again. Never
   put Access in front of `hc-core`: agents authenticate themselves (M2).
6. **Service tokens.** Create one per client (CLI, menu bar app) under Access ›
   Service Auth, add each to the application's policy with a *Service Auth*
   rule, and give it a role: `PATCH /v1/settings {"roles": {"service:<client-id>": "admin"}}`.
7. **Import.** `HC_URL=https://hc-web.<account>.workers.dev HC_ACCESS_CLIENT_ID=…
   HC_ACCESS_CLIENT_SECRET=… home-compute cloud import <file> --preset wingfoil
   --image ghcr.io/sprintengine/wingfoil-forecast@sha256:… --dry-run`, then again
   without `--dry-run`. Add `--paused` to import every job paused.

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

### Measured cost (2026-10-11)

| | |
| --- | --- |
| Bundles (`npm run build`) | hc-web 76.9 KiB (21.1 KiB gzip), hc-core 15.7 KiB (5.3 KiB gzip) |
| CPU, warm, Node (`test-node/cpu.test.mjs`) | import plan for 21 jobs 0.13 ms; cron decisions for 21 jobs 0.05 ms; snapshot run mapping (105 runs) 0.8 ms; Access JWT check 0.03 ms |
| Wall time in local workerd, D1 included | first request of an isolate (import dry run) 7–8 ms; warm import 2–3 ms; snapshot 1–2 ms; cron minute 1–2 ms |

Production CPU is still to be confirmed with `wrangler tail` once deployed (risk 2 in §12).

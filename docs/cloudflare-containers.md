# Cloudflare Containers executor

Scheduled jobs can run as [Cloudflare Containers](https://developers.cloudflare.com/containers/)
instead of on a machine that stays enrolled. hc-core stays the scheduler: the
same timetable, retries, alerts, dashboard, logs and Run now. Only where a run
happens changes. The machine path is unchanged, and this executor is off until
a job asks for it. The first deploy starts nothing: the image in
`cloud/wrangler.core.jsonc` is a placeholder.

## How a run goes

1. The minute cron creates the job's due run, as for any job.
2. A job whose placement is `requireLabels.runtime = cloudflare-container` is
   never given to an agent. hc-core claims it itself (compare-and-set on
   `due`, one active run per job, the concurrency guard below), picks the
   instance size, opens its vault secrets, and starts one container for it.
   The cron does not wait for the run.
3. Each run is a Durable Object (`cloud/src/container-do.mjs`) with one
   container. The container runs the job under a small `sh` wrapper that
   copies its output to `/tmp/hc/log` (and on to Workers Logs) and its exit
   code to `/tmp/hc/exit`, then holds for five minutes so hc-core can read
   them.
4. The object checks the container on every cron minute and every alarm, and
   at once when the job exits. A check renews the run's lease, stores the
   last 200 lines for the dashboard's live log, and records peak memory.
5. When the job exits, or its `runSeconds` deadline passes, the object reads
   the final 500 lines and the job's JSON-line reports, settles the run
   through the same `complete()` an agent's result goes through (exit code,
   OOM, timeout, outcome, error, `published`, retries), and destroys the
   container.

**Run now, Cancel and Retry** on the dashboard start or stop a Cloudflare
run within seconds: hc-web asks hc-core's `Dispatcher` entrypoint (a service
binding, not a public route) to dispatch at once rather than at the next
cron minute.

**When something goes wrong:**
- The lease is renewed only by the object, and only when the container
  answers. A container that dies or a Durable Object that stops checking
  lets the lease run out after three minutes, and the run is `lost`, then
  retried by the job's policy. This is the same as a machine that goes quiet.
- A container that stops before its result was read fails the run with
  that said.
- The cron's timeout backstop (`runSeconds` plus 5 minutes) still applies.
- A start that fails because no instance is free yet (say, a cancelled
  container still going) puts the run back to `due` for the next minute.
  The run does not fail.

## Sizes

Below one vCPU, Cloudflare offers only fixed sizes: `lite` (1/16 vCPU,
256 MiB, 2 GB) and `basic` (1/4 vCPU, 1 GiB, 4 GB). A custom size starts at
1 vCPU and 3 GiB. Each size is a container class of its own in
`wrangler.core.jsonc`, all with the same image.

A run goes to the **smallest deployed size that holds the job's memory and
disk**. CPU does not choose the size: the small sizes share a core, and
Cloudflare bills only the CPU a run uses, so a network-bound job asking for
"1 CPU" runs on `basic`. `resources.instanceType` can name a size instead.
If nothing deployed fits, the run fails with the reason; it is never moved
to a bigger, dearer size.

Only `basic` is deployed. Wingfoil's live jobs peak at 130–360 MB, so they
all fit. To add a size, copy the `containers` entry and its Durable Object
binding in `wrangler.core.jsonc` (for example `HcContainerLite`,
`HC_CONTAINER_LITE`, `"instance_type": "lite"`), add the class to a new
migration tag, and deploy hc-core.

## The image

Cloudflare cannot pull from ghcr.io, and it runs linux/amd64 only. The image
is pushed into Cloudflare's registry and named in `wrangler.core.jsonc`, so
**a new image means deploying hc-core**:

```sh
cd cloud
npx wrangler login
brew install crane                      # or have Docker running instead
gh auth token | crane auth login ghcr.io -u <github user> --password-stdin   # token with read:packages
./scripts/set-container-image.sh ghcr.io/sprintengine/wingfoil-forecast:production --deploy
```

The script copies the image's linux/amd64 platform into Cloudflare's
registry (with `crane`, no Docker needed), writes the copy's digest into
every container class's `image` and into `vars.HC_CONTAINER_IMAGE`, writes the
source's multi-platform digest into `vars.HC_CONTAINER_SOURCE`, then deploys.
Running containers keep their image until their run ends.

A job's `image` decides whether it may run on the deployed image:
- **A tag** (`ghcr.io/sprintengine/wingfoil-forecast:production`) runs
  whichever version of that repository was last deployed. The same job
  definition works on a machine and on Cloudflare.
- **A pinned digest** must be the deployed digest, or the source digest it
  was copied from (a job pinned to `ghcr.io/…@sha256:<multi-platform digest>`
  runs on its amd64 copy).
- **Any other repository** fails the run with both names.

The run's `image_digest` records what actually ran.

## Writing a job for it

- **Placement:** `{"requireLabels": {"runtime": "cloudflare-container"}}`.
  That label replaces the others. The executor's labels are `arch=amd64`,
  `os=linux`, `site=cloudflare`, so a job that also requires `arch=arm64`
  matches nothing.
- **Entrypoint:** the job must name an `entrypoint` (plus `args`). The
  wrapper runs it, and it cannot wrap the image's own default entrypoint.
- **What the image needs:** `sh`, `tee`, `mkdir`, `mv` and `sleep`, as any
  Debian, Alpine or Python image has. A distroless image does not.
- **Secrets:** `vault:` secrets only. `local:` lives on one machine. A
  secret whose `allowedLabels` do not match the executor (say `site=home`)
  leaves the run `due`. Give the executor extra labels in settings, say
  `{"cloudflare": {"labels": {"pool": "wingfoil"}}}`, for secrets allowed to a
  pool. Its own `arch`, `os`, `runtime` and `site` cannot be changed.
- **Storage:** no R2 binding inside the container. Pass the bucket's S3 keys
  as vault secrets, as on a machine.
- **Limits:** `timeouts.runSeconds` no more than `settings.cloudflare.maxRunSeconds`
  (default and hard cap 1200, 20 minutes).

```json
{
  "image": "ghcr.io/sprintengine/wingfoil-forecast:production",
  "entrypoint": ["python", "/app/force5/ingest/worker.py"],
  "args": ["--models", "tides"],
  "placement": { "requireLabels": { "runtime": "cloudflare-container" } },
  "resources": { "cpus": 1, "memoryMiB": 512, "diskMiB": 2048 },
  "timeouts": { "runSeconds": 900 }
}
```

## Turning it on (owner)

Nothing here is done by deploying this branch.

1. The account needs **Workers Paid** ($5 a month). Containers are not on
   the Free plan, and deploying this config on Free fails.
2. From `cloud/`, `npx wrangler login` as the account owner. Docker is
   needed for the image push.
3. Put the image on Cloudflare and deploy hc-core
   (`./scripts/set-container-image.sh <image> --deploy`, above). Then deploy
   hc-web too (`npx wrangler deploy -c wrangler.web.jsonc`), which picks up
   the service binding Run now uses.
4. Switch **one** cheap job: set its placement and entrypoint as above. Run it
   with Run now and watch the run's log on the dashboard.
5. The `cloudflare` machine page shows the deployed image, the sizes, runs,
   container-seconds and a cost upper bound for the last 30 days
   (`GET /v1/containers` gives the same). Drain it to stop new runs. Revoke
   it only to retire the executor: a revoked row is not recreated.

Guardrails are in settings `cloudflare`: `maxConcurrent` (default 1, range
1–20), `maxRunSeconds` (default 1200, hard cap 1200), and `labels` (extra
executor labels, above). `max_instances` in
`wrangler.core.jsonc` is the hard cap Cloudflare enforces (1). Raise both
together, and deploy hc-core.

## Cost

Workers Paid list prices (October 2026), on top of the $5 plan:

- **Memory:** $0.0000025 per GiB-second, provisioned for the whole run.
- **Disk:** $0.00000007 per GB-second, provisioned for the whole run.
- **CPU:** $0.000020 per vCPU-second, active use only.

The plan includes 25 GiB-hours of memory, 375 vCPU-minutes and 200 GB-hours
of disk a month, shared with every Worker on the account.

Wingfoil's measured run times are 5 seconds to 15 minutes, about 70
container-hours a month across every live job. On `basic` that is roughly
$0.40 of memory, $0.70 of CPU and pennies of disk beyond the allotment: about
**$6–7 a month** including the plan. `GET /v1/containers` prices CPU as if
all of it were active, so its figure is an upper bound.

## Not yet tried on Cloudflare itself

The tests cover the executor against a real local D1, and the wrapper and
probe are run in a real shell, but no run has gone through a real Cloudflare
container yet. The first trial job (step 4 above) is that check. The parts
only it can prove:
- that `exec` into a container works under the default scheduling policy;
- the start-up time;
- how much of Cloudflare's cgroup `memory.peak` is visible inside the
  container. Peak memory is best effort and never fails a run on its own.

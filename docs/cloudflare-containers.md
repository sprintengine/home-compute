# Cloudflare Containers executor

Scheduled jobs can run as [Cloudflare Containers](https://developers.cloudflare.com/containers/)
instead of on a machine that stays enrolled. The machine path is unchanged.
This executor is off until a job asks for it, and the first deploy starts
nothing: the image in `cloud/wrangler.core.jsonc` is a placeholder.

Use it for one cheap job first and read `GET /v1/containers` before moving
anything else.

## What the owner has to do

Containers are not on the Workers Free plan. The account needs Workers Paid
($5 per month, which also covers the Durable Objects and Workers this executor
uses). Nothing below is done by deploying this branch.

1. `npx wrangler login` as the account owner, from `cloud/`.
2. Push the job's image for `linux/amd64`. Containers do not pull ghcr.io, and
   they run amd64 only (a multi-arch image must be pulled for that platform):

   ```sh
   docker login ghcr.io
   ./scripts/push-container-image.sh ghcr.io/sprintengine/wingfoil-forecast@sha256:<digest>
   ```

   `wrangler containers images list` prints `registry.cloudflare.com/<account>/<repo>@sha256:…`.
3. Put that same digest in both places:
   - `containers[0].image` in `cloud/wrangler.core.jsonc` (replace the placeholder Dockerfile)
   - `npx wrangler secret put HC_CONTAINER_IMAGE -c wrangler.core.jsonc`
4. Apply D1 migrations if any are new (this executor adds none), then deploy
   hc-core and hc-web. Do not deploy from a cloud agent.

   ```sh
   npx wrangler d1 migrations apply home-compute --remote -c wrangler.web.jsonc
   npx wrangler deploy -c wrangler.core.jsonc
   npx wrangler deploy -c wrangler.web.jsonc
   ```

   The first deploy creates the container application and pulls the image.
   That pull is not part of a run's `runSeconds`.
5. Point one cheap job at the executor and size it for `basic`. Defaults
   (1 CPU, 2 GiB) do not fit and the run fails instead of moving to a larger
   size:

   ```json
   {
     "image": "registry.cloudflare.com/<account>/<repo>@sha256:<digest>",
     "placement": { "requireLabels": { "runtime": "cloudflare-container" } },
     "resources": { "instanceType": "basic", "cpus": 0.25, "memoryMiB": 1024, "diskMiB": 4096 },
     "timeouts": { "runSeconds": 600 }
   }
   ```

   `runtime=cloudflare-container` replaces other placement labels. The
   executor is `arch=amd64`, `os=linux`, `site=cloudflare`. A job that also
   requires `arch=arm64` matches nothing. Secrets with `allowedLabels`
   `site=home` are not delivered. `local:` secrets fail the run; use `vault:`.
   R2 is not mounted. Pass the bucket's S3 access key and secret as vault
   secrets, the same way a machine job does.
6. Drain the machine named `cloudflare` to stop new runs. Revoke it only to
   retire the executor; a revoked row is not recreated.
7. Read cost from `GET /v1/containers` and from that machine's page
   (container-seconds and the list-price upper bound, last 30 days).

`max_instances` in wrangler is 1. That is the hard cap. Raising
`settings.cloudflare.maxConcurrent` (1–20) does not allow more concurrent
containers until `max_instances` is raised to the same number and hc-core is
deployed again. `settings.cloudflare.maxRunSeconds` defaults to 1200 and
cannot exceed it. A job with a longer `timeouts.runSeconds` fails the run.

Only the `basic` class is deployed (`HC_CONTAINER_BASIC`). `lite` and
`standard-1` … `standard-4` have binding names, and a job that asks for one
fails until that class is added to wrangler. Adding one means another image
(default scheduling policy pins the image on the class) and another
`max_instances`.

## How a run is started

The minute cron on hc-core materialises slots, expires leases, retries lost
runs and applies the timeout backstop, then calls the executor. If no job has
`placement.requireLabels.runtime = cloudflare-container`, that is one indexed
read and it returns. The virtual machine `cloudflare`
(`m_cloudflarecontainer0000000`) is inserted only then. Its credential hash
is random; nothing can sign in as it. Agents skip these jobs even when their
own labels would match, so a machine never receives the vault secrets.

A due run is claimed like a machine claim (compare-and-set, one active run
per job). The cron then starts one Durable Object per run, class
`HcContainerBasic`, and returns. It does not wait for the process. The
Containers helper keeps that Durable Object resident with an alarm that
sleeps at most a few minutes and reschedules, which is what lets a run last
20 minutes. A cron invocation and a single alarm are both limited to about
15 minutes of wall time, so neither one sits and waits.

The object passes the job's env and opened vault secrets into the container
start. They are not written to D1 and not stored on the object. `network: none`
starts the container without internet; the default `bridge` allows it. The
image is already in Cloudflare's registry, so `registryAuth` is not sent.

Cloudflare accepts one `entrypoint` and no separate command. A job with no
entrypoint and no args uses the image default. Args, the entrypoint, and any
manual extra parameters are joined into that one field, so args replace the
image entrypoint when they are set.

Completion, timeout and loss use the same `runs` rows and the same retry
rules as a machine:

| What happened | Run state |
| --- | --- |
| Process exits 0 | `succeeded` |
| Non-zero exit | `failed`, and `policy.retry.onFailed` may add a due run (default: it does not; the next slot is the retry) |
| Exit 137, or cgroup `memory.peak` at the instance limit | `failed`, `oom_killed` |
| Past `started_at + runSeconds + 300s` | `timed-out` (the SIGKILL is not counted as an OOM) |
| Lease expired (180s; the cron renews it every minute, the object renews it on each alarm) | `lost`. A container that had started is retried only when `retry.onLostRunning` is set. Destroying it does not record a fake exit 137. A process that finishes on its own after the run was marked lost still settles as recovered. |
| Dashboard cancel | `cancelled`; the container is destroyed |

Missing vault secrets and secrets whose `allowedLabels` do not match the
executor leave the run `due`, as they do for machines. Concurrency above the
guard leaves the run `due`. Drain leaves it `due`. A revoked executor claims
nothing and is not recreated.

The dashboard shows these runs on the job and on the `cloudflare` machine.
Edit and Revoke are hidden there; Drain is the switch. Stdout is not copied
into the run log. It is in Workers Logs for hc-core (observability is on in
`wrangler.core.jsonc`). That has its own log cost.

## Instance types

| Type | vCPU | Memory | Disk | Deployed |
| --- | --- | --- | --- | --- |
| `lite` | 1/16 | 256 MiB | 2 GB | no |
| `basic` (default) | 1/4 | 1 GiB | 4 GB | yes, `max_instances` 1 |
| `standard-1` | 1/2 | 4 GiB | 8 GB | no |
| `standard-2` | 1 | 6 GiB | 12 GB | no |
| `standard-3` | 2 | 8 GiB | 16 GB | no |
| `standard-4` | 4 | 12 GiB | 20 GB | no |

`resources.instanceType` is optional. Omit it and a Cloudflare job uses
`basic`, but `cpus`, `memoryMiB` and `diskMiB` must still fit that type.
Disk "4 GB" is treated as 4096 MiB. Set the type from the job's Resources
form or `PATCH /v1/jobs/:id/resources` (`instanceType: null` clears it).

The durable-object scheduling policy can pick an image per start, but it does
not offer `basic` and the `Container` class does not implement it. This
executor uses the default policy so the cheap size exists. One class carries
one image. A second image needs a second class, or a later move to the
durable-object policy.

## Cost

Workers Paid list prices (5 October 2026), billed on top of the $5 plan, Durable
Objects, and Workers Logs. Included each month, shared with every other
Worker on the account: 25 GiB-hours memory, 375 vCPU-minutes, 200 GB-hours
disk. Egress is $0.025/GB in North America and Europe after 1 TB, and more
elsewhere. `GET /v1/containers` does not subtract the allotment and prices
vCPU as if the whole provisioned vCPU were active. Cloudflare bills active
CPU only, so the figure is an upper bound. Memory and disk are provisioned
for the whole run, including while the process waits on the network.

A 20 minute `basic` run, before the allotment, is about one cent at list
price: memory `1 GiB × 1200 × $0.0000025`, vCPU `0.25 × 1200 × $0.000020`,
disk `4 GB × 1200 × $0.00000007`. The Durable Object stays awake for the run
(duration billing, not just requests). See
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).
The minute cron is unchanged.

`containerSeconds` is `finished_at - started_at` for settled runs, plus elapsed
time for runs still going. The machine page shows the 30-day total.

## Limits that matter

- amd64 only. Pull `--platform linux/amd64` before `wrangler containers push`.
- No R2 binding inside the container. S3 API keys as secrets.
- No always-on machine, and no agent on this executor.
- The cron does not wait. A dead alarm is covered by `sleepAfter` of 35
  minutes (so a quiet batch job is not stopped at the helper's 10 minute
  default) and by the same timeout backstop as a machine. A run can outlive
  its deadline by about that gap if alarms stop firing.
- Cold start of a new instance is outside `runSeconds`. The image is pulled
  at deploy, not on the first run, when `containers[0].image` is set.
- OOM is a heuristic (exit 137 or `memory.peak` at the limit), from a
  best-effort cgroup read. Peak memory can be missing if that read fails.
- Account limits (6 TiB memory, 1500 vCPU, 30 TB disk, 50 GB of images) are
  far above one `basic` instance. `max_instances: 1` is the practical cap.
- Free plan: containers are not available. Deploying this config on Free fails.

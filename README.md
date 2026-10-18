# Home Compute

Home Compute turns trusted computers you already own into a pool for recurring
container jobs. It is a small open-source control layer over an unmodified
[Bacalhau](https://github.com/bacalhau-project/bacalhau) cluster, so it does not
reimplement distributed execution, machine health, placement, or worker retry.

A job is generic: a container image, arguments, selected environment variables,
resource requirements, and a schedule. Its container owns the actual work and
can read or write any service it has permission to use—S3-compatible storage,
MinIO, a database, an API, or a mounted filesystem. Home Compute does not proxy
bulk data through its controller.

Wingfoil forecast ingestion is patient zero, not a built-in integration. Its
existing image fetches, processes, and publishes weather files; Home Compute
only decides when and where that image runs.

This is an early vertical slice. The configuration and API are versioned but not
yet stable. See the [implementation plan](docs/implementation-plan.md) and the
[interactive HTML control-panel mockup](mockups/control-panel.html).

## What is reused

Home Compute owns:

- recurring schedules and operator pause/resume;
- prevention of overlapping logical runs;
- translation of a small job definition into a Bacalhau batch job;
- local state, a CLI, and an authenticated control API;
- an optional Sprint Engine Studio control surface.

Bacalhau remains a separate program and owns:

- worker registration and heartbeats;
- resource-aware placement;
- container execution;
- execution attempts and retry/rescheduling;
- job logs and detailed execution history.

No Bacalhau or Wingfoil source is copied into this repository. The Studio module
uses Sprint Engine's published module SDK contracts and host-provided UI kit.

## Requirements

- Node.js 22 or newer on the controller;
- a self-hosted Bacalhau orchestrator reachable by the controller;
- one or more Bacalhau compute nodes with Docker;
- a container registry visible to the workers for private workload images.

Tailscale is recommended but not required. Its Tailnet addresses can provide
ordinary private connectivity between the orchestrator and workers; Home
Compute does not depend on the Tailscale CLI or Sprint Engine's terminal relay.

For a one-machine development cluster, Bacalhau can run both roles:

```sh
bacalhau serve --orchestrator --compute
```

## Quick start

```sh
npm install
cp home-compute.example.json home-compute.json
cp .env.example .env
# Replace HOME_COMPUTE_API_TOKEN in .env.

npm run check
node src/cli.mjs validate
node src/cli.mjs render hello-batch
node src/cli.mjs doctor
node src/cli.mjs daemon
```

The example's `hello-batch` container is immediately due on first startup. The
daemon also listens on `http://127.0.0.1:4786` for the Studio module and other
operator clients.

Run a job manually; a workload can also accept additional image arguments after
`--`:

```sh
node src/cli.mjs run hello-batch
```

For a service installation, adapt the units in `examples/systemd`. The worker
example caps the fraction of its machine available to jobs. The `bacalhau`
operating-system user must be able to access Docker. Add TLS as well as private
networking and authentication before exposing either service beyond a trusted
network.

## Job configuration

The minimal shape is:

```json
{
  "jobs": [
    {
      "id": "make-thumbnails",
      "schedule": { "every": "6h" },
      "task": {
        "image": "ghcr.io/example/thumbnailer@sha256:...",
        "parameters": ["--all"],
        "requiredEnv": ["STORAGE_TOKEN"],
        "resources": { "cpu": "2", "memory": "4Gb", "disk": "10Gb" },
        "network": { "type": "Full" }
      }
    }
  ]
}
```

`requiredEnv` and `passEnv` contain names, never secret values. The values come
from the process environment or the ignored env file. `render` redacts them
unless explicitly invoked with `--show-secrets`.

## Control API

The daemon binds to loopback by default. Add `api.tokenEnv` to require a bearer
token read from the daemon's environment. The first API version provides:

- `GET /v1/health`
- `GET /v1/snapshot`
- `GET /v1/events` (server-sent events)
- `POST /v1/jobs/:id/run`
- `POST /v1/jobs/:id/pause`
- `POST /v1/jobs/:id/resume`

Pause is durable controller state and does not cancel an already-running
container. Manual runs are still allowed while a schedule is paused.

## Sprint Engine Studio module

The optional module in `studio-module` adds an instance-global fleet surface,
connection settings, live job state, worker cards, and run/pause/resume actions.
Its network requests leave through a main-process bridge rather than a browser
surface. Like other third-party Studio modules, it is trusted code rather than a
sandbox. Studio is only a client: closing it has no effect on scheduling.

```sh
npm run build:studio
```

The Sprint Engine SDK packer validates the resulting folder. Marketplace
distribution additionally requires an ed25519 signature from a key stored
outside this repository; the module is deliberately left unsigned in source.

## Wingfoil patient zero

Build the current Wingfoil worker image from the sibling repository, publish it
for both worker architectures, then pin its digest in the environment:

```sh
cd ../wingfoil
docker buildx build --platform linux/amd64,linux/arm64 \
  -f force5/Dockerfile \
  -t ghcr.io/YOUR_ACCOUNT/wingfoil-forecast:latest \
  --push .

cd ../self-hosted-web-services
cp examples/wingfoil/.env.example examples/wingfoil/.env
node src/cli.mjs validate --config examples/wingfoil/home-compute.json
node src/cli.mjs daemon --config examples/wingfoil/home-compute.json
```

HARMONIE and ECMWF are checked hourly and ICON-EU every six hours. Each importer
selects the newest complete forecast, and Wingfoil's publisher handles
idempotency. Those are workload behaviors; Home Compute just runs the image.

## Scheduling semantics

- A job is immediately due when it has never been submitted.
- Later runs are due from the previous completion, avoiding a slow job causing
  continuous back-to-back work.
- Only one Bacalhau job per logical definition is active at once.
- Failed submissions retry on the next controller poll.
- State is written atomically and a process lock prevents two daemons sharing it.
- If the controller is down, submitted work continues but no new scheduled jobs
  are submitted. State survives restart.

## Secret limitation

In this trusted-cluster slice, selected environment values become part of the
submitted Bacalhau job specification. Restrict each credential to the smallest
possible resource. A future secret-provider milestone will avoid putting
long-lived credentials in stored job specifications. Never add secret values to
the JSON configuration.

## Hosted control plane (in progress)

[docs/hosted-control-plane.md](docs/hosted-control-plane.md) designs the
replacement for Bacalhau and the local daemon: a control plane on Cloudflare's
free plan and a pull-based agent on each machine. Its first three milestones
are here: the pure scheduling, report and job code in `src/core` (which this
controller now uses too); the two Workers with their D1 schema in
[cloud/](cloud/README.md), including `home-compute cloud import` for moving a
job file across and the agent API; and the agent in [agent/](agent/README.md),
which so far runs only scripted (fake) containers. Nothing changes for the
controller described above until the agent drives Docker and Colima (M3).

Each worker shows itself locally: the agent serves a status API on 127.0.0.1
only, behind a token only its user can read (see
[agent/README.md](agent/README.md#local-status-api)), with `home-compute-agent
status`, `history` and `watch` for a terminal. The Mac's menu bar app
([macos/](macos/README.md)) has an agent mode over it, and
[tray/](tray/README.md) is the same menu as a tray app for Windows and Linux.

## Licence

Home Compute is licensed under Apache License 2.0. Bacalhau is not copied or
vendored and retains its own licence, notices, name, and trademarks. Sprint
Engine's module SDK is used through its published contract and retains its MIT
licence.

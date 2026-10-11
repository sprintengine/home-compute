# Implementation plan

> Successor design: [hosted control plane and pull-based agent](hosted-control-plane.md) replaces the Bacalhau architecture described here.

Home Compute is a generic, self-hosted control layer for recurring container
jobs. Bacalhau supplies the distributed systems substrate; Home Compute supplies
the smaller operator experience that a home or small-team fleet needs.

## Architecture

```text
                    optional operator clients
             CLI ----------+-------- Studio module
                           | HTTP JSON API
                           v
                Home Compute controller
                 schedules + local state
                           | submits batch specs
                           v
                 Bacalhau orchestrator
                   placement + retries
                    /       |       \
              worker A  worker B  worker C
                    \       |       /
                     container images
                           |
                    workload-owned I/O
             (S3, MinIO, filesystem, APIs, etc.)
```

The controller never carries workload logic or bulk job data. A job is a
container image, its arguments and environment-variable names, a resource
request, and a schedule. Wingfoil is one such image, not a built-in job type.

## Milestones

### 1. Generic vertical slice — implemented

- Validate declarative JSON job definitions.
- Translate definitions into unmodified Bacalhau batch job specifications.
- Schedule fixed intervals from the previous completion time.
- Prevent overlapping runs and atomically persist controller state.
- Support manual runs, diagnostics, status, and system service examples.
- Keep environment values outside versioned configuration.

### 2. Control API and Studio surface — implemented

- Bind an HTTP API to loopback by default, with optional bearer authentication.
- Expose health, fleet snapshots, manual run, pause, resume, and server events.
- Serialize API actions with scheduler reconciliation.
- Ship a Sprint Engine Studio capability module using the public SDK contracts.
- Keep Studio optional: scheduling survives closing or uninstalling it.
- Provide a standalone HTML product mockup.

### 3. Patient-zero deployment — next

- Publish Wingfoil's multi-architecture image at an immutable digest.
- Start a Bacalhau orchestrator and at least two approved compute workers.
- Run the three Wingfoil definitions from `examples/wingfoil` against a test
  bucket, then verify idempotency and worker failover.
- Capture real Bacalhau node responses and enrich the UI's resource display.

### 4. Operational hardening

- Add job history and log links without duplicating Bacalhau's history store.
  Done: a bounded per-job run history, log tails and a dashboard served over
  `tailscale serve` ([dashboard.md](dashboard.md)).
- Add exponential backoff and an explicit retry policy to logical jobs.
- Move long-lived workload secrets to a secret provider or publication step.
- Add HTTPS guidance and scoped API tokens before exposing the controller beyond
  loopback or a trusted private network.
- Add configuration reload and a schema/version migration policy. Jobs now
  reload in place (`POST /v1/reload`, SIGHUP); other sections still need a restart.

### 5. Community release and marketplace

- Exercise Linux and macOS install paths in CI.
- Publish release archives and checksums from tagged commits.
- Choose a stable publisher identity and keep its ed25519 private key outside
  this repository.
- Sign and verify the Studio module with the Sprint Engine module SDK.
- Submit the signed artifact and metadata to the Sprint Engine marketplace.

## Deliberate non-goals

- Reimplementing worker discovery, placement, heartbeats, retries, or execution.
- Streaming source or result files through the Home Compute controller.
- Requiring Sprint Engine Studio for unattended operation.
- Encoding Wingfoil, S3, or any other workload/storage provider into the core.

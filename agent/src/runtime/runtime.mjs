// The container runtime the agent drives (§4.3 of
// docs/hosted-control-plane.md). M2 ships FakeRuntime; DockerCliRuntime and
// ColimaRuntime (M3) implement the same interface:
//
//   interface ContainerRuntime {
//     ensureReady({ cpus, memoryMiB }) -> { bootMs }       // Colima: start/resize; Docker: ping
//     idle() / stop()                                      // Colima: stop VM; Docker: no-op
//     hasImage(digestRef) ; pull(ref, { auth }) -> { digest, ms }
//     run(spec) -> handle
//     adopt() -> handle[]                                  // containers labelled dev.homecompute.run
//     facts() -> { kind, version, cpus, memoryMiB, diskFreeMiB, vm? }
//   }
//
//   handle {
//     id, runId, jobId,                                    // runId/jobId from the container's labels
//     logs: AsyncIterable<line>,                           // stdout+stderr from the start, then live
//     stats() -> { memoryBytes, memoryLimitBytes?, cpuPct, cpuSeconds? },
//     wait() -> { exitCode, oomKilled },                   // inspect after exit
//     stop(graceS),                                        // SIGTERM, then SIGKILL after graceS
//     remove(),                                            // docker rm, once the result is safe
//   }
//
// Two additions to §4.3, both optional for callers: `facts().vm` (`{state,
// cpus, memoryMiB}`) tells the agent whether a run will wait for a VM, and
// `handle.remove()` lets the agent delete a container only after its result
// is in the outbox, so a crash between exit and outbox loses nothing (the
// design had wait() remove it after inspect).
//
// `run(spec)`: `{runId, jobId, image, entrypoint, args, env, secretEnv,
// resources: {cpus, memoryMiB}, network, labels}`. `env` and `secretEnv` are
// both NAME -> value; a real runtime passes secretEnv as `-e NAME` with the
// value only in the child's environment, never argv or disk.

import { FakeRuntime } from "./fake.mjs";

export const RUNTIME_METHODS = ["ensureReady", "idle", "stop", "hasImage", "pull", "run", "adopt", "facts"];

/** Throws unless `runtime` has every method of the interface. */
export function assertRuntime(runtime) {
  const missing = RUNTIME_METHODS.filter((method) => typeof runtime?.[method] !== "function");
  if (missing.length) throw new Error(`The runtime lacks ${missing.join(", ")}`);
  return runtime;
}

/** The runtime a configuration names. Only `fake` exists until M3. */
export function createRuntime(config, { clock } = {}) {
  if (config.runtime === "fake") return new FakeRuntime({ ...(config.fake ?? {}), clock });
  throw new Error(`The ${config.runtime} runtime arrives in M3; this agent can only use runtime "fake"`);
}

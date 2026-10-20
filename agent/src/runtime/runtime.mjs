// The container runtime the agent drives (§4.3 of
// docs/hosted-control-plane.md): DockerCliRuntime (Docker Engine, Docker
// Desktop), ColimaRuntime (Docker in a Colima VM it starts, sizes and stops),
// ProcessRuntime (an OCI image unpacked and run as a process, with no daemon)
// and FakeRuntime (scripted containers, for tests and for trying the agent
// without a runtime) implement one interface:
//
//   interface ContainerRuntime {
//     ensureReady({ cpus, memoryMiB }) -> { bootMs }       // Colima: start/resize; Docker: ping
//     idle()                                               // nothing runs: prune old images
//     stop()                                               // Colima: stop the VM now; Docker: no-op
//     hasImage(ref) ; pull(ref, { auth, timeoutMs }) -> { digest, ms }
//     imageDigest?(ref) -> digest                          // what a cached image resolves to
//     run(spec) -> handle
//     released?(runId)                                     // the run is over (its image may be pruned)
//     adopt({ expected }) -> handle[]                      // containers labelled dev.homecompute.run
//     facts() -> { kind, version, cpus, memoryMiB, diskFreeMiB, vm? }
//     setContext?({ runs, upcoming, config, busy })        // Colima: what the VM is sized for
//     tick?({ mayStart }) -> { action, reason, wakeAt, error? }   // Colima: pre-warm, resize, idle stop (§4.4)
//     selfTest?(image)                                     // doctor: `docker run --rm` of a tiny image
//   }
//
//   handle {
//     id, runId, jobId,                                    // runId/jobId from the container's labels
//     logs: AsyncIterable<line>,                           // stdout+stderr from the start, then live
//     stats() -> { memoryBytes, memoryLimitBytes?, cpuPct, cpuSeconds? },
//     wait() -> { exitCode, oomKilled },                   // inspect after exit
//     stop(graceS),                                        // SIGTERM, then SIGKILL after graceS
//     remove(),                                            // docker rm, once the result is safe
//     secretValues?(names) -> values                       // after a restart: the container's own env, for redaction
//     detach?(),                                           // stop watching (a service stop); the container runs on
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

import { ColimaRuntime } from "./colima.mjs";
import { DockerCliRuntime } from "./docker-cli.mjs";
import { FakeRuntime } from "./fake.mjs";
import { ProcessRuntime } from "./process-runtime.mjs";

export const RUNTIME_METHODS = ["ensureReady", "idle", "stop", "hasImage", "pull", "run", "adopt", "facts"];

/** Throws unless `runtime` has every method of the interface. */
export function assertRuntime(runtime) {
  const missing = RUNTIME_METHODS.filter((method) => typeof runtime?.[method] !== "function");
  if (missing.length) throw new Error(`The runtime lacks ${missing.join(", ")}`);
  return runtime;
}

/**
 * The runtime a configuration names (README.md lists the fields). `state`:
 * the StateDir, for the image record and the measured boot time. `env`: the
 * environment `docker` and `colima` run with (PATH finds them).
 */
export function createRuntime(config, { clock, state = null, log = () => {}, env = process.env } = {}) {
  if (config.runtime === "fake") return new FakeRuntime({ ...(config.fake ?? {}), clock });
  const docker = config.docker ?? {};
  if (config.runtime === "docker") {
    return new DockerCliRuntime({
      docker: docker.binary ?? "docker", host: docker.host ?? null, env, clock, state, log, cgroupParent: docker.cgroupParent ?? null,
    });
  }
  if (config.runtime === "colima") {
    const colima = config.colima ?? {};
    return new ColimaRuntime({
      profile: colima.profile ?? "home-compute", colima: colima.binary ?? "colima", docker: docker.binary ?? "docker",
      colimaHome: colima.home ?? null, env, clock, state, log, vmType: colima.vmType ?? "vz", diskGiB: colima.diskGiB ?? 60,
      caps: { cpus: config.caps?.cpus, memoryMiB: config.caps?.memoryMiB }, min: { cpus: colima.minCpus, memoryMiB: colima.minMemoryMiB },
      maxRuns: config.caps?.maxRuns ?? 2, startTimeoutSeconds: colima.startTimeoutSeconds ?? 600, mountHome: Boolean(colima.mountHome),
    });
  }
  if (config.runtime === "process") {
    const proc = config.process ?? {};
    return new ProcessRuntime({
      state, clock, log, env, cacheDir: proc.cacheDir ?? null, sandbox: proc.sandbox ?? "auto",
      bwrap: proc.bwrap ?? "bwrap", proot: proc.proot ?? "proot", unshare: proc.unshare ?? "unshare",
      keepImages: proc.keepImages ?? 3, selfTestImage: proc.selfTestImage, selfTestArgs: proc.selfTestArgs,
    });
  }
  throw new Error(`Unknown runtime ${config.runtime}: use docker, colima, process or fake`);
}

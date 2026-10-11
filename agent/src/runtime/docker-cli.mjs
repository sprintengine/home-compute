// DockerCliRuntime (§4.3): Docker Engine on Linux or WSL, or Docker Desktop.
// The `docker` command line pulls, runs, stops and removes, so Docker's own
// contexts and credential helpers apply; the Engine API over the same unix
// socket answers inspect, wait, stats, ping and info, so sampling a
// container every few seconds spawns nothing. Secret values reach
// `docker run` only in its environment (`-e NAME`), never in argv or on disk.

import { spawn } from "node:child_process";
import { mkdtemp, rm, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JOB_LABEL, RUN_LABEL } from "../../../src/core/protocol.mjs";
import { systemClock } from "../clock.mjs";
import { isLocalImage } from "../policy.mjs";
import { Engine, sampleFromStats, socketPathOf } from "./engine.mjs";
import { digestFor, ImageRecord, parseImageRef } from "./images.mjs";
import { LineQueue, LineSplitter, parseLogLine, timestampKey } from "./log-stream.mjs";
import { CommandError, commandEnv, reservedSecretName, runCommand } from "./process.mjs";

const MIB = 1048576;
/** §4.3's fixed limits: low CPU weight against other containers, a bound on processes, a capped local log. */
export const RUN_DEFAULTS = { cpuShares: 256, pidsLimit: 4096, logMaxSize: "50m", memoryMiB: 1024, cpus: 1 };
const NETWORKS = new Set(["bridge", "none"]);
const LOG_RECONNECTS = 30;
const DOCTOR_IMAGE = "hello-world";

/**
 * The `docker run` argv for a spec (§4.3), exactly:
 *
 *   run -d --name hc-<run> --label …run=<run> --label …job=<job>
 *     --memory Mm --memory-swap Mm --cpus C --cpu-shares 256 --pids-limit 4096
 *     --security-opt no-new-privileges --cap-drop ALL --init --network bridge|none
 *     --log-driver local --log-opt max-size=50m [--cgroup-parent SLICE]
 *     -e NAME=value … -e SECRET_NAME … [--entrypoint FIRST] IMAGE [REST…] ARGS…
 *
 * Secrets appear by name only; their values go in the process environment.
 * Nothing here can add a privilege, a mount, a device or the host's network.
 */
export function buildRunArgs(spec, { cgroupParent = null } = {}) {
  const network = spec.network ?? "bridge";
  if (!NETWORKS.has(network)) throw new Error(`network ${network} is not allowed`);
  const memory = `${Math.max(6, Math.round(spec.resources?.memoryMiB ?? RUN_DEFAULTS.memoryMiB))}m`;
  const cpus = String(spec.resources?.cpus ?? RUN_DEFAULTS.cpus);
  const args = ["run", "-d", "--name", `hc-${spec.runId}`];
  for (const [key, value] of Object.entries(spec.labels ?? {})) args.push("--label", `${key}=${value}`);
  args.push(
    "--memory", memory, "--memory-swap", memory, "--cpus", cpus,
    "--cpu-shares", String(RUN_DEFAULTS.cpuShares), "--pids-limit", String(RUN_DEFAULTS.pidsLimit),
    "--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--init", "--network", network,
    "--log-driver", "local", "--log-opt", `max-size=${RUN_DEFAULTS.logMaxSize}`,
  );
  if (cgroupParent) args.push("--cgroup-parent", cgroupParent);
  const secretNames = Object.keys(spec.secretEnv ?? {});
  for (const [name, value] of Object.entries(spec.env ?? {})) if (!secretNames.includes(name)) args.push("-e", `${name}=${value}`);
  for (const name of secretNames) args.push("-e", name);
  const entrypoint = Array.isArray(spec.entrypoint) && spec.entrypoint.length ? spec.entrypoint : null;
  if (entrypoint) args.push("--entrypoint", entrypoint[0]);
  args.push(spec.image, ...(entrypoint ? entrypoint.slice(1) : []), ...(spec.args ?? []).map(String));
  return args;
}

/** Why a spec cannot be passed to `docker run` safely, or null. */
export function runRefusal(spec) {
  for (const name of Object.keys(spec.secretEnv ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return `secret name ${name} is not an environment variable name`;
    if (reservedSecretName(name)) return `secret name ${name} would change how docker itself runs`;
  }
  for (const name of Object.keys(spec.env ?? {})) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return `env name ${name} is not an environment variable name`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(String(spec.image ?? ""))) return "the image reference is invalid";
  if (!/^r_[A-Za-z0-9]+$/.test(String(spec.runId ?? ""))) return "the run id is invalid";
  return null;
}

/** "No such container/image": the thing is already gone. */
function missing(error) {
  return /No such (?:container|image)|not found/i.test(`${error?.stderr ?? ""} ${error?.message ?? ""}`);
}

/** Free disk at `directory` in MiB, or null. */
export async function freeDiskMiB(directory) {
  try {
    const stats = await statfs(directory);
    return Math.floor((stats.bavail * stats.bsize) / MIB);
  } catch {
    return null;
  }
}

/** One container, as the agent supervises it (the handle of runtime.mjs). */
class DockerContainer {
  constructor(runtime, id, labels = {}) {
    this.runtime = runtime;
    this.id = id;
    this.labels = labels ?? {};
    this.abort = new AbortController();
    this.detached = false;
    this.previous = null;
    this.startedAt = null;
    this.logChild = null;
    this.waiting = null;
  }

  async #inspect() {
    const info = await this.runtime.engine.inspectContainer(this.id);
    if (info?.State?.StartedAt && !this.startedAt) {
      const started = Date.parse(info.State.StartedAt);
      if (Number.isFinite(started) && started > 0) this.startedAt = started;
    }
    return info;
  }

  /** `docker logs -f --timestamps` from the first line; reattaches (from the last timestamp) if it breaks while the container runs. */
  async *logs() {
    let since = null;
    let lastKey = "";
    for (let attempt = 0; attempt <= LOG_RECONNECTS && !this.detached; attempt += 1) {
      const queue = new LineQueue();
      const args = ["logs", "-f", "--timestamps", ...(since ? ["--since", since] : []), this.id];
      let child;
      try {
        child = spawn(this.runtime.dockerPath, args, { env: this.runtime.cliEnv(), stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        this.runtime.log("log_error", { container: this.id, error: error.message });
        return;
      }
      this.logChild = child;
      for (const stream of [child.stdout, child.stderr]) {
        const splitter = new LineSplitter((line) => queue.push(line));
        stream.on("data", (chunk) => splitter.push(chunk));
        stream.on("end", () => splitter.end());
      }
      child.on("error", (error) => queue.fail(error));
      child.on("close", () => queue.close());
      const reattached = since !== null;
      try {
        for await (const raw of queue) {
          const { at, text } = parseLogLine(raw);
          // Lines without a timestamp are the CLI's own (an error), not the container's.
          if (!at) {
            if (raw.trim()) this.runtime.log("log_cli", { container: this.id, line: raw.slice(0, 300) });
            continue;
          }
          const key = timestampKey(at);
          if (reattached && key && lastKey && key <= lastKey) continue;
          if (key) lastKey = key;
          since = at;
          yield text;
        }
      } catch (error) {
        this.runtime.log("log_error", { container: this.id, error: error.message });
      } finally {
        this.logChild = null;
        if (child.pid > 0 && child.exitCode === null && child.signalCode === null) child.kill();
      }
      if (this.detached) return;
      const info = await this.#inspect().catch(() => undefined);
      if (!info?.State?.Running) return;
      await this.runtime.clock.sleep(1000, this.abort.signal);
    }
  }

  async stats() {
    if (!this.startedAt) await this.#inspect().catch(() => null);
    const raw = await this.runtime.engine.stats(this.id);
    if (!raw) throw new Error(`container ${this.id} is gone`);
    const now = Date.now();
    const sample = sampleFromStats(raw, { previous: this.previous, startedAt: this.startedAt, now });
    if (sample?.raw) {
      this.previous = sample.raw;
      delete sample.raw;
    }
    return sample;
  }

  wait() {
    if (!this.waiting) this.waiting = this.#wait();
    return this.waiting;
  }

  async #wait() {
    for (;;) {
      if (this.detached) return { exitCode: null, oomKilled: false, detached: true };
      try {
        const answer = await this.runtime.engine.waitContainer(this.id, this.abort.signal);
        if (answer === null) return { exitCode: null, oomKilled: false, gone: true };
        break;
      } catch {
        // Docker went away (a daemon restart, say): look again in a moment, unless the container has stopped.
        if (this.detached) return { exitCode: null, oomKilled: false, detached: true };
        await this.runtime.clock.sleep(2000, this.abort.signal);
        const info = await this.#inspect().catch(() => undefined);
        if (info === null) return { exitCode: null, oomKilled: false, gone: true };
        if (info && !info.State?.Running) break;
      }
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        const info = await this.#inspect();
        if (!info) return { exitCode: null, oomKilled: false, gone: true };
        return { exitCode: info.State?.ExitCode ?? null, oomKilled: Boolean(info.State?.OOMKilled) };
      } catch (error) {
        if (attempt >= 5 || this.detached) return { exitCode: null, oomKilled: false, error: error.message };
        await this.runtime.clock.sleep(1000, this.abort.signal);
      }
    }
  }

  /** `docker stop -t grace`: SIGTERM, then SIGKILL after the grace (Docker's own escalation). */
  async stop(graceSeconds) {
    const grace = Math.max(0, Math.ceil(graceSeconds));
    try {
      await this.runtime.docker(["stop", "-t", String(grace), this.id], { timeoutMs: (grace + 30) * 1000 });
    } catch (error) {
      if (missing(error)) return;
      await this.runtime.docker(["kill", this.id], { timeoutMs: 30_000 }).catch(() => {});
      throw error;
    }
  }

  async remove() {
    try {
      await this.runtime.docker(["rm", this.id], { timeoutMs: 60_000 });
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }

  /**
   * The values of the named variables in the container's environment, for
   * redaction after a restart (§4.6): secrets delivered with a claim lived
   * only in the old agent's memory, but Docker keeps a container's
   * environment until it is removed. Held in memory only.
   */
  async secretValues(names) {
    const wanted = new Set(names);
    const info = await this.#inspect();
    const values = [];
    for (const entry of info?.Config?.Env ?? []) {
      const equals = entry.indexOf("=");
      if (equals > 0 && wanted.has(entry.slice(0, equals))) values.push(entry.slice(equals + 1));
    }
    return values;
  }

  /** Lets go without touching the container: the log process ends and wait() returns. */
  detach() {
    this.detached = true;
    this.abort.abort();
    const child = this.logChild;
    if (child?.pid > 0 && child.exitCode === null && child.signalCode === null) child.kill();
  }

  handle() {
    const container = this;
    return {
      id: this.id,
      runId: this.labels[RUN_LABEL] ?? null,
      jobId: this.labels[JOB_LABEL] ?? null,
      labels: this.labels,
      logs: { [Symbol.asyncIterator]: () => container.logs() },
      stats: () => this.stats(),
      wait: () => this.wait(),
      stop: (graceSeconds) => this.stop(graceSeconds),
      remove: () => this.remove(),
      secretValues: (names) => this.secretValues(names),
      detach: () => this.detach(),
    };
  }
}

export class DockerCliRuntime {
  /**
   * `docker`: the CLI (found on `env.PATH`). `host`: a `unix://` DOCKER_HOST;
   * by default the environment's, else the current docker context's, else
   * /var/run/docker.sock. `state`: the agent's StateDir, for its image record.
   * `cgroupParent`: Linux's `home-compute.slice` (§4.3).
   */
  constructor({
    docker = "docker", host = null, env = process.env, clock = systemClock, state = null, cgroupParent = null,
    kind = "docker", log = () => {}, keepImages = 3, diskPath = null,
  } = {}) {
    Object.assign(this, { dockerPath: docker, host, env, clock, cgroupParent, kind, log, keepImages, diskPath });
    this.images = new ImageRecord(state);
    this.engineInstance = null;
    this.inUse = new Map();
  }

  /** The DOCKER_HOST every command and the Engine client use. */
  async resolveHost() {
    if (this.host) return this.host;
    if (this.env.DOCKER_HOST) {
      this.host = this.env.DOCKER_HOST;
      return this.host;
    }
    try {
      const { stdout } = await runCommand(this.dockerPath, ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
        { env: commandEnv(this.env), timeoutMs: 15_000 });
      const host = stdout.trim();
      if (host) {
        this.host = host;
        return host;
      }
    } catch {
      // No CLI or no context: Docker Engine's default socket.
    }
    this.host = "unix:///var/run/docker.sock";
    return this.host;
  }

  get engine() {
    if (!this.host) throw new Error("the Docker host is not resolved yet");
    if (!this.engineInstance) this.engineInstance = new Engine({ socketPath: socketPathOf(this.host) });
    return this.engineInstance;
  }

  /** A `docker` process's environment: a few inherited names, the host, then `extra` (a run's secrets). */
  cliEnv(extra = {}) {
    return commandEnv(this.env, { DOCKER_HOST: this.host, ...extra });
  }

  async docker(args, { env = {}, input = null, timeoutMs = 120_000, allowFailure = false } = {}) {
    await this.resolveHost();
    return runCommand(this.dockerPath, args, { env: this.cliEnv(env), input, timeoutMs, allowFailure });
  }

  async ensureReady() {
    await this.resolveHost();
    await this.engine.ping();
    return { bootMs: 0 };
  }

  /** Nothing is running: remove images beyond the newest 3 digests per repository the agent pulled (§4.5). */
  async idle() {
    await this.resolveHost();
    const inUse = new Set(this.inUse.values());
    const removed = await this.images.prune(async (reference) => {
      try {
        await this.docker(["image", "rm", reference], { timeoutMs: 120_000 });
        return true;
      } catch (error) {
        return missing(error);
      }
    }, { keep: this.keepImages, inUse });
    if (removed.length) this.log("images_pruned", { removed });
    return { pruned: removed };
  }

  async stop() {}

  /**
   * Whether `reference` can run without a pull: a digest or a local image
   * that is here. A registry tag is always pulled (§4.5: a tag is resolved
   * by pulling, which downloads nothing when it is current).
   */
  async hasImage(reference) {
    await this.resolveHost();
    if (!parseImageRef(reference).digest && !isLocalImage(reference)) return false;
    return (await this.engine.inspectImage(reference)) !== null;
  }

  /** The digest `reference` resolves to here, or null when the image is missing. */
  async imageDigest(reference) {
    await this.resolveHost();
    const image = await this.engine.inspectImage(reference);
    return image ? digestFor(reference, image) : null;
  }

  /**
   * `docker pull`. With `auth` (`{server, username, password}`, a registry
   * secret delivered with the claim) it logs in for this pull only: a
   * throwaway DOCKER_CONFIG, the password on stdin, logged out and deleted
   * afterwards. A tag that cannot be pulled but is here already runs as it is.
   */
  async pull(reference, { auth = null, timeoutMs = 20 * 60_000 } = {}) {
    await this.resolveHost();
    const started = this.clock.monotonic();
    try {
      if (auth) await this.#pullWithAuth(reference, auth, timeoutMs);
      else await this.docker(["pull", "--quiet", reference], { timeoutMs });
    } catch (error) {
      const here = !parseImageRef(reference).digest ? await this.engine.inspectImage(reference).catch(() => null) : null;
      if (!here) throw error;
      this.log("pull_failed_using_local", { image: reference, error: error.message });
      return { digest: digestFor(reference, here), ms: Math.round(this.clock.monotonic() - started), stale: true };
    }
    const digest = await this.imageDigest(reference);
    await this.images.used(reference, digest, { pulled: true, now: this.clock.now() }).catch(() => {});
    return { digest, ms: Math.round(this.clock.monotonic() - started) };
  }

  async #pullWithAuth(reference, auth, timeoutMs) {
    const server = auth.server ?? parseImageRef(reference).repo.split("/")[0];
    const config = await mkdtemp(path.join(os.tmpdir(), "hc-docker-auth-"));
    const env = { DOCKER_CONFIG: config };
    try {
      await this.docker(["login", "--username", String(auth.username), "--password-stdin", server], { env, input: String(auth.password), timeoutMs: 60_000 });
      await this.docker(["pull", "--quiet", reference], { env, timeoutMs });
    } finally {
      await this.docker(["logout", server], { env, timeoutMs: 30_000, allowFailure: true }).catch(() => {});
      await rm(config, { recursive: true, force: true });
    }
  }

  async run(spec) {
    await this.resolveHost();
    const refusal = runRefusal(spec);
    if (refusal) throw new Error(refusal);
    const args = buildRunArgs(spec, { cgroupParent: this.cgroupParent });
    const secrets = Object.fromEntries(Object.entries(spec.secretEnv ?? {}).map(([name, value]) => [name, String(value)]));
    let stdout;
    try {
      ({ stdout } = await this.docker(args, { env: secrets, timeoutMs: 120_000 }));
    } catch (error) {
      // A container created but not started would block the name; it holds nothing worth keeping.
      await this.docker(["rm", "-f", `hc-${spec.runId}`], { timeoutMs: 30_000, allowFailure: true }).catch(() => {});
      throw error instanceof CommandError ? new Error(error.message) : error;
    }
    const id = stdout.trim().split(/\s+/).pop();
    if (!id) throw new Error("docker run printed no container id");
    this.#noteUse(spec.image, spec.runId);
    return new DockerContainer(this, id, spec.labels ?? {}).handle();
  }

  async #noteUse(reference, runId) {
    try {
      const digest = await this.imageDigest(reference);
      if (!digest) return;
      this.inUse.set(runId, digest);
      await this.images.used(reference, digest, { now: this.clock.now() });
    } catch {
      // Only the image cache's bookkeeping.
    }
  }

  /** The run is over: its image may be pruned again. */
  released(runId) {
    this.inUse.delete(runId);
  }

  async adopt() {
    await this.resolveHost();
    const containers = await this.engine.listContainers(RUN_LABEL);
    return containers.map((container) => new DockerContainer(this, container.Id, container.Labels ?? {}).handle());
  }

  async facts() {
    await this.resolveHost();
    const info = await this.engine.info();
    if (!info) throw new Error("Docker's /info is missing");
    // Linux: the disk Docker writes to. Docker Desktop's is in its VM, whose image grows on the host's disk.
    const rootDir = this.diskPath ?? (process.platform === "linux" ? info.DockerRootDir : null);
    const diskFreeMiB = (rootDir ? await freeDiskMiB(rootDir) : null) ?? await freeDiskMiB(os.homedir());
    return {
      kind: this.kind,
      version: info.ServerVersion ?? null,
      cpus: info.NCPU ?? null,
      memoryMiB: typeof info.MemTotal === "number" ? Math.floor(info.MemTotal / MIB) : null,
      diskFreeMiB,
      os: info.OperatingSystem ?? null,
      vm: null,
    };
  }

  /**
   * `doctor`'s proof that containers start: `docker run --rm` of a tiny image
   * under the same restrictions as a run, without a network.
   */
  async selfTest(image = DOCTOR_IMAGE) {
    await this.resolveHost();
    const { stdout } = await this.docker([
      "run", "--rm", "--memory", "64m", "--memory-swap", "64m", "--cpus", "1", "--pids-limit", "64",
      "--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--init", "--network", "none", image,
    ], { timeoutMs: 300_000 });
    return stdout.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  }
}

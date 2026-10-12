// ColimaRuntime (§4.3, §4.4): Docker inside a Colima VM of the agent's own
// profile (`home-compute`), started when work is due, sized for it, and
// stopped when idle. Containers go through DockerCliRuntime with
// DOCKER_HOST=unix://$COLIMA_HOME/<profile>/docker.sock. The owner's other
// profiles (`default`) and their docker context are never touched: the VM
// starts with --activate=false, so the current docker context stays as it is.

import os from "node:os";
import path from "node:path";
import { systemClock } from "../clock.mjs";
import { DockerCliRuntime, freeDiskMiB } from "./docker-cli.mjs";
import { commandEnv, runCommand } from "./process.mjs";
import { DEFAULT_BOOT_SECONDS, planVmSize, sizeFor, VM_OVERHEAD_MIB, vmDecision, vmFits } from "./vm-plan.mjs";

const MIB = 1048576;
const GIB = 1073741824;
const STATUS_TTL_MS = 30_000;
const DISK_TTL_MS = 5 * 60_000;
const DOCKER_WAIT_MS = 90_000;

/** An error whose cause is the VM failing to start: three in a row make the machine unhealthy (§4.4). */
export class VmStartError extends Error {
  constructor(message) {
    super(message);
    this.name = "VmStartError";
    this.vmStartFailure = true;
  }
}

/** `colima list --json` (one JSON object per line) → the profile's VM, or `{state: "absent"}`. */
export function parseColimaList(stdout, profile) {
  for (const line of String(stdout ?? "").split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.name !== profile) continue;
    return {
      state: String(entry.status ?? "unknown").toLowerCase(),
      cpus: entry.cpus ?? null,
      memoryMiB: typeof entry.memory === "number" ? Math.round(entry.memory / MIB) : null,
      diskGiB: typeof entry.disk === "number" ? Math.round(entry.disk / GIB) : null,
    };
  }
  return { state: "absent", cpus: null, memoryMiB: null, diskGiB: null };
}

/** `df -Pk` output → the free MiB on its last line, or null. */
export function parseDfAvailable(stdout) {
  const line = String(stdout ?? "").trim().split("\n").at(-1) ?? "";
  const fields = line.trim().split(/\s+/);
  const available = Number(fields[3]);
  return Number.isFinite(available) && fields.length >= 4 ? Math.floor(available / 1024) : null;
}

/** GiB as colima's --memory takes it: 2.75, never 2.7500001. */
function gib(memoryMiB) {
  return String(Math.round((memoryMiB / 1024) * 100) / 100);
}

export class ColimaRuntime {
  /**
   * `profile`: the agent's own Colima profile. `caps`: the largest VM
   * (`{cpus, memoryMiB}`); `min`: the smallest (§4.4: 2 CPU, 2 GiB).
   * `diskGiB`: the VM's disk (it only ever grows). `colimaHome`: COLIMA_HOME.
   */
  constructor({
    profile = "home-compute", colima = "colima", docker = "docker", colimaHome = null, env = process.env, clock = systemClock,
    state = null, log = () => {}, vmType = "vz", diskGiB = 60, caps = {}, min = {}, maxRuns = 2, startTimeoutSeconds = 600,
    mountHome = false, hostCpus = os.availableParallelism?.() ?? os.cpus().length, hostMemoryMiB = Math.floor(os.totalmem() / MIB),
  } = {}) {
    this.profile = profile;
    this.colimaPath = colima;
    this.env = env;
    this.home = colimaHome ?? env.COLIMA_HOME ?? path.join(env.HOME ?? os.homedir(), ".colima");
    this.clock = clock;
    this.state = state;
    this.log = log;
    this.vmType = vmType;
    this.diskGiB = diskGiB;
    this.caps = {
      cpus: caps.cpus ?? Math.max(2, Math.floor(hostCpus / 2)),
      memoryMiB: caps.memoryMiB ?? Math.max(2048, Math.min(8192, Math.floor(hostMemoryMiB / 2 / 256) * 256)),
    };
    this.min = { cpus: min.cpus ?? 2, memoryMiB: min.memoryMiB ?? 2048 };
    this.maxRuns = maxRuns;
    this.startTimeoutMs = startTimeoutSeconds * 1000;
    this.mountHome = mountHome;
    this.docker = new DockerCliRuntime({
      docker, host: `unix://${path.join(this.home, profile, "docker.sock")}`, env, clock, state, kind: "colima", log,
    });
    this.vm = { state: "unknown", cpus: null, memoryMiB: null, diskGiB: null };
    this.statusAt = null;
    this.bootSeconds = null;
    this.loaded = false;
    this.lastBusyAt = clock.now();
    this.active = new Map();
    this.context = { runs: [], upcoming: [], config: null, busy: false };
    this.queue = Promise.resolve();
    this.disk = { freeMiB: null, at: null, usedMiB: null };
    this.versionText = null;
  }

  /** VM operations one at a time: a pre-warm, a claim's start and an idle stop never overlap. */
  #exclusive(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  colimaEnv() {
    return commandEnv(this.env, { COLIMA_HOME: this.home });
  }

  colima(args, { timeoutMs = 60_000, allowFailure = false } = {}) {
    return runCommand(this.colimaPath, args, { env: this.colimaEnv(), timeoutMs, allowFailure });
  }

  get #vmFile() {
    return this.state ? path.join(this.state.dir, "vm.json") : null;
  }

  async #load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.#vmFile) return;
    try {
      const stored = await this.state.readJson(this.#vmFile);
      if (typeof stored?.bootSeconds === "number") this.bootSeconds = stored.bootSeconds;
      if (typeof stored?.diskUsedMiB === "number") this.disk.usedMiB = stored.diskUsedMiB;
    } catch {
      // Measured again at the next boot.
    }
  }

  async #save() {
    if (!this.#vmFile) return;
    await this.state.writeSecure(this.#vmFile, `${JSON.stringify({ profile: this.profile, bootSeconds: this.bootSeconds, diskUsedMiB: this.disk.usedMiB })}\n`).catch(() => {});
  }

  /** The profile's VM (`colima list --json`), at most 30 s old unless `fresh`. */
  async status({ fresh = false } = {}) {
    await this.#load();
    if (!fresh && this.statusAt !== null && this.clock.now() - this.statusAt < STATUS_TTL_MS) return this.vm;
    const { stdout } = await this.colima(["list", "--json"], { timeoutMs: 30_000 });
    this.vm = parseColimaList(stdout, this.profile);
    this.statusAt = this.clock.now();
    return this.vm;
  }

  /** What the agent knows of its runs and slots (it calls this on every change); used to size the VM. */
  setContext(context = {}) {
    this.context = { ...this.context, ...context };
    if (this.context.busy) this.lastBusyAt = this.clock.now();
  }

  desiredSize() {
    return planVmSize({
      runs: this.context.runs ?? [], upcoming: this.context.upcoming ?? [], now: this.clock.now(), caps: this.caps, min: this.min, maxRuns: this.maxRuns,
    });
  }

  heldMiB() {
    return [...this.active.values()].reduce((total, resources) => total + (resources?.memoryMiB ?? 0), 0);
  }

  async #start(size, reason) {
    const disk = Math.max(this.diskGiB, this.vm.diskGiB ?? 0);
    const args = [
      "start", this.profile, "--runtime", "docker", "--vm-type", this.vmType,
      "--cpus", String(size.cpus), "--memory", gib(size.memoryMiB), "--disk", String(disk),
      "--activate=false", "--ssh-config=false",
    ];
    if (!this.mountHome) args.push("--mount", "none");
    this.log("vm_starting", { profile: this.profile, cpus: size.cpus, memoryMiB: size.memoryMiB, reason });
    const started = this.clock.monotonic();
    try {
      await this.colima(args, { timeoutMs: this.startTimeoutMs });
      await this.#waitForDocker();
    } catch (error) {
      this.statusAt = null;
      // A half-started VM holds memory and blocks the next start: stop it hard.
      await this.colima(["stop", "--force", this.profile], { timeoutMs: 120_000, allowFailure: true }).catch(() => {});
      this.vm = { ...this.vm, state: "stopped" };
      this.log("vm_start_failed", { profile: this.profile, error: error.message });
      throw new VmStartError(`colima could not start the ${this.profile} VM: ${error.message.replace(/^colima start failed: /, "")}`);
    }
    const bootMs = Math.round(this.clock.monotonic() - started);
    this.bootSeconds = Math.round(bootMs / 100) / 10;
    this.vm = { state: "running", cpus: size.cpus, memoryMiB: size.memoryMiB, diskGiB: disk };
    this.statusAt = this.clock.now();
    this.lastBusyAt = this.clock.now();
    this.disk.at = null;
    await this.#save();
    this.log("vm_started", { profile: this.profile, cpus: size.cpus, memoryMiB: size.memoryMiB, bootSeconds: this.bootSeconds });
    return { bootMs };
  }

  async #waitForDocker() {
    const deadline = this.clock.monotonic() + DOCKER_WAIT_MS;
    for (;;) {
      try {
        await this.docker.ensureReady();
        return;
      } catch (error) {
        if (this.clock.monotonic() > deadline) throw new Error(`Docker in the VM did not answer: ${error.message}`);
        await this.clock.sleep(500);
      }
    }
  }

  async #stopVm(reason) {
    this.log("vm_stopping", { profile: this.profile, reason });
    await this.#measureDisk().catch(() => {});
    await this.colima(["stop", this.profile], { timeoutMs: 180_000 });
    this.vm = { ...this.vm, state: "stopped" };
    this.statusAt = this.clock.now();
    this.log("vm_stopped", { profile: this.profile, reason });
  }

  /**
   * A run is about to start: the VM must be running with room for it. A
   * stopped VM starts at the planned size (grown to fit); a running one too
   * small is resized only while it holds no containers.
   */
  ensureReady(required = {}) {
    return this.#exclusive(async () => {
      const vm = await this.status({ fresh: true });
      const desired = this.desiredSize();
      const held = this.heldMiB();
      if (vm.state === "running") {
        // As big as the run needs, or as big as the cap allows: a restart would give it nothing more.
        const target = sizeFor(desired, required, held, this.caps);
        if (vmFits(vm, required, held) || (vm.cpus >= target.cpus && vm.memoryMiB >= target.memoryMiB)) {
          await this.docker.ensureReady();
          return { bootMs: 0 };
        }
        if (this.active.size === 0) {
          await this.#stopVm("resize for a run");
          return this.#start(sizeFor(desired, required, 0, this.caps), "resize for a run");
        }
        const error = new Error(`the ${this.profile} VM (${vm.cpus} CPU, ${vm.memoryMiB} MiB) has no room for this run beside the ${this.active.size} running`);
        error.countsAsFailure = false;
        throw error;
      }
      if (vm.state !== "stopped" && vm.state !== "absent") {
        await this.colima(["stop", "--force", this.profile], { timeoutMs: 120_000, allowFailure: true }).catch(() => {});
      }
      return this.#start(sizeFor(desired, required, held, this.caps), "a run was claimed");
    });
  }

  /**
   * The lifecycle step (§4.4): pre-warm, resize while empty, or stop when
   * idle, as vmDecision() says. `mayStart` is false while start failures
   * gate the machine. Returns the decision (with `error` when acting failed).
   */
  tick({ mayStart = true } = {}) {
    return this.#exclusive(async () => {
      let vm;
      try {
        vm = await this.status();
      } catch (error) {
        return { action: "none", reason: `colima did not answer: ${error.message}`, wakeAt: this.clock.now() + 30_000, error };
      }
      const busy = Boolean(this.context.busy) || this.active.size > 0;
      if (busy) this.lastBusyAt = this.clock.now();
      const decision = vmDecision({
        now: this.clock.now(), vm, busy, lastBusyAt: this.lastBusyAt, upcoming: this.context.upcoming, config: this.context.config ?? undefined,
        bootSeconds: this.bootSeconds ?? DEFAULT_BOOT_SECONDS, desired: this.desiredSize(), mayStart,
      });
      try {
        if (decision.action === "start") await this.#start(decision.size, decision.reason);
        else if (decision.action === "resize") {
          await this.#stopVm(decision.reason);
          await this.#start(decision.size, decision.reason);
        } else if (decision.action === "stop") {
          await this.docker.idle().catch(() => {});
          // A claim may have arrived while old images were pruned: then the VM stays.
          if (this.context.busy || this.active.size > 0) return { action: "none", reason: "work arrived before the idle stop", wakeAt: null };
          await this.#stopVm(decision.reason);
        }
      } catch (error) {
        return { ...decision, error };
      }
      return decision;
    });
  }

  /** Nothing runs: prune old images while the VM is up (the lifecycle stops it later). */
  async idle() {
    if (this.vm.state !== "running") return { pruned: [] };
    return this.docker.idle();
  }

  /** Stops the VM now (an uninstall, a test); the lifecycle would have stopped it when idle. */
  stop() {
    return this.#exclusive(async () => {
      const vm = await this.status({ fresh: true });
      if (vm.state === "running") await this.#stopVm("asked to stop");
    });
  }

  hasImage(reference) {
    return this.docker.hasImage(reference);
  }

  imageDigest(reference) {
    return this.docker.imageDigest(reference);
  }

  pull(reference, options) {
    return this.docker.pull(reference, options);
  }

  async run(spec) {
    const handle = await this.docker.run(spec);
    this.active.set(spec.runId, spec.resources ?? {});
    this.lastBusyAt = this.clock.now();
    return handle;
  }

  released(runId) {
    this.active.delete(runId);
    this.docker.released(runId);
    this.lastBusyAt = this.clock.now();
  }

  /**
   * Containers left from before a restart. A stopped VM keeps them (exited)
   * on its disk, so when the agent expects some (`expected` run records) it
   * starts the VM to find them and read their exit; otherwise a stopped VM
   * has nothing to adopt.
   */
  async adopt({ expected = 0 } = {}) {
    const vm = await this.status({ fresh: true }).catch(() => ({ state: "unknown" }));
    if (vm.state !== "running") {
      if (!expected) return [];
      try {
        await this.ensureReady({ cpus: 1, memoryMiB: 0 });
      } catch (error) {
        this.log("adopt_vm_failed", { profile: this.profile, error: error.message });
        return [];
      }
    }
    const handles = await this.docker.adopt();
    for (const handle of handles) if (handle.runId) this.active.set(handle.runId, {});
    return handles;
  }

  async #measureDisk() {
    if (this.vm.state !== "running") return;
    if (this.disk.at !== null && this.clock.now() - this.disk.at < DISK_TTL_MS) return;
    const { stdout } = await this.colima(["ssh", "-p", this.profile, "--", "df", "-Pk", "/var/lib/docker"], { timeoutMs: 30_000 });
    const free = parseDfAvailable(stdout);
    if (free === null) return;
    this.disk.freeMiB = free;
    this.disk.at = this.clock.now();
    const total = (this.vm.diskGiB ?? this.diskGiB) * 1024;
    this.disk.usedMiB = Math.max(0, total - free);
    await this.#save();
  }

  /** Free disk for a run: the VM's (measured while it runs, estimated while stopped), at most what the host has for its disk image to grow into. */
  async diskFreeMiB() {
    await this.#measureDisk().catch(() => {});
    const host = await freeDiskMiB(this.home);
    const total = Math.max(this.diskGiB, this.vm.diskGiB ?? 0) * 1024;
    const vmFree = this.vm.state === "running" && this.disk.freeMiB !== null ? this.disk.freeMiB : total - (this.disk.usedMiB ?? 0);
    return host === null ? vmFree : Math.min(vmFree, host);
  }

  async version() {
    if (this.versionText) return this.versionText;
    const { stdout } = await this.colima(["version"], { timeoutMs: 15_000 });
    this.versionText = stdout.match(/colima version\s+(\S+)/)?.[1] ?? stdout.split("\n")[0].trim();
    return this.versionText;
  }

  /**
   * Capacity is the cap, not the current VM (§3.5): the VM is resized to fit.
   * `vm` says what runs now, and its measured boot time.
   */
  async facts() {
    const vm = await this.status();
    let dockerVersion = null;
    if (vm.state === "running") dockerVersion = (await this.docker.facts().catch(() => null))?.version ?? null;
    return {
      kind: "colima",
      version: `colima ${await this.version().catch(() => "unknown")}${dockerVersion ? `, docker ${dockerVersion}` : ""}`,
      cpus: this.caps.cpus,
      memoryMiB: this.caps.memoryMiB,
      diskFreeMiB: await this.diskFreeMiB(),
      vm: {
        kind: "colima", profile: this.profile, state: vm.state, cpus: vm.state === "running" ? vm.cpus : null,
        memoryMiB: vm.state === "running" ? vm.memoryMiB : null, overheadMiB: VM_OVERHEAD_MIB, bootSeconds: this.bootSeconds,
      },
    };
  }

  selfTest(image) {
    return this.docker.selfTest(image);
  }
}

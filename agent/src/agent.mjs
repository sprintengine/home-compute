// The agent (§4): adopts what it was running before a restart, sends what
// waits in the outbox, then syncs with hc-core at the interval the server
// sets, taking the claims it is given and supervising each run. On 5xx, 429
// or 1027 it backs off exponentially with jitter (at most 5 minutes) while
// its containers carry on; on 401/403 it claims nothing more, finishes what
// it runs and keeps the results; on 426 it waits for an update (M7). Beside
// the sync loop, a runtime with a VM (Colima) gets lifecycle steps (§4.4):
// pre-warm before an upcoming slot, resize while empty, stop when idle.

import { PROTOCOL } from "../../src/core/protocol.mjs";
import { systemClock } from "./clock.mjs";
import { ControlPlaneClient, ControlPlaneError } from "./client.mjs";
import { fitSyncBody } from "./fit.mjs";
import { Outbox } from "./outbox.mjs";
import { assertRuntime } from "./runtime/runtime.mjs";
import { RunSupervisor } from "./supervisor.mjs";
import { AGENT_VERSION } from "./version.mjs";

export const MAX_BACKOFF_MS = 300_000;
const MIN_SYNC_MS = 1_000;
const MAX_SYNC_MS = 300_000;
/** Revoked: look at the credential file again this often (a re-enrolment replaces it). */
const REVOKED_RECHECK_MS = 30 * 60_000;
const UPGRADE_RECHECK_MS = 60 * 60_000;
/** A phase change syncs early (so the server stamps it), but not more than once per this. */
const PHASE_SYNC_GAP_MS = 2_000;
/** Runtime start failures in a row before the machine reports its VM as failed (§4.4). */
const READY_FAILURES_UNHEALTHY = 3;
const DEFAULT_MAX_RUNS = 2;
const CLOCK_SKEW_WARNING_MS = 30_000;
/** While the runtime counts as failed, how often to try starting it again (nothing else would). */
const RUNTIME_PROBE_MS = 5 * 60_000;
/** The VM lifecycle looks again at least this often, and at most once a second. */
const VM_TICK_MAX_MS = 30_000;
const VM_TICK_MIN_MS = 1_000;
const MAX_ERROR_CHARS = 300;
/** Complete answers worth sending again later: a timeout, or the server's "it changed meanwhile; send it again". */
const RETRY_COMPLETE = new Set([408, 409]);
/** Complete answers that mean the server no longer knows the run: nothing left to deliver. */
const GONE = new Set([404, 410]);

function clip(text) {
  if (text === null || text === undefined) return null;
  const value = String(text);
  return value.length > MAX_ERROR_CHARS ? `${value.slice(0, MAX_ERROR_CHARS - 1)}…` : value;
}

/** Exponential backoff with jitter: between half and all of min(5 min, 2^failures s). */
export function backoffDelay(failures, random = Math.random) {
  const ceiling = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(Math.max(failures, 1), 20));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

/** One JSON line per event on stdout: what launchd and journald keep. */
export function jsonLog(event, fields = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}

function iso(time) {
  return time === null || time === undefined ? null : new Date(time).toISOString();
}

export class Agent {
  constructor({ state, config, credential, runtime, clock = systemClock, fetch = globalThis.fetch, log = jsonLog, random = Math.random, caffeinate = null }) {
    this.state = state;
    this.config = config;
    this.credential = credential;
    this.runtime = assertRuntime(runtime);
    this.clock = clock;
    this.log = log;
    this.random = random;
    this.caffeinate = caffeinate;
    this.lastFacts = null;
    this.vmDecision = null;
    this.vmWakeup = null;
    this.client = new ControlPlaneClient({ server: config.server, credential: () => this.credential, fetch });
    this.outbox = new Outbox(state);
    /** Run id → its supervisor, until the control plane has its result. */
    this.runs = new Map();
    this.env = new Map();
    this.connection = "starting";
    this.lastSyncAt = null;
    this.nextSyncAt = null;
    this.lastError = null;
    this.clockSkewMs = null;
    this.upcoming = [];
    this.serverConfig = null;
    this.drain = false;
    this.revoked = false;
    this.upgradeRequired = false;
    this.runtimeOk = true;
    this.runtimeError = null;
    this.readyFailures = 0;
    this.failures = 0;
    this.stopped = false;
    this.killed = false;
    this.syncing = null;
    this.flushing = null;
    this.pending = new Set();
    this.wakeup = null;
  }

  /** Before the first sync: local state, the env file, old logs pruned, containers adopted, the outbox sent. */
  async start() {
    await this.state.ensure();
    this.drain = Boolean((await this.state.readLocalState()).drain);
    this.env = await this.state.readEnv(this.config);
    await this.state.pruneLogs(this.clock.now()).catch(() => 0);
    await this.adopt();
    await this.flushOutbox();
  }

  #track(promise) {
    const tracked = Promise.resolve(promise).catch((error) => this.log("agent_error", { error: error.message }));
    this.pending.add(tracked);
    tracked.finally(() => this.pending.delete(tracked));
    return tracked;
  }

  /** Waits until no run, send or sync started so far is still in flight (tests, and a clean shutdown). */
  async idle() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  #supervisor(claim) {
    return new RunSupervisor({
      claim, runtime: this.runtime, state: this.state, outbox: this.outbox, clock: this.clock, config: this.config,
      env: this.env, log: this.log,
      events: {
        phase: () => this.#phaseChanged(),
        finished: () => {
          this.#runsChanged();
          this.#track(this.flushOutbox());
        },
        runtimeError: (error) => {
          // A VM without room beside running containers is not a failed start.
          if (error.countsAsFailure === false) return;
          this.readyFailures += 1;
          this.runtimeError = clip(error.message);
          this.lastProbeAt = this.clock.now();
        },
        runtimeReady: () => {
          this.readyFailures = 0;
        },
      },
    });
  }

  /**
   * Containers labelled with a run id are this agent's (§3.4): each is
   * supervised again from its local record (its spec and start time). A
   * record whose container is gone settles the run as failed. A container
   * whose result is already in the outbox is only removed.
   */
  async adopt() {
    const records = await this.state.readRunRecords();
    for (const handle of await this.runtime.adopt({ expected: records.size })) {
      const runId = handle.runId;
      if (!runId || this.runs.has(runId)) continue;
      const record = records.get(runId) ?? null;
      records.delete(runId);
      if (await this.outbox.get(runId)) {
        await handle.remove?.();
        await this.state.removeRunRecord(runId);
        continue;
      }
      const claim = record?.claim ?? { run: { id: runId, jobId: handle.jobId }, spec: { resources: {}, runSeconds: 7 * 86_400 } };
      const supervisor = this.#supervisor({ ...claim, spec: { ...claim.spec, secretEnv: {} } });
      this.runs.set(runId, supervisor);
      this.#track(supervisor.adopt(handle, record));
      this.log("run_adopted", { run: runId, job: supervisor.jobId, container: handle.id });
    }
    for (const [runId, record] of records) {
      if (this.runs.has(runId)) continue;
      if (await this.outbox.get(runId)) {
        await this.state.removeRunRecord(runId);
        continue;
      }
      const supervisor = this.#supervisor({ ...record.claim, spec: { ...record.claim.spec, secretEnv: {} } });
      this.runs.set(runId, supervisor);
      this.#track(supervisor.orphaned());
      this.log("run_orphaned", { run: runId });
    }
    this.#runsChanged();
  }

  /** Runs that are not finished: what holds the VM, the Mac awake and a run slot. */
  activeRuns() {
    return [...this.runs.values()].filter((run) => !run.finished);
  }

  /**
   * Something started or finished: tell the runtime what it holds (the VM is
   * sized for it), hold the Mac awake while anything runs (§4.4), prune old
   * images when nothing does (§4.5), and let the VM lifecycle look again.
   */
  #runsChanged() {
    const active = this.activeRuns();
    this.runtime.setContext?.({ runs: active.map((run) => run.resources), busy: active.length > 0 });
    if (active.length) this.caffeinate?.hold();
    else {
      this.caffeinate?.release();
      if (this.runs.size === 0 || [...this.runs.values()].every((run) => run.finished)) {
        if (this.runtime.idle && !this.killed) this.#track(this.runtime.idle());
      }
    }
    this.vmWakeup?.abort();
  }

  /** The idle and keep-warm times: the machine's own colima settings win over the control plane's `config`. */
  vmConfig() {
    const local = this.config.colima ?? {};
    const server = this.serverConfig ?? {};
    return {
      idleStopSeconds: local.idleStopSeconds ?? server.idleStopSeconds ?? 300,
      keepWarmSeconds: local.keepWarmSeconds ?? server.keepWarmSeconds ?? 600,
    };
  }

  /**
   * One VM lifecycle step (§4.4), for a runtime that has one: pre-warm,
   * resize or stop as the runtime decides from the runs and upcoming slots.
   * A failed pre-warm counts toward the three failed starts that make the
   * machine unhealthy; once it is, only the 5-minute probe starts the VM.
   */
  async lifecycleTick() {
    if (!this.runtime.tick || this.killed) return null;
    const active = this.activeRuns();
    this.runtime.setContext?.({ runs: active.map((run) => run.resources), busy: active.length > 0, upcoming: this.upcoming, config: this.vmConfig() });
    const decision = await this.runtime.tick({ mayStart: this.readyFailures < READY_FAILURES_UNHEALTHY });
    this.vmDecision = decision;
    if (decision.action !== "none") {
      this.log(decision.error ? "vm_error" : `vm_${decision.action}`, { reason: decision.reason, ...(decision.error ? { error: decision.error.message } : {}) });
    }
    if (decision.error && (decision.action === "start" || decision.action === "resize")) {
      if (decision.error.countsAsFailure !== false) this.readyFailures += 1;
      this.runtimeError = clip(decision.error.message);
      this.lastProbeAt = this.clock.now();
    } else if (decision.action === "start" || decision.action === "resize") {
      this.readyFailures = 0;
      this.runtimeError = null;
    }
    return decision;
  }

  async #vmLoop() {
    while (!this.stopped) {
      let decision = null;
      try {
        decision = await this.lifecycleTick();
      } catch (error) {
        this.log("vm_error", { error: error.message });
      }
      if (this.stopped) return;
      const until = (decision?.wakeAt ?? Infinity) - this.clock.now();
      this.vmWakeup = new AbortController();
      await this.clock.sleep(Math.min(VM_TICK_MAX_MS, Math.max(VM_TICK_MIN_MS, until)), this.vmWakeup.signal);
      this.vmWakeup = null;
    }
  }

  /** What this machine can take now: its caps (or what the runtime has) less what its runs hold. */
  free(facts) {
    const caps = this.config.caps ?? {};
    const active = this.activeRuns();
    let cpus = caps.cpus ?? facts?.cpus ?? 0;
    let memoryMiB = caps.memoryMiB ?? facts?.memoryMiB ?? 0;
    for (const run of active) {
      cpus -= run.resources.cpus ?? 0;
      memoryMiB -= run.resources.memoryMiB ?? 0;
    }
    // A VM holding containers cannot be resized (§4.4): until they finish, a run must fit the VM as it is.
    const vm = facts?.vm;
    if (vm?.state === "running" && active.length && vm.memoryMiB) {
      const held = active.reduce((total, run) => total + (run.resources.memoryMiB ?? 0), 0);
      memoryMiB = Math.min(memoryMiB, vm.memoryMiB - (vm.overheadMiB ?? 0) - held);
      if (vm.cpus) cpus = Math.min(cpus, vm.cpus);
    }
    const disk = facts?.diskFreeMiB ?? 0;
    // Never below zero: a run the server sent again, or a runtime that did not answer, must not make a body it refuses.
    return {
      cpus: Math.max(0, Math.round(cpus * 1000) / 1000),
      memoryMiB: Math.max(0, memoryMiB),
      diskMiB: Math.max(0, typeof caps.diskMiB === "number" ? Math.min(caps.diskMiB, disk) : disk),
      runs: Math.max(0, (caps.maxRuns ?? DEFAULT_MAX_RUNS) - active.length),
    };
  }

  health() {
    const bootSeconds = this.lastFacts?.vm?.bootSeconds;
    return {
      docker: this.runtimeOk ? "ok" : "unreachable",
      lastError: clip(this.runtimeError),
      ...(this.readyFailures >= READY_FAILURES_UNHEALTHY ? { vm: "failed" } : {}),
      ...(typeof bootSeconds === "number" ? { vmBootSeconds: bootSeconds } : {}),
    };
  }

  /** One sync. Concurrent callers share the one in flight. Throws a ControlPlaneError when it fails. */
  syncOnce() {
    if (!this.syncing) this.syncing = this.#sync().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  /**
   * After three failed starts the machine reports its VM as failed and is
   * given nothing, so no run would ever try the runtime again: try it here
   * every 5 minutes, and clear the failure when it starts.
   */
  async #probeRuntime() {
    if (this.readyFailures < READY_FAILURES_UNHEALTHY || this.runs.size) return;
    if (this.lastProbeAt && this.clock.now() - this.lastProbeAt < RUNTIME_PROBE_MS) return;
    this.lastProbeAt = this.clock.now();
    try {
      await this.runtime.ensureReady({ cpus: 1, memoryMiB: 512 });
      this.readyFailures = 0;
      this.runtimeError = null;
      this.log("runtime_recovered", {});
    } catch (error) {
      this.runtimeError = clip(error.message);
    }
  }

  async #sync() {
    await this.#probeRuntime();
    let facts = null;
    try {
      facts = await this.runtime.facts();
      this.lastFacts = facts;
      this.runtimeOk = true;
    } catch (error) {
      this.runtimeOk = false;
      this.runtimeError = clip(error.message);
    }
    const entries = [...this.runs.values()].map((run) => run.syncEntry());
    const reported = new Set(entries.map(({ entry }) => entry.id));
    // A result still in the outbox keeps its run's lease alive (it is "reporting") until the server has it.
    for (const id of await this.outbox.ids()) if (!reported.has(id)) entries.push({ entry: { id, phase: "reporting" }, version: null });
    const free = this.free(facts);
    const claim = !this.drain && !this.revoked && !this.upgradeRequired && !this.killed && this.runtimeOk
      && this.readyFailures < READY_FAILURES_UNHEALTHY && free.runs > 0;
    const body = {
      agentVersion: AGENT_VERSION,
      agentTime: this.clock.now(),
      machine: { drain: this.drain, vm: facts?.vm ?? { kind: facts?.kind ?? "unknown", state: null }, free, health: this.health() },
      runs: entries.map(({ entry }) => entry),
      claim,
    };
    fitSyncBody(body);
    const sentAt = this.clock.now();
    const sentMono = this.clock.monotonic();
    let response;
    try {
      ({ body: response } = await this.client.sync(body));
    } catch (error) {
      this.#failed(error);
      throw error;
    }
    if (this.killed) return response;
    const roundTrip = this.clock.monotonic() - sentMono;
    this.failures = 0;
    this.connection = "online";
    this.revoked = false;
    this.upgradeRequired = false;
    this.lastError = null;
    this.lastSyncAt = this.clock.now();
    if (typeof response.serverTime === "number") this.clockSkewMs = Math.round(this.clock.now() - roundTrip / 2 - response.serverTime);
    for (const { entry, version } of entries) this.runs.get(entry.id)?.tailSent(version);
    for (const offered of response.claims ?? []) this.#accept(offered);
    for (const id of response.cancel ?? []) this.runs.get(id)?.cancel();
    if (response.rotateCredential?.credential) await this.#rotate(response.rotateCredential.credential);
    this.upcoming = response.upcoming ?? [];
    this.serverConfig = response.config ?? null;
    this.vmWakeup?.abort();
    if (response.claims?.length || response.cancel?.length) {
      this.log("sync", { claims: response.claims.map((entry) => entry.run.id), cancel: response.cancel, next: response.nextSyncInMs, sentAt: iso(sentAt) });
    }
    if ((await this.outbox.ids()).length) this.#track(this.flushOutbox());
    return response;
  }

  #failed(error) {
    this.lastError = error.message;
    if (error instanceof ControlPlaneError && error.kind === "revoked") {
      if (!this.revoked) this.log("revoked", { error: error.message });
      this.revoked = true;
      this.connection = "revoked";
    } else if (error instanceof ControlPlaneError && error.kind === "upgrade") {
      if (!this.upgradeRequired) this.log("upgrade_required", { error: error.message });
      this.upgradeRequired = true;
      this.connection = "upgrade-required";
    } else {
      this.failures += 1;
      this.connection = "offline";
    }
  }

  #accept(claim) {
    if (this.runs.has(claim.run.id)) return;
    const supervisor = this.#supervisor(claim);
    this.runs.set(claim.run.id, supervisor);
    this.log("run_claimed", { run: claim.run.id, job: claim.run.jobId, attempt: claim.run.attempt, image: claim.spec.image });
    this.#track(supervisor.start());
    this.#runsChanged();
  }

  async #rotate(credential) {
    // Stored before it is used: if the write failed, the old one still works and the server offers another.
    await this.state.writeCredential(credential);
    this.credential = credential;
    this.log("credential_rotated", {});
  }

  /** Sends every result in the outbox; stops at the first that cannot go now (it stays for later). */
  flushOutbox() {
    if (this.flushing) {
      this.flushAgain = true;
      return this.flushing;
    }
    this.flushing = (async () => {
      do {
        this.flushAgain = false;
        for (const id of await this.outbox.ids()) {
          if (this.killed) return;
          const record = await this.outbox.get(id);
          if (!record) continue;
          if (record.unreadable) {
            this.log("run_report_unreadable", { run: id });
            await this.outbox.quarantine(id);
            this.runs.delete(id);
            continue;
          }
          try {
            const { body } = await this.client.complete(id, record);
            await this.outbox.remove(id);
            this.runs.delete(id);
            this.log("run_reported", { run: id, state: body.state, recovered: body.recovered || undefined, duplicate: body.duplicate || undefined });
          } catch (error) {
            if (error instanceof ControlPlaneError && error.kind === "rejected" && !RETRY_COMPLETE.has(error.status)) {
              // The server will never take it as it is. A run it no longer knows needs nothing more; anything
              // else is kept aside in outbox/rejected/ for a person, never just deleted.
              this.log("run_report_rejected", { run: id, status: error.status, error: error.message });
              if (GONE.has(error.status)) await this.outbox.remove(id);
              else await this.outbox.quarantine(id);
              this.runs.delete(id);
              continue;
            }
            if (!(error instanceof ControlPlaneError && error.kind === "rejected")) this.#failed(error);
            return;
          }
        }
      } while (this.flushAgain && !this.killed);
    })().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  #phaseChanged() {
    if (this.connection !== "online" || this.lastSyncAt === null) return;
    if (this.clock.now() - this.lastSyncAt >= PHASE_SYNC_GAP_MS) this.wake();
  }

  /** Ends the current wait between syncs early. */
  wake() {
    this.wakeup?.abort();
  }

  async #reloadCredential() {
    const stored = await this.state.readCredential().catch(() => null);
    if (stored && stored !== this.credential) {
      this.credential = stored;
      this.revoked = false;
      this.log("credential_reloaded", {});
    }
  }

  /** The service loop: sync, wait as long as the server said (or back off), again, until stop(). */
  async run() {
    this.stopped = false;
    const vmLoop = this.runtime.tick ? this.#vmLoop() : null;
    while (!this.stopped) {
      let delay;
      try {
        const response = await this.syncOnce();
        delay = Math.min(MAX_SYNC_MS, Math.max(MIN_SYNC_MS, response.nextSyncInMs ?? 30_000));
      } catch (error) {
        if (error instanceof ControlPlaneError && error.kind === "revoked") delay = REVOKED_RECHECK_MS;
        else if (error instanceof ControlPlaneError && error.kind === "upgrade") delay = UPGRADE_RECHECK_MS;
        else {
          if (!(error instanceof ControlPlaneError)) {
            this.#failed(error);
            this.log("sync_error", { error: error.message });
          }
          delay = backoffDelay(this.failures, this.random);
          this.log("backoff", { failures: this.failures, delayMs: delay, error: error.message });
        }
      }
      if (this.stopped) break;
      this.nextSyncAt = this.clock.now() + delay;
      this.wakeup = new AbortController();
      await this.clock.sleep(delay, this.wakeup.signal);
      this.wakeup = null;
      if (this.revoked) await this.#reloadCredential();
    }
    this.vmWakeup?.abort();
    await vmLoop;
  }

  /** Stops syncing. Containers keep running and are adopted by the next start. */
  async stop() {
    this.stopped = true;
    this.wake();
    this.vmWakeup?.abort();
  }

  /**
   * Lets go of the runs without touching their containers (a service stop):
   * their timers end, so the process can exit, and the next start adopts them.
   */
  detach() {
    for (const run of this.runs.values()) if (!run.finished) run.abandon();
    this.caffeinate?.release();
  }

  /** For tests: as if the process were killed: no more syncs, sends or results from this object. */
  kill() {
    this.killed = true;
    this.stopped = true;
    for (const run of this.runs.values()) run.abandon();
    this.caffeinate?.release();
    this.wake();
    this.vmWakeup?.abort();
  }

  async setDrain(drain) {
    this.drain = Boolean(drain);
    await this.state.writeLocalState({ ...(await this.state.readLocalState()), drain: this.drain });
    this.log(this.drain ? "drain_on" : "drain_off", {});
    this.wake();
  }

  /** What the local status server shows (§4.7): read-only, no secrets. */
  async status() {
    const outbox = await this.outbox.ids();
    return {
      agentVersion: AGENT_VERSION,
      protocol: PROTOCOL,
      machineId: this.config.machineId,
      name: this.config.name,
      server: this.config.server,
      connection: this.connection,
      drain: this.drain,
      revoked: this.revoked,
      upgradeRequired: this.upgradeRequired,
      lastSyncAt: iso(this.lastSyncAt),
      nextSyncAt: iso(this.nextSyncAt),
      lastError: this.lastError,
      clockSkewMs: this.clockSkewMs,
      ...(Math.abs(this.clockSkewMs ?? 0) > CLOCK_SKEW_WARNING_MS ? { clockSkewWarning: true } : {}),
      runtime: {
        kind: this.config.runtime, ok: this.runtimeOk, lastError: this.runtimeError, health: this.health(), vm: this.lastFacts?.vm ?? null,
        lifecycle: this.vmDecision ? { action: this.vmDecision.action, reason: this.vmDecision.reason, wakeAt: iso(this.vmDecision.wakeAt) } : null,
        awake: this.caffeinate ? this.caffeinate.holding : null,
      },
      runs: [...this.runs.values()].map((run) => ({
        id: run.id, job: run.jobId, phase: run.finished ? "reporting" : run.phase, since: iso(run.phaseAt),
        peakMemoryBytes: run.stats.peakMemoryBytes, waitingToReport: run.finished,
      })),
      outbox: outbox.length,
      upcoming: this.upcoming,
    };
  }
}

// One run on this machine, from claim to outbox (§3.1, §4.3, §4.6):
//
//   claimed → (starting-vm, while the runtime boots) → (pulling, only when the
//   image is missing) → running → reporting
//
// Phase times are the server's; this keeps durations from the monotonic
// clock. While running it samples stats, captures output (redacted on
// arrival), enforces `runSeconds` from container start (stop, then kill) and
// honours a cancel. At the end it extracts the error, writes the final
// record to the outbox, and only then removes the container.

import { boundedReports } from "../../src/core/history.mjs";
import { extractError } from "../../src/core/logs.mjs";
import { JOB_LABEL, MAX_ERROR_DETAIL, RUN_LABEL } from "../../src/core/protocol.mjs";
import { runOutcome } from "../../src/core/reports.mjs";
import { LogCapture } from "./capture.mjs";
import { specRefusal } from "./policy.mjs";

const MIB = 1048576;
const LOG_DRAIN_MS = 5_000;
/** After a stop's grace (when the runtime should have killed it), how long more before the container is given up on. */
const STOP_GIVE_UP_MS = 10_000;
const PULL_TIMED_OUT = Symbol("pull timed out");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

export class RunSupervisor {
  /**
   * `claim`: `{run, spec}` from a sync. `env`: the local secrets file
   * (`local:` references). `events`: `{phase(supervisor), finished(supervisor),
   * runtimeError(error), runtimeReady()}` for the agent, all optional.
   */
  constructor({ claim, runtime, state, outbox, clock, config, env = new Map(), log = () => {}, events = {} }) {
    this.claim = claim;
    this.id = claim.run.id;
    this.jobId = claim.run.jobId;
    this.spec = claim.spec;
    Object.assign(this, { runtime, state, outbox, clock, config, env, log, events });
    this.phase = "claimed";
    this.phaseAt = clock.now();
    this.finished = false;
    this.record = null;
    this.cancelRequested = false;
    this.aborted = false;
    this.handle = null;
    this.capture = null;
    this.timedOut = false;
    this.digest = null;
    this.vmWaitMs = 0;
    this.pullMs = 0;
    this.stats = {
      peakMemoryBytes: null, memoryLimitBytes: (this.spec.resources?.memoryMiB ?? 0) * MIB || null,
      cpuPct: null, peakCpuPct: null, cpuSum: 0, cpuSeconds: null, samples: 0,
    };
    this.exit = new AbortController();
    this.giveUp = deferred();
  }

  get resources() {
    return this.spec.resources ?? {};
  }

  setPhase(phase) {
    if (this.phase === phase) return;
    this.phase = phase;
    this.phaseAt = this.clock.now();
    this.events.phase?.(this);
  }

  /** The run as the next sync reports it, and the tail version that sync carries (if any). */
  syncEntry() {
    const tail = this.finished ? null : this.capture?.pendingTail() ?? null;
    const entry = {
      id: this.id,
      phase: this.finished ? "reporting" : this.phase,
      phaseAt: this.phaseAt,
      stats: { peakMemoryBytes: this.stats.peakMemoryBytes, memoryLimitBytes: this.stats.memoryLimitBytes, cpuPct: this.stats.cpuPct },
    };
    if (tail) {
      const { version, ...logTail } = tail;
      entry.logTail = logTail;
      return { entry, version };
    }
    return { entry, version: null };
  }

  tailSent(version) {
    if (version !== null) this.capture?.markSent(version);
  }

  /** A run the server just gave this machine. */
  start() {
    this.done = this.#run().catch((error) => this.#crashed(error));
    return this.done;
  }

  /** A container found running (or exited) after a restart, with what was recorded when it started. */
  adopt(handle, record) {
    this.handle = handle;
    this.digest = record?.digest ?? null;
    this.vmWaitMs = record?.vmWaitMs ?? 0;
    this.pullMs = record?.pullMs ?? 0;
    this.startedWall = record?.startedAt ?? this.clock.now();
    this.startedMono = this.clock.monotonic() - Math.max(0, this.clock.now() - this.startedWall);
    // Secret values delivered with the claim lived only in the old process; local ones are read again.
    const secrets = (this.spec.localEnv ?? []).map(({ from }) => this.env.get(from)).filter(Boolean);
    // The runtime replays the container's whole log, so the local copy is written afresh.
    this.capture = new LogCapture({ secrets, file: this.state.logPath(this.id), append: false });
    this.phase = "running";
    this.done = this.#supervise().catch((error) => this.#crashed(error));
    return this.done;
  }

  /** A run recorded as started whose container is gone (a reboot, say): failed, exit unknown. */
  orphaned() {
    this.capture = new LogCapture({});
    this.done = this.#finish({ error: "the agent restarted and the container was gone; its exit is unknown" })
      .catch((error) => this.#crashed(error));
    return this.done;
  }

  /** The server cancelled the run: stop it if it runs, and settle it as cancelled. */
  cancel() {
    if (this.cancelRequested || this.finished) return;
    this.cancelRequested = true;
    this.log("run_cancelling", { run: this.id, phase: this.phase });
    if (this.handle) this.#stopContainer();
  }

  /** For tests (and a crash): drop everything without a result, as a killed process would. */
  abandon() {
    this.aborted = true;
    this.exit.abort();
  }

  async #run() {
    const { spec } = this;
    const refusal = specRefusal(spec, this.config);
    if (refusal) return this.#finish({ error: `refused by this machine's policy: ${refusal}` });
    const local = {};
    for (const { name, from } of spec.localEnv ?? []) {
      const value = this.env.get(from);
      if (value === undefined) return this.#finish({ error: `the local secret ${from} is not set in this machine's env file` });
      local[name] = value;
    }
    const secretEnv = { ...(spec.secretEnv ?? {}), ...local };
    this.capture = new LogCapture({ secrets: Object.values(secretEnv), file: this.state.logPath(this.id) });

    const facts = await this.runtime.facts().catch(() => null);
    if (facts?.vm && facts.vm.state !== "running") this.setPhase("starting-vm");
    const vmStarted = this.clock.monotonic();
    try {
      await this.runtime.ensureReady({ cpus: this.resources.cpus, memoryMiB: this.resources.memoryMiB });
      this.events.runtimeReady?.();
    } catch (error) {
      this.events.runtimeError?.(error);
      return this.#finish({ error: `the container runtime is not ready: ${error.message}` });
    }
    if (this.phase === "starting-vm") this.vmWaitMs = Math.round(this.clock.monotonic() - vmStarted);
    if (this.cancelRequested) return this.#finish({ cancelled: true });
    if (this.aborted) return null;

    if (await this.runtime.hasImage(spec.image)) {
      this.digest = spec.image.includes("@") ? spec.image.slice(spec.image.indexOf("@") + 1) : null;
    } else {
      this.setPhase("pulling");
      const pullStarted = this.clock.monotonic();
      const timeout = new AbortController();
      try {
        const result = await Promise.race([
          this.runtime.pull(spec.image, { auth: null }),
          this.clock.sleep(this.config.pullTimeoutSeconds * 1000, timeout.signal).then(() => PULL_TIMED_OUT),
        ]);
        if (result === PULL_TIMED_OUT) {
          return this.#finish({ error: `pull timed out after ${Math.round(this.config.pullTimeoutSeconds / 60)} min` });
        }
        this.digest = result.digest ?? null;
      } catch (error) {
        return this.#finish({ error: `pull failed: ${error.message}` });
      } finally {
        timeout.abort();
      }
      this.pullMs = Math.round(this.clock.monotonic() - pullStarted);
    }
    if (this.cancelRequested) return this.#finish({ cancelled: true });
    if (this.aborted) return null;

    this.handle = await this.runtime.run({
      runId: this.id,
      jobId: this.jobId,
      image: spec.image,
      entrypoint: spec.entrypoint ?? null,
      args: spec.args ?? [],
      env: spec.env ?? {},
      secretEnv,
      resources: this.resources,
      network: spec.network ?? "bridge",
      labels: { [RUN_LABEL]: this.id, [JOB_LABEL]: this.jobId },
    });
    this.startedWall = this.clock.now();
    this.startedMono = this.clock.monotonic();
    await this.state.writeRunRecord(this.id, {
      // Never a secret value on disk: secretEnv keeps only its names.
      claim: { run: this.claim.run, spec: { ...spec, secretEnv: Object.keys(spec.secretEnv ?? {}) } },
      containerId: this.handle.id, startedAt: this.startedWall, vmWaitMs: this.vmWaitMs, pullMs: this.pullMs, digest: this.digest,
    });
    this.setPhase("running");
    return this.#supervise();
  }

  async #supervise() {
    const { handle } = this;
    const signal = this.exit.signal;
    const pump = (async () => {
      try {
        for await (const line of handle.logs) {
          if (this.aborted) return;
          this.capture.push(line);
        }
      } catch (error) {
        this.log("log_error", { run: this.id, error: error.message });
      }
    })();
    const interval = this.config.statsIntervalSeconds * 1000;
    const sampling = (async () => {
      for (;;) {
        await this.clock.sleep(interval, signal);
        if (signal.aborted) return;
        try {
          this.#sample(await handle.stats());
        } catch {
          // A container that just exited has no stats; the loop ends with it.
        }
      }
    })();
    const deadline = this.startedWall + (this.spec.runSeconds ?? 3600) * 1000;
    const timer = (async () => {
      while (!signal.aborted && this.clock.now() < deadline) await this.clock.sleep(deadline - this.clock.now(), signal);
      if (signal.aborted) return;
      this.timedOut = true;
      this.log("run_timed_out", { run: this.id, runSeconds: this.spec.runSeconds });
      this.#stopContainer();
    })();
    if (this.cancelRequested) this.#stopContainer();

    const result = await Promise.race([handle.wait(), this.giveUp.promise]);
    this.endMono = this.clock.monotonic();
    this.exit.abort();
    await Promise.all([sampling, timer]);
    if (this.aborted) return null;
    const drained = new AbortController();
    await Promise.race([pump, this.clock.sleep(LOG_DRAIN_MS, drained.signal)]);
    drained.abort();
    return this.#finish({
      exitCode: result.exitCode ?? null,
      oomKilled: Boolean(result.oomKilled),
      timedOut: this.timedOut,
      cancelled: this.cancelRequested && !this.timedOut,
      error: result.unstoppable ? "the container did not stop when told to; it may still be running" : null,
      keepContainer: Boolean(result.unstoppable),
    });
  }

  #stopContainer() {
    if (this.stopping || !this.handle) return;
    this.stopping = true;
    const grace = this.config.stopGraceSeconds;
    this.handle.stop(grace).catch((error) => this.log("stop_error", { run: this.id, error: error.message }));
    // Stop, then kill (the runtime's job after `grace`); a container still there after that is given up on.
    this.clock.sleep(grace * 1000 + STOP_GIVE_UP_MS, this.exit.signal).then(() => {
      if (!this.exit.signal.aborted) this.giveUp.resolve({ exitCode: null, oomKilled: false, unstoppable: true });
    });
  }

  #sample(sample) {
    if (!sample) return;
    const { stats } = this;
    if (typeof sample.memoryBytes === "number") stats.peakMemoryBytes = Math.max(stats.peakMemoryBytes ?? 0, sample.memoryBytes);
    if (typeof sample.memoryLimitBytes === "number" && sample.memoryLimitBytes > 0) stats.memoryLimitBytes = sample.memoryLimitBytes;
    if (typeof sample.cpuPct === "number") {
      stats.cpuPct = sample.cpuPct;
      stats.peakCpuPct = Math.max(stats.peakCpuPct ?? 0, sample.cpuPct);
      stats.cpuSum += sample.cpuPct;
    }
    if (typeof sample.cpuSeconds === "number") stats.cpuSeconds = sample.cpuSeconds;
    stats.samples += 1;
  }

  async #finish({ exitCode = null, oomKilled = false, timedOut = false, cancelled = false, error = null, keepContainer = false }) {
    if (this.aborted || this.finished) return null;
    this.setPhase("reporting");
    const reports = boundedReports(this.capture?.reports ?? []);
    let message = error;
    let detail = null;
    const failedEarly = Boolean(error) && exitCode === null && !cancelled;
    if (!cancelled && !message) {
      const outcome = runOutcome({ exitCode, oomKilled, timedOut, reports, report: this.spec.report });
      if (outcome === "failed") {
        ({ error: message, errorDetail: detail } = extractError(this.capture?.recentLines() ?? [], {
          reports, oomKilled, memoryLimitBytes: this.stats.memoryLimitBytes, timedOut, runSeconds: this.spec.runSeconds, exitCode,
          maxDetail: MAX_ERROR_DETAIL,
        }));
      }
    }
    const { stats } = this;
    const record = {
      exitCode,
      oomKilled,
      timedOut,
      cancelled,
      failed: failedEarly,
      error: message,
      errorDetail: detail,
      reports,
      logTail: this.capture ? this.capture.finalTail() : { text: "", bytesTotal: 0, linesTotal: 0, truncated: false },
      stats: {
        peakMemoryBytes: stats.peakMemoryBytes,
        memoryLimitBytes: stats.memoryLimitBytes,
        avgCpuPct: stats.samples ? Math.round((stats.cpuSum / stats.samples) * 10) / 10 : null,
        peakCpuPct: stats.peakCpuPct,
        cpuSeconds: stats.cpuSeconds,
        samples: stats.samples,
      },
      durations: {
        durationMs: this.startedMono === undefined ? null : Math.round((this.endMono ?? this.clock.monotonic()) - this.startedMono),
        vmWaitMs: this.vmWaitMs,
        pullMs: this.pullMs,
      },
      image: { ref: this.spec.image ?? null, digest: this.digest },
    };
    await this.capture?.close();
    if (this.aborted) return null;
    // Written before it is sent, deleted only after a 2xx (§4.2).
    await this.outbox.put(this.id, record);
    this.record = record;
    this.finished = true;
    if (this.handle && !keepContainer) await this.handle.remove?.().catch((removal) => this.log("remove_error", { run: this.id, error: removal.message }));
    await this.state.removeRunRecord(this.id);
    this.log("run_finished", { run: this.id, job: this.jobId, exitCode, oomKilled, timedOut, cancelled, error: message });
    this.events.finished?.(this);
    return record;
  }

  async #crashed(error) {
    this.log("run_error", { run: this.id, error: error.message });
    if (!this.finished && !this.aborted) await this.#finish({ error: `the agent failed while running it: ${error.message}` }).catch(() => {});
  }
}

// FakeRuntime (§4.3): containers that follow a script instead of running an
// image. Tests use it to drive every path of a run (lines, exit codes,
// memory samples, delays, OOM kills, hangs, slow stops, a VM that boots or
// fails), and `runtime: "fake"` lets a developer run the agent end to end
// without Docker. Its containers outlive the agent object that started them,
// as Docker's outlive the agent process, so adopt-on-restart can be tested.

import { createHash } from "node:crypto";
import { JOB_LABEL, RUN_LABEL } from "../../../src/core/protocol.mjs";
import { systemClock } from "../clock.mjs";

const DEFAULT_SCRIPT = { output: ["hello from the fake runtime"], exitCode: 0 };
const MIB = 1048576;

/**
 * One scripted container. A script is `{output, exitCode, oomKilled, hang,
 * ignoreStop}`; its `output` steps run in order:
 *
 * - `"text"`: print a line;
 * - `{line, delayMs?}`: print a line after a delay;
 * - `{sleepMs}`: wait;
 * - `{memoryBytes?, cpuPct?, cpuSeconds?}`: what stats() reports from the
 *   start of that step on (a step may combine these).
 *
 * Then it exits with `exitCode` (default 0), or 137 with OOMKilled when
 * `oomKilled`. With `hang` it runs until stopped. A stop exits it with 143,
 * or, with `ignoreStop`, waits out the grace and kills it (137).
 */
class FakeContainer {
  constructor(runtime, id, spec, script) {
    this.runtime = runtime;
    this.clock = runtime.clock;
    this.id = id;
    this.spec = spec;
    this.script = script;
    this.labels = { ...(spec.labels ?? {}) };
    this.lines = [];
    this.waiters = new Set();
    this.result = null;
    this.stopping = new AbortController();
    this.sample = { memoryBytes: 0, cpuPct: 0, cpuSeconds: 0 };
    this.exited = new Promise((resolve) => { this.resolveExit = resolve; });
  }

  print(line) {
    this.lines.push(String(line));
    this.notify();
  }

  notify() {
    for (const wake of [...this.waiters]) wake();
  }

  exit(result) {
    if (this.result) return;
    this.result = result;
    this.stopping.abort();
    this.resolveExit(result);
    this.notify();
  }

  async drive() {
    const signal = this.stopping.signal;
    for (const step of this.script.output ?? []) {
      if (this.result) return;
      if (typeof step === "string") {
        this.print(step);
        continue;
      }
      for (const key of ["memoryBytes", "cpuPct", "cpuSeconds"]) if (typeof step[key] === "number") this.sample[key] = step[key];
      if (step.sleepMs) await this.clock.sleep(step.sleepMs, signal);
      if (step.delayMs) await this.clock.sleep(step.delayMs, signal);
      if (this.result) return;
      if ("line" in step) this.print(step.line);
    }
    if (this.result) return;
    if (this.script.hang) return; // Until stopped.
    if (this.script.oomKilled) this.exit({ exitCode: 137, oomKilled: true });
    else this.exit({ exitCode: this.script.exitCode ?? 0, oomKilled: false });
  }

  async stop(graceSeconds) {
    if (this.result) return;
    this.stopRequestedAt = this.clock.now();
    if (!this.script.ignoreStop) {
      this.exit({ exitCode: 143, oomKilled: false });
      return;
    }
    await Promise.race([this.exited, this.clock.sleep(graceSeconds * 1000)]);
    this.exit({ exitCode: 137, oomKilled: false });
  }

  /** stdout+stderr from the first line, then live, as `docker logs -f` gives them. */
  async *logs() {
    let index = 0;
    for (;;) {
      while (index < this.lines.length) yield this.lines[index++];
      if (this.result) return;
      await new Promise((resolve) => {
        const wake = () => {
          this.waiters.delete(wake);
          resolve();
        };
        this.waiters.add(wake);
      });
    }
  }

  handle() {
    return {
      id: this.id,
      runId: this.labels[RUN_LABEL] ?? null,
      jobId: this.labels[JOB_LABEL] ?? null,
      labels: this.labels,
      logs: this.logs(),
      stats: async () => ({
        ...this.sample,
        memoryLimitBytes: (this.spec.resources?.memoryMiB ?? 0) * MIB || null,
      }),
      wait: () => this.exited,
      stop: (graceSeconds) => this.stop(graceSeconds),
      remove: async () => {
        this.runtime.containers.delete(this.id);
      },
    };
  }
}

export class FakeRuntime {
  /**
   * `scripts`: by job id or image; `script`: the fallback, or a function of
   * the spec. `vm`: "stopped" or "running" for a Colima-like host (a run
   * first waits `bootMs` for it), null for a Docker host with no VM.
   * `images`: refs already pulled. `failReady`: how many ensureReady calls
   * fail before one succeeds. `failPull`: an error message for every pull.
   */
  constructor({
    scripts = {}, script = null, clock = systemClock, images = [], pullMs = 0, bootMs = 0, vm = null,
    cpus = 4, memoryMiB = 8192, diskFreeMiB = 50_000, failReady = 0, failPull = null, version = "fake-1",
  } = {}) {
    Object.assign(this, { scripts, script, clock: clock ?? systemClock, pullMs, bootMs, vm, cpus, memoryMiB, diskFreeMiB, failReady, failPull, version });
    this.images = new Set(images);
    this.containers = new Map();
    this.started = [];
    this.pulls = [];
    this.next = 1;
  }

  scriptFor(spec) {
    if (typeof this.script === "function") return this.script(spec) ?? DEFAULT_SCRIPT;
    return this.scripts[spec.jobId] ?? this.scripts[spec.image] ?? this.script ?? DEFAULT_SCRIPT;
  }

  async ensureReady() {
    if (this.failReady > 0) {
      this.failReady -= 1;
      throw new Error("the fake VM failed to start");
    }
    if (this.vm !== "stopped") return { bootMs: 0 };
    this.vm = "starting";
    await this.clock.sleep(this.bootMs);
    this.vm = "running";
    return { bootMs: this.bootMs };
  }

  running() {
    return [...this.containers.values()].filter((container) => !container.result);
  }

  async idle() {
    if (this.vm === "running" && !this.running().length) this.vm = "stopped";
  }

  async stop() {
    await this.idle();
  }

  async hasImage(ref) {
    return this.images.has(ref);
  }

  async pull(ref) {
    this.pulls.push(ref);
    const started = this.clock.monotonic();
    await this.clock.sleep(this.pullMs);
    if (this.failPull) throw new Error(this.failPull);
    this.images.add(ref);
    const digest = ref.includes("@") ? ref.slice(ref.indexOf("@") + 1) : `sha256:${createHash("sha256").update(ref).digest("hex")}`;
    return { digest, ms: Math.round(this.clock.monotonic() - started) };
  }

  async run(spec) {
    const container = new FakeContainer(this, `fake-${this.next++}`, spec, this.scriptFor(spec));
    this.containers.set(container.id, container);
    this.started.push(spec);
    container.drive();
    return container.handle();
  }

  async adopt() {
    return [...this.containers.values()].filter((container) => container.labels[RUN_LABEL]).map((container) => container.handle());
  }

  async facts() {
    return {
      kind: "fake",
      version: this.version,
      cpus: this.cpus,
      memoryMiB: this.memoryMiB,
      diskFreeMiB: this.diskFreeMiB,
      vm: this.vm === null ? null : { kind: "fake-vm", state: this.vm },
    };
  }

  /** For tests: the container a run is in. */
  containerOf(runId) {
    return [...this.containers.values()].find((container) => container.labels[RUN_LABEL] === runId) ?? null;
  }
}

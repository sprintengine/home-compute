// One run, one Durable Object, one container. The container runs the job
// under a small shell wrapper (src/core/cloudflare.mjs `wrappedEntrypoint`)
// that copies its output to /tmp/hc/log and its exit code to /tmp/hc/exit,
// then holds for a few minutes so the result can be read. This object reads
// both with `exec`: at once when the job ends (a waiting exec returns), and
// on every check besides (each cron minute and each alarm), so a restarted
// object still finds the result. The lease is renewed only from here, and
// only while the container answers: a container that is gone stops renewing
// and the run is marked lost, as a machine's would be.
//
// The Containers helper's alarm keeps the object (and the container) resident
// in slices of a few minutes, which is how a 20 minute job outlives the
// cron's wall-clock limit. Secrets are passed to the container at start and
// held in memory for redaction only; nothing here stores them.

import { Container } from "@cloudflare/containers";
import {
  RESULT_HOLD_SECONDS, imageDigest, parseProbe, probeCommand, watchDecision, waitCommand, wrappedEntrypoint,
} from "../../src/core/cloudflare.mjs";
import { RUNNING_TAIL } from "../../src/core/protocol.mjs";
import { ACTIVE_SQL } from "./db.mjs";
import { recordContainerStop, runningTail, secretValuesForJob } from "./containers.mjs";

const PROBE_TIMEOUT_MS = 15_000;

function randomNonce() {
  return [...crypto.getRandomValues(new Uint8Array(12))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class HcContainer extends Container {
  // Backstop only: checks renew activity until the deadline, then the run is settled and the container destroyed.
  sleepAfter = "35m";

  /** Starts the container for one run. `spec.env` reaches the container and is not stored. */
  async startRun(spec) {
    await this.ctx.storage.put("run", {
      runId: spec.runId,
      jobId: spec.jobId,
      deadlineAt: spec.deadlineAt,
      instanceType: spec.instanceType,
      memoryLimitBytes: spec.memoryLimitBytes,
    });
    if (typeof this.ctx.container?.exec !== "function") {
      throw new Error("this Workers runtime has no container exec, which hc-core needs to read a job's output and exit code");
    }
    this.secretValues = spec.secretValues ?? [];
    await this.start({
      envVars: spec.env ?? {},
      enableInternet: spec.enableInternet !== false,
      entrypoint: wrappedEntrypoint(spec.command, RESULT_HOLD_SECONDS),
    });
    const info = await Promise.resolve(this.ctx.container?.inspect?.()).catch(() => null);
    this.follow();
    return { image: info?.image ?? null, digest: imageDigest(info?.image) };
  }

  /** The cron's once-a-minute check, in case an alarm was delayed. Answers whether the container is still there. */
  async tick() {
    await this.check();
    return { running: Boolean(this.ctx.container?.running), active: Boolean(await this.ctx.storage.get("run")) };
  }

  async alarm(alarmProps) {
    try {
      await this.check();
    } catch (error) {
      console.error(JSON.stringify({ event: "container_check_error", error: String(error?.message ?? error) }));
    }
    await super.alarm(alarmProps);
  }

  /** A batch job accepts no HTTP, so the helper's inactivity stop would end it early. Hold it until the run is settled. */
  async onActivityExpired() {
    if (await this.ctx.storage.get("run")) {
      this.renewActivityTimeout();
      return;
    }
    await super.onActivityExpired();
  }

  /**
   * The container stopped. After a settle that is the destroy, and there is
   * nothing to do. Otherwise it went before its result was read (the hold ran
   * out, or the instance itself died): the run fails with what we know.
   */
  async onStop(params) {
    const spec = await this.ctx.storage.get("run");
    if (!spec?.runId) return;
    const row = await this.env.DB.prepare("SELECT state FROM runs WHERE id = ?").bind(spec.runId).first();
    if (row && row.state !== "lost") {
      const code = typeof params?.exitCode === "number" ? params.exitCode : null;
      await recordContainerStop(this.env.DB, spec.runId, {
        failed: true,
        error: `the container stopped before hc-core read the job's result${code === null ? "" : ` (container exit ${code})`}`,
        peakMemoryBytes: (await this.ctx.storage.get("peak")) ?? null,
      }, Date.now());
    }
    await this.forget();
  }

  /** Waits for the job to write its exit code, then checks at once, so a 10 second job is not billed for a minute of hold. */
  follow() {
    const container = this.ctx.container;
    if (this.following || typeof container?.exec !== "function") return;
    this.following = (async () => {
      try {
        const waiter = await container.exec(waitCommand(), { stdout: "ignore", stderr: "ignore" });
        await waiter.exitCode;
        await this.check();
      } catch {
        // The minute's check finds the result instead.
      } finally {
        this.following = null;
      }
    })();
  }

  /** Checks run one at a time: the cron's, the alarm's and the follower's never interleave. */
  check() {
    const next = (this.queue ?? Promise.resolve()).then(() => this.checkOnce());
    this.queue = next.catch(() => {});
    return next;
  }

  async checkOnce() {
    const spec = await this.ctx.storage.get("run");
    if (!spec?.runId) return;
    const db = this.env.DB;
    const row = await db.prepare("SELECT id, state FROM runs WHERE id = ?").bind(spec.runId).first();
    if (!row) {
      await this.stopContainer();
      await this.forget();
      return;
    }
    const container = this.ctx.container;
    const probe = container?.running ? await this.probe() : null;
    if (probe?.peakMemoryBytes) {
      const peak = Math.max((await this.ctx.storage.get("peak")) ?? 0, probe.peakMemoryBytes);
      await this.ctx.storage.put("peak", peak);
      probe.peakMemoryBytes = peak;
    }
    const now = Date.now();
    const decision = watchDecision({ state: row.state, deadlineAt: spec.deadlineAt, exitCode: probe?.exitCode ?? null }, now);
    if (decision.action === "renew") {
      // No answer from the container: do not renew. The lease runs out and the run is lost (and retried when the job says so).
      if (!probe) return;
      const secrets = await this.secretsFor(spec);
      await db.batch([
        db.prepare(`UPDATE runs SET lease_expires_at = ?1, peak_memory_bytes = MAX(COALESCE(peak_memory_bytes, 0), ?2)
          WHERE id = ?3 AND state IN (${ACTIVE_SQL})`).bind(decision.leaseExpiresAt, probe.peakMemoryBytes ?? 0, spec.runId),
        runningTail(db, spec.runId, probe, secrets, now, RUNNING_TAIL),
      ]);
      this.renewActivityTimeout();
      this.follow();
      return;
    }
    if (decision.action === "settle") {
      const secrets = await this.secretsFor(spec);
      await recordContainerStop(db, spec.runId, {
        stopReason: decision.stopReason,
        exitCode: probe?.exitCode ?? null,
        failed: !probe,
        error: probe ? null : "the container did not answer at the run's deadline",
        peakMemoryBytes: probe?.peakMemoryBytes ?? null,
        cpuSeconds: typeof probe?.cpuMicroseconds === "number" ? probe.cpuMicroseconds / 1e6 : null,
        probe,
        secretValues: secrets,
      }, now);
    } else if (decision.keepLog && probe) {
      // Cancelled (or ended elsewhere) while it ran: keep what it printed.
      const secrets = await this.secretsFor(spec);
      await runningTail(db, spec.runId, probe, secrets, now, null, { final: true }).run();
    }
    await this.forget();
    await this.stopContainer();
  }

  /** What the container says about the run, or null when it does not answer. */
  async probe() {
    const container = this.ctx.container;
    if (typeof container?.exec !== "function") return null;
    const nonce = randomNonce();
    try {
      const process = await container.exec(probeCommand(nonce), { stdout: "pipe", stderr: "ignore", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      const output = await process.output();
      return parseProbe(new TextDecoder().decode(output.stdout), nonce);
    } catch {
      return null;
    }
  }

  /** The run's secret values, for redaction: from the start when this object has them, else opened again from the vault. */
  async secretsFor(spec) {
    if (!this.secretValues) this.secretValues = await secretValuesForJob(this.env, spec.jobId);
    return this.secretValues;
  }

  async stopContainer() {
    if (this.ctx.container?.running) await this.destroy();
  }

  /** The run is settled: drop its record so a later stop or check does nothing. */
  async forget() {
    await this.ctx.storage.delete(["run", "peak"]);
    this.secretValues = null;
  }
}

/** One class per instance type (wrangler.core.jsonc). They differ only in the size Cloudflare gives them. */
export class HcContainerLite extends HcContainer {}
export class HcContainerBasic extends HcContainer {}
export class HcContainerStandard1 extends HcContainer {}

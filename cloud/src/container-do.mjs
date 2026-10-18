// One run, one Durable Object. The Containers helper's alarm keeps the
// object (and therefore the container) resident in slices of at most a few
// minutes, which is how a 20 minute job outlives the cron's wall-clock
// limit. `sleepAfter` is longer than the longest run plus the timeout grace,
// so a batch job that never accepts HTTP is not stopped for inactivity.
// stdout is not copied into `run_logs`; it stays in Workers Logs.

import { Container } from "@cloudflare/containers";
import { containerWatch, parseCgroup } from "../../src/core/cloudflare.mjs";
import { recordContainerStop } from "./containers.mjs";

const ACTIVE_SQL = "'claimed','starting-vm','pulling','running','reporting'";
const SAMPLE = "printf 'memory.peak %s\\n' \"$(cat /sys/fs/cgroup/memory.peak 2>/dev/null)\"; cat /sys/fs/cgroup/cpu.stat 2>/dev/null || true";

export class HcContainerBasic extends Container {
  sleepAfter = "35m";

  /** Starts the container for one run. The spec's env is passed through and not stored. */
  async startRun(spec) {
    await this.ctx.storage.put("run", {
      runId: spec.runId,
      deadlineAt: spec.deadlineAt,
      instanceType: spec.instanceType,
      memoryLimitBytes: spec.memoryLimitBytes,
    });
    await this.ctx.storage.delete("stopReason");
    await this.ctx.storage.delete("settled");
    const options = { envVars: spec.env ?? {}, enableInternet: spec.enableInternet !== false };
    if (spec.entrypoint?.length) options.entrypoint = spec.entrypoint;
    await this.start(options);
  }

  /** The cron's once-a-minute nudge, in case an alarm was delayed. */
  async tick() {
    await this.watch();
  }

  async alarm(alarmProps) {
    try {
      await this.watch();
    } catch (error) {
      console.error(JSON.stringify({ event: "container_watch_error", error: String(error?.message ?? error) }));
    }
    await super.alarm(alarmProps);
  }

  /**
   * A quiet batch job has no HTTP, so the default inactivity stop would kill
   * it at 10 minutes. Keep it until the run's own deadline. `sleepAfter` is
   * the backstop when alarms are not firing.
   */
  async onActivityExpired() {
    const spec = await this.ctx.storage.get("run");
    const stopReason = await this.ctx.storage.get("stopReason");
    if (spec && !stopReason && Date.now() < spec.deadlineAt) {
      this.renewActivityTimeout();
      return;
    }
    if (!stopReason) await this.ctx.storage.put("stopReason", "activity");
    await super.onActivityExpired();
  }

  async onStop(params) {
    const spec = await this.ctx.storage.get("run");
    if (!spec?.runId || await this.ctx.storage.get("settled")) return;
    const stopReason = await this.ctx.storage.get("stopReason");
    if (stopReason === "lost") return;
    const sample = (await this.ctx.storage.get("sample")) ?? {};
    const result = await recordContainerStop(this.env.DB, spec.runId, {
      stopReason: stopReason ?? null,
      exitCode: typeof params?.exitCode === "number" ? params.exitCode : null,
      peakMemoryBytes: sample.peakMemoryBytes ?? null,
      cpuSeconds: typeof sample.cpuMicroseconds === "number" ? sample.cpuMicroseconds / 1e6 : null,
    }, Date.now());
    if (!result?.ignored) await this.ctx.storage.put("settled", true);
  }

  async watch() {
    const spec = await this.ctx.storage.get("run");
    if (!spec?.runId) return;
    const row = await this.env.DB.prepare("SELECT id, state, memory_limit_bytes FROM runs WHERE id = ?").bind(spec.runId).first();
    if (!row) return;
    const decision = containerWatch({ state: row.state, deadlineAt: spec.deadlineAt }, Date.now());
    if (decision.action === "renew") {
      await this.env.DB.prepare(`UPDATE runs SET lease_expires_at = ?1 WHERE id = ?2 AND state IN (${ACTIVE_SQL})`)
        .bind(decision.leaseExpiresAt, spec.runId).run();
      this.renewActivityTimeout();
      await this.sample(spec.runId);
      return;
    }
    if (decision.stopReason) await this.ctx.storage.put("stopReason", decision.stopReason);
    if (this.ctx.container?.running) {
      await this.destroy();
      return;
    }
    if (decision.complete) await this.onStop({ exitCode: null, reason: decision.stopReason });
  }

  /** Best-effort peak memory and CPU time. A failure here never fails the run. */
  async sample(runId) {
    if (typeof this.ctx.container?.exec !== "function") return;
    let result;
    try {
      result = await this.ctx.container.exec("sh", ["-c", SAMPLE]);
    } catch {
      return;
    }
    const text = typeof result === "string" ? result : `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
    const parsed = parseCgroup(text);
    if (parsed.peakMemoryBytes === undefined && parsed.cpuMicroseconds === undefined) return;
    const previous = (await this.ctx.storage.get("sample")) ?? {};
    const sample = {
      ...previous,
      ...parsed,
      peakMemoryBytes: Math.max(previous.peakMemoryBytes ?? 0, parsed.peakMemoryBytes ?? 0) || undefined,
    };
    await this.ctx.storage.put("sample", sample);
    if (sample.peakMemoryBytes) {
      await this.env.DB.prepare("UPDATE runs SET peak_memory_bytes = MAX(COALESCE(peak_memory_bytes, 0), ?1) WHERE id = ?2")
        .bind(sample.peakMemoryBytes, runId).run();
    }
  }
}

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDatabase, rows } from "./helpers.mjs";

const T = Date.parse("2026-10-11T08:20:00Z");

async function insertRun(id, state, { slotAt = null, job = "a" } = {}) {
  return env.DB.prepare(`INSERT INTO runs (id, job_id, job_revision, slot_at, source, state, due_at, created_at, updated_at)
    VALUES (?, ?, 1, ?, 'schedule', ?, ?, ?, ?)`).bind(id, job, slotAt, state, T, T, T).run();
}

describe("migrations", () => {
  beforeEach(async () => {
    await resetDatabase();
    await env.DB.prepare(`INSERT INTO jobs (id, image, resources_json, timeouts_json, created_at, updated_at)
      VALUES ('a', 'x', '{}', '{}', ?1, ?1)`).bind(T).run();
  });

  it("create every table and index of the design, plus the changes cursor index", async () => {
    const objects = await rows("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY type, name");
    expect(objects.filter((row) => row.type === "table").map((row) => row.name)).toEqual([
      "audit_log", "jobs", "join_tokens", "machines", "provisioning_tasks", "run_logs", "runs", "schedule_state", "secrets", "settings",
    ]);
    expect(objects.filter((row) => row.type === "index").map((row) => row.name)).toEqual([
      "audit_at", "runs_by_job", "runs_by_machine", "runs_by_state", "runs_by_updated", "runs_one_active", "runs_one_due", "runs_slot",
    ]);
  });

  it("allow one run per slot, one due run and one active run per job (partial unique indexes)", async () => {
    await insertRun("r1", "due", { slotAt: T });
    await expect(insertRun("r2", "skipped", { slotAt: T })).rejects.toThrow(/UNIQUE/);
    await expect(insertRun("r3", "due")).rejects.toThrow(/UNIQUE/);
    await insertRun("r4", "running");
    await expect(insertRun("r5", "claimed")).rejects.toThrow(/UNIQUE/);
    // Terminal runs and manual runs (no slot) are not limited.
    await insertRun("r6", "succeeded");
    await insertRun("r7", "succeeded");
    await insertRun("r8", "skipped", { slotAt: T + 60_000 });
    expect((await rows("SELECT COUNT(*) AS n FROM runs"))[0].n).toBe(5);
  });

  it("reject a run for an unknown job (foreign keys are on)", async () => {
    await expect(insertRun("r1", "due", { job: "nope" })).rejects.toThrow(/FOREIGN KEY/);
  });

  it("drop a run's log with the run", async () => {
    await insertRun("r1", "succeeded");
    await env.DB.prepare("INSERT INTO run_logs (run_id, tail, updated_at) VALUES ('r1', 'x', 1)").run();
    await env.DB.prepare("DELETE FROM runs WHERE id = 'r1'").run();
    expect(await rows("SELECT * FROM run_logs")).toEqual([]);
  });
});

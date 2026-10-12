import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyRetention } from "../src/cron.mjs";
import { call, createJob, cron, mockCertificates, resetDatabase, rows } from "./helpers.mjs";

const at = (time) => Date.parse(time);
const CREATED = at("2026-10-11T07:00:00Z");
let certificates;

beforeEach(async () => {
  await resetDatabase();
  certificates = mockCertificates();
});
afterEach(() => certificates.mockRestore());

const runsOf = (job) => rows("SELECT id, state, skip_reason, slot_at, due_at, source, preferred_until FROM runs WHERE job_id = ? ORDER BY slot_at", job);
const stateOf = async (job) => (await rows("SELECT * FROM schedule_state WHERE job_id = ?", job))[0];

describe("cron materialisation", () => {
  it("creates one run per slot however often it runs, and none for a new job's past slot", async () => {
    await createJob("harmonie", {}, { now: CREATED });
    expect((await stateOf("harmonie")).last_slot_at).toBe(at("2026-10-10T10:20:00Z"));
    await cron("2026-10-11T07:59:00Z");
    expect(await runsOf("harmonie")).toEqual([]);

    const first = await cron("2026-10-11T08:20:00Z");
    expect(first.materialised.created).toBe(1);
    await cron("2026-10-11T08:20:00Z");
    await cron("2026-10-11T08:20:59Z");
    await cron("2026-10-11T08:21:00Z");
    const runs = await runsOf("harmonie");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ state: "due", source: "schedule", slot_at: at("2026-10-11T08:20:00Z"), due_at: at("2026-10-11T08:20:00Z") });
    expect(runs[0].id).toMatch(/^r_[0-9A-Z]{26}$/);
    const state = await stateOf("harmonie");
    expect([state.last_slot_at, state.next_due_at]).toEqual([at("2026-10-11T08:20:00Z"), at("2026-10-11T10:20:00Z")]);
  });

  it("two crons racing on stale state still create one run (UNIQUE(job_id, slot_at))", async () => {
    await createJob("harmonie", {}, { now: CREATED });
    await Promise.all([cron("2026-10-11T08:20:01Z"), cron("2026-10-11T08:20:02Z"), cron("2026-10-11T08:20:03Z")]);
    expect(await runsOf("harmonie")).toHaveLength(1);
  });

  it("coalesces: a slot folds into a waiting run, and waits behind an active one", async () => {
    await createJob("harmonie", { placement: { preferMachines: ["mac-mini"], preferWaitSeconds: 120 } }, { now: CREATED });
    await cron("2026-10-11T08:20:00Z");
    await cron("2026-10-11T10:20:00Z");
    let runs = await runsOf("harmonie");
    expect(runs.map((run) => [run.state, run.skip_reason])).toEqual([["due", null], ["skipped", "coalesced"]]);
    expect(runs[0].preferred_until).toBe(at("2026-10-11T08:22:00Z"));

    // The waiting run is claimed and running when the next day's slot comes: the slot waits.
    await env.DB.prepare("UPDATE runs SET state = 'running', machine_id = 'm_1' WHERE id = ?").bind(runs[0].id).run();
    await cron("2026-10-12T08:20:00Z");
    runs = await runsOf("harmonie");
    expect(runs.map((run) => run.state)).toEqual(["running", "skipped", "due"]);
  });

  it("skip: a slot that finds the job running is recorded as an overlap", async () => {
    await createJob("prune", { schedule: { at: { minutes: [10] } }, policy: { overlap: "skip" } }, { now: CREATED });
    await cron("2026-10-11T07:10:00Z");
    const [first] = await runsOf("prune");
    await env.DB.prepare("UPDATE runs SET state = 'running' WHERE id = ?").bind(first.id).run();
    await cron("2026-10-11T08:10:00Z");
    expect((await runsOf("prune")).map((run) => [run.state, run.skip_reason])).toEqual([["running", null], ["skipped", "overlap"]]);
  });

  it("catch-up none: a run waiting past maxLateness expires and the next slot runs", async () => {
    await createJob("tides", { schedule: { at: { minutes: [5] } }, policy: { catchUp: "none" }, timeouts: { maxLatenessSeconds: 1800 } },
      { now: CREATED });
    await cron("2026-10-11T07:05:00Z");
    await cron("2026-10-11T07:35:00Z");
    expect((await runsOf("tides")).map((run) => run.state)).toEqual(["due"]);
    await cron("2026-10-11T07:35:01Z");
    expect((await runsOf("tides")).map((run) => [run.state, run.skip_reason])).toEqual([["skipped", "expired"]]);
    await cron("2026-10-11T08:05:00Z");
    expect((await runsOf("tides")).map((run) => run.state)).toEqual(["skipped", "due"]);
  });

  it("catch-up latest: after downtime each job runs once, however many slots it missed", async () => {
    await createJob("blend", { schedule: { at: { minutes: [5] } } }, { now: CREATED });
    await cron("2026-10-11T07:05:00Z");
    const [waiting] = await runsOf("blend");
    await env.DB.prepare("UPDATE runs SET state = 'succeeded', finished_at = ? WHERE id = ?").bind(at("2026-10-11T07:06:00Z"), waiting.id).run();
    await cron("2026-10-11T13:40:00Z");
    const runs = await runsOf("blend");
    expect(runs.map((run) => [run.state, run.slot_at])).toEqual([["succeeded", at("2026-10-11T07:05:00Z")], ["due", at("2026-10-11T13:05:00Z")]]);
  });

  it("a paused job records its slots as skipped and does not replay them on resume", async () => {
    await createJob("harmonie", {}, { now: CREATED });
    expect((await call("/v1/jobs/harmonie/pause", { method: "POST" })).status).toBe(202);
    await cron("2026-10-11T08:20:00Z");
    expect((await runsOf("harmonie")).map((run) => [run.state, run.skip_reason])).toEqual([["skipped", "paused-at-slot"]]);
    expect((await stateOf("harmonie")).last_slot_at).toBe(at("2026-10-11T08:20:00Z"));
    expect((await call("/v1/jobs/harmonie/resume", { method: "POST" })).status).toBe(202);
    await cron("2026-10-11T08:25:00Z");
    expect(await runsOf("harmonie")).toHaveLength(1);
    await cron("2026-10-11T10:20:00Z");
    expect((await runsOf("harmonie")).map((run) => run.state)).toEqual(["skipped", "due"]);
  });

  it("the global pause skips every job's slots (shadow mode) until resumed", async () => {
    await createJob("harmonie", {}, { now: CREATED });
    await createJob("blend", { schedule: { at: { minutes: [5] } } }, { now: CREATED });
    expect((await call("/v1/pause-all", { method: "POST" })).body.globalPause).toBe(true);
    await cron("2026-10-11T08:20:00Z");
    const skipped = await rows("SELECT job_id, state, skip_reason FROM runs ORDER BY job_id");
    expect(skipped).toEqual([
      { job_id: "blend", state: "skipped", skip_reason: "paused-at-slot" },
      { job_id: "harmonie", state: "skipped", skip_reason: "paused-at-slot" },
    ]);
    expect((await call("/v1/resume-all", { method: "POST" })).body.globalPause).toBe(false);
    await cron("2026-10-11T09:05:00Z");
    expect((await runsOf("blend")).map((run) => run.state)).toEqual(["skipped", "due"]);
  });

  it("a disabled job records nothing but keeps its place", async () => {
    await createJob("aifs", { enabled: false }, { now: CREATED });
    await cron("2026-10-11T08:20:00Z");
    expect(await runsOf("aifs")).toEqual([]);
    expect((await stateOf("aifs")).last_slot_at).toBe(at("2026-10-11T08:20:00Z"));
  });

  it("an interval job is due one interval after it was created or last finished", async () => {
    await createJob("sweep", { schedule: { every: "6h" } }, { now: CREATED });
    await cron("2026-10-11T12:59:00Z");
    expect(await runsOf("sweep")).toEqual([]);
    await cron("2026-10-11T13:00:00Z");
    await cron("2026-10-11T13:00:30Z");
    const [run] = await runsOf("sweep");
    expect([run.state, run.slot_at]).toEqual(["due", at("2026-10-11T13:00:00Z")]);
    await cron("2026-10-11T20:00:00Z");
    expect(await runsOf("sweep")).toHaveLength(1);
    // It finishes at 21:00 (M2 records completions; here by hand): the next is at 03:00.
    await env.DB.batch([
      env.DB.prepare("UPDATE runs SET state = 'succeeded', finished_at = ? WHERE id = ?").bind(at("2026-10-11T21:00:00Z"), run.id),
      env.DB.prepare("UPDATE schedule_state SET last_finished_at = ? WHERE job_id = 'sweep'").bind(at("2026-10-11T21:00:00Z")),
    ]);
    await cron("2026-10-12T02:59:00Z");
    expect(await runsOf("sweep")).toHaveLength(1);
    await cron("2026-10-12T03:00:00Z");
    expect((await runsOf("sweep")).map((entry) => entry.slot_at)).toEqual([at("2026-10-11T13:00:00Z"), at("2026-10-12T03:00:00Z")]);
  });
});

describe("cron backstops", () => {
  it("marks runs whose lease expired as lost, and runs past their timeout as timed out", async () => {
    await createJob("ecmwf", { timeouts: { runSeconds: 600 } }, { now: CREATED });
    const now = at("2026-10-11T09:00:00Z");
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO runs (id, job_id, job_revision, source, state, due_at, machine_id, lease_expires_at, started_at, created_at, updated_at)
        VALUES ('r_a', 'ecmwf', 1, 'manual', 'pulling', ?1, 'm_1', ?2, NULL, ?1, ?1)`).bind(now - 600_000, now - 1),
      env.DB.prepare(`INSERT INTO runs (id, job_id, job_revision, source, state, skip_reason, due_at, created_at, updated_at)
        VALUES ('r_b', 'ecmwf', 1, 'manual', 'skipped', 'coalesced', ?1, ?1, ?1)`).bind(now),
    ]);
    let summary = await cron(now);
    expect(summary.lost).toBe(1);
    expect((await rows("SELECT state, lease_expires_at FROM runs WHERE id = 'r_a'"))[0]).toEqual({ state: "lost", lease_expires_at: null });

    await env.DB.prepare(`INSERT INTO runs (id, job_id, job_revision, source, state, due_at, machine_id, lease_expires_at, started_at, created_at, updated_at)
      VALUES ('r_c', 'ecmwf', 1, 'manual', 'running', ?1, 'm_1', ?2, ?3, ?1, ?1)`).bind(now, now + 3_600_000, now - 900_000).run();
    summary = await cron(now);
    expect(summary.timedOut).toBe(0);
    summary = await cron(now + 1);
    expect(summary.timedOut).toBe(1);
    expect((await rows("SELECT state, outcome, timed_out, error FROM runs WHERE id = 'r_c'"))[0])
      .toEqual({ state: "timed-out", outcome: "failed", timed_out: 1, error: "timed out: no result from the agent" });
  });

  it("applies retention once an hour, keeping each job's newest runs", async () => {
    await createJob("blend", { schedule: { at: { minutes: [5] } } }, { now: CREATED });
    const now = at("2026-10-11T09:37:00Z");
    const day = 86_400_000;
    const insert = (id, state, due) => env.DB.prepare(`INSERT INTO runs (id, job_id, job_revision, source, state, due_at, created_at, updated_at)
      VALUES (?, 'blend', 1, 'schedule', ?, ?, ?, ?)`).bind(id, state, due, due, due);
    await env.DB.batch([
      insert("r_old_skip", "skipped", now - 15 * day),
      insert("r_new_skip", "skipped", now - 13 * day),
      insert("r_ancient", "succeeded", now - 200 * day),
      env.DB.prepare("INSERT INTO audit_log (at, actor, action) VALUES (?, 'system', 'x'), (?, 'system', 'y')").bind(now - 400 * day, now),
    ]);
    expect(await applyRetention(env.DB, now)).toEqual({ skipped: 1, logs: 0, runs: 0, audit: 1 });
    expect((await rows("SELECT id FROM runs ORDER BY id")).map((row) => row.id)).toEqual(["r_ancient", "r_new_skip"]);
    // With fewer than 50 newer runs the ancient run stays; with a keep of 1 and a newer run, it goes.
    await env.DB.prepare("INSERT INTO settings (key, value_json) VALUES ('retention', ?)").bind(JSON.stringify({ keepRunsPerJob: 1 })).run();
    const summary = await cron(now);
    expect(summary.retention).toEqual({ skipped: 0, logs: 0, runs: 1, audit: 0 });
    expect((await cron(at("2026-10-11T09:38:00Z"))).retention).toBeUndefined();
  });
});

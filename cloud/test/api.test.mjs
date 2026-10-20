import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { call, createJob, cron, definition, mockCertificates, ORIGIN, OWNER, resetDatabase, rows } from "./helpers.mjs";

let certificates;
beforeEach(async () => {
  await resetDatabase();
  certificates = mockCertificates();
});
afterEach(() => certificates.mockRestore());

const audit = () => rows("SELECT actor, action, target, before_json, after_json FROM audit_log ORDER BY id");

describe("CSRF", () => {
  it("refuses a browser's change without JSON, its own origin, a same-origin fetch or its token", async () => {
    await createJob("gfs");
    const cases = [
      [{ "content-type": "text/plain" }, "content_type"],
      [{ "content-type": "application/x-www-form-urlencoded" }, "content_type"],
      [{ origin: "https://evil.example" }, "origin"],
      [{ origin: undefined }, "origin"],
      [{ "sec-fetch-site": "cross-site" }, "cross_site"],
      [{ "sec-fetch-site": "same-site" }, "cross_site"],
      [{ "x-hc-csrf": "forged" }, "csrf_token"],
      [{ "x-hc-csrf": undefined }, "csrf_token"],
    ];
    for (const [headers, reason] of cases) {
      const response = await call("/v1/jobs/gfs/pause", { method: "POST", headers });
      expect(response.status, JSON.stringify(headers)).toBe(403);
      expect(response.body).toEqual({ error: "csrf_check_failed", reason });
    }
    expect((await rows("SELECT paused FROM jobs"))[0].paused).toBe(0);
    expect((await audit()).map((entry) => entry.action)).toEqual(["job.create"], "nothing refused was audited");
  });

  it("accepts the dashboard's own header name and the right token", async () => {
    await createJob("gfs");
    const { csrfToken } = (await call("/v1/session")).body;
    const response = await call("/v1/jobs/gfs/pause", { method: "POST", headers: { "x-hc-csrf": undefined, "x-csrf-token": csrfToken } });
    expect(response.status).toBe(202);
  });

  it("ties the token to the Access session, so another session's token fails", async () => {
    await call("/v1/settings", { method: "PATCH", body: { roles: { "other@example.com": "admin" } } });
    await createJob("gfs");
    const { csrfToken } = (await call("/v1/session", { identity: "other@example.com" })).body;
    expect((await call("/v1/jobs/gfs/pause", { method: "POST", headers: { "x-hc-csrf": csrfToken } })).body.reason).toBe("csrf_token");
  });
});

describe("jobs", () => {
  it("creates a job, returns it with its revision, and audits it", async () => {
    const created = await call("/v1/jobs/ecmwf", { method: "PUT", body: definition({ description: "ECMWF" }) });
    expect(created.status).toBe(201);
    expect(created.headers.get("etag")).toBe('"1"');
    expect(created.body).toMatchObject({ id: "ecmwf", revision: 1, paused: false, enabled: true, updatedBy: OWNER, description: "ECMWF" });
    const fetched = await call("/v1/jobs/ecmwf");
    expect(fetched.body).toEqual(created.body);
    const [entry] = await audit();
    expect(entry).toMatchObject({ actor: OWNER, action: "job.create", target: "ecmwf" });
    expect(JSON.parse(entry.after_json).image).toBe("ghcr.io/example/worker@sha256:0123");
    expect((await call("/v1/jobs/nope")).status).toBe(404);
    expect((await call("/v1/jobs/Bad_Id")).status).toBe(404);
  });

  it("rejects invalid definitions with the reason", async () => {
    expect((await call("/v1/jobs/a", { method: "PUT", body: definition({ network: "host" }) })).body.error).toMatch(/network/);
    expect((await call("/v1/jobs/a", { method: "PUT", body: definition({ id: "b" }) })).body.error).toMatch(/match the path/);
    expect((await call("/v1/jobs/a", { method: "PUT", body: "{not json" })).body.error).toMatch(/valid JSON/);
    expect((await call("/v1/jobs/a", { method: "PUT", body: definition({ secretEnv: { KEY: "the-actual-secret" } }) })).status).toBe(400);
    expect(await rows("SELECT * FROM jobs")).toEqual([]);
  });

  it("replaces a job only at the revision the client read (If-Match)", async () => {
    await createJob("ecmwf");
    const replace = (headers, body = definition({ args: ["--models", "ecmwf"] })) => call("/v1/jobs/ecmwf", { method: "PUT", body, headers });
    expect((await replace({})).status).toBe(428);
    const stale = await replace({ "if-match": '"7"' });
    expect([stale.status, stale.body.code]).toEqual([412, "revision_mismatch"]);
    expect((await replace({ "if-match": "abc" })).status).toBe(400);
    const saved = await replace({ "if-match": '"1"' });
    expect([saved.status, saved.body.revision, saved.headers.get("etag")]).toEqual([200, 2, '"2"']);
    expect(saved.body.args).toEqual(["--models", "ecmwf"]);
    // The same request again is now stale; an unchanged definition writes nothing.
    expect((await replace({ "if-match": '"1"' })).status).toBe(412);
    expect((await replace({ "if-match": 'W/"2"' })).body.revision).toBe(2);
    expect((await call("/v1/jobs/new", { method: "PUT", body: definition(), headers: { "if-match": '"1"' } })).status).toBe(412);
    const entries = await audit();
    expect(entries.map((entry) => entry.action)).toEqual(["job.create", "job.update"]);
    expect(JSON.parse(entries[1].before_json)).toEqual({ args: [] });
    expect(JSON.parse(entries[1].after_json)).toEqual({ args: ["--models", "ecmwf"] });
  });

  it("edits a timetable like the local controller (PATCH or POST), keeping the next slot's place", async () => {
    const created = Date.parse("2026-10-11T07:00:00Z");
    await createJob("gfs", { schedule: { at: { hours: [4, 10], minutes: [0] } } }, { now: created });
    const response = await call("/v1/jobs/gfs/timetable", { method: "PATCH", body: { hours: [22, 4, 6], minutes: [30, 0] }, now: Date.parse("2026-10-11T06:45:00Z") });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, revision: 2, schedule: { at: { hours: [4, 6, 22], minutes: [0, 30] } }, reload: { restartRequired: [] } });
    // Moving onto 06:30, which has just passed, does not fire it.
    expect((await rows("SELECT last_slot_at FROM schedule_state"))[0].last_slot_at).toBe(Date.parse("2026-10-11T06:30:00Z"));
    await cron("2026-10-11T06:46:00Z");
    expect(await rows("SELECT * FROM runs")).toEqual([]);

    const off = await call("/v1/jobs/gfs/timetable", { method: "POST", body: { enabled: false } });
    expect([off.body.enabled, off.body.revision]).toEqual([false, 3]);
    expect((await call("/v1/jobs/gfs/timetable", { method: "PATCH", body: { hours: "every" } })).body.schedule).toEqual({ at: { minutes: [0, 30] } });
    expect((await call("/v1/jobs/gfs/timetable", { method: "PATCH", body: { hours: [24] } })).status).toBe(400);
    expect((await call("/v1/jobs/gfs/timetable", { method: "PATCH", body: { memory: 1 } })).body.error).toMatch(/Unknown timetable field/);
    expect((await call("/v1/jobs/gfs/timetable", { method: "PATCH", body: { enabled: true }, headers: { "if-match": '"1"' } })).status).toBe(412);
    const same = await call("/v1/jobs/gfs/timetable", { method: "PATCH", body: { enabled: false } });
    expect([same.body.revision, same.body.changed]).toEqual([4, []]);
    expect((await audit()).map((entry) => entry.action)).toEqual(["job.create", "job.timetable", "job.timetable", "job.timetable"]);
    await createJob("sweep", { schedule: { every: "1h" } });
    expect((await call("/v1/jobs/sweep/timetable", { method: "PATCH", body: { minutes: [5] } })).body.error).toMatch(/interval/);
  });

  it("runs a job now, once, and pauses and resumes it", async () => {
    await createJob("ecmwf", { placement: { preferMachines: ["mac-mini"] } });
    const run = await call("/v1/jobs/ecmwf/run", { method: "POST", body: { extraParameters: ["--ecmwf-cycle", "12"] } });
    expect(run.status).toBe(202);
    expect(run.body).toMatchObject({ event: "job_submitted", job: "ecmwf", source: "manual" });
    const [stored] = await rows("SELECT * FROM runs");
    expect(stored).toMatchObject({ id: run.body.runId, state: "due", source: "manual", slot_at: null, requested_by: OWNER,
      parameters_json: '["--ecmwf-cycle","12"]' });
    expect(stored.preferred_until - stored.due_at).toBe(300_000);
    expect((await call("/v1/jobs/ecmwf/run", { method: "POST" })).status).toBe(409);
    await env.DB.prepare("UPDATE runs SET state = 'running'").run();
    expect((await call("/v1/jobs/ecmwf/run", { method: "POST" })).body.error).toMatch(/active run/);
    expect((await call("/v1/jobs/ecmwf/run", { method: "POST", body: { force: true } })).status).toBe(202);
    expect((await call("/v1/jobs/ecmwf/run", { method: "POST", body: { extraParameters: [1] } })).status).toBe(400);

    expect((await call("/v1/jobs/ecmwf/pause", { method: "POST" })).body).toEqual({ event: "job_paused", job: "ecmwf", changed: true });
    expect((await call("/v1/jobs/ecmwf/pause", { method: "POST" })).body.changed).toBe(false);
    expect((await call("/v1/jobs/ecmwf")).body).toMatchObject({ paused: true, revision: 1 });
    expect((await call("/v1/jobs/ecmwf/resume", { method: "POST" })).body.event).toBe("job_resumed");
    expect((await call("/v1/jobs/nope/run", { method: "POST" })).status).toBe(404);
    expect((await audit()).map((entry) => entry.action)).toEqual(["job.create", "job.run", "job.run", "job.pause", "job.resume"]);
  });
});

describe("overview", () => {
  it("serves a snapshot in the shape the dashboard and the menu bar app read", async () => {
    const created = Date.parse("2026-10-11T07:00:00Z");
    await createJob("harmonie", {
      description: "HARMONIE", labels: { models: "harmonie" }, args: ["--models", "harmonie"],
      report: { format: "json-lines", trackEvent: "forecast_complete", trackBy: "model" },
    }, { now: created });
    await createJob("gfs", { schedule: { every: "6h" } }, { now: created });
    await call("/v1/jobs/gfs/pause", { method: "POST" });
    const finished = Date.parse("2026-10-11T06:05:00Z");
    await env.DB.prepare(`INSERT INTO runs (id, job_id, job_revision, source, state, outcome, exit_code, due_at, started_at, finished_at,
        metrics_json, published_json, peak_memory_bytes, created_at, updated_at)
      VALUES ('r_01M4NY315G5RXDH30FP5J39JFF', 'harmonie', 1, 'schedule', 'succeeded', 'published', 0, ?1, ?2, ?3,
        '{"seconds":240}', '[{"key":"harmonie","run":"2026101106"}]', 524288000, ?1, ?3)`)
      .bind(Date.parse("2026-10-11T06:00:00Z"), Date.parse("2026-10-11T06:01:00Z"), finished).run();
    await env.DB.prepare(`UPDATE schedule_state SET published_json = '{"harmonie":{"run":"2026101106","at":"2026-10-11T06:04:00Z","seconds":240}}'
      WHERE job_id = 'harmonie'`).run();
    await call("/v1/jobs/harmonie/run", { method: "POST" });

    const { status, body, elapsed } = await call("/v1/snapshot", { now: Date.parse("2026-10-11T07:30:00Z") });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      version: 1,
      controller: { status: "online", kind: "hosted", globalPause: false },
      timetable: { editable: true },
      nodes: [],
      nodeCount: 0,
      machines: [],
    });
    expect(body.controller.features).toContain("history");
    const [gfs, harmonie] = body.jobs;
    expect(harmonie).toMatchObject({
      id: "harmonie", description: "HARMONIE", enabled: true, configuredEnabled: true, paused: false,
      schedule: { at: { hours: [8, 10], minutes: [20] }, timezone: "UTC" },
      parameters: ["--models", "harmonie"], labels: { models: "harmonie" },
      running: true, activeState: "Queued", liveState: "Queued", phase: "due",
      lastFinishedJobId: "r_01M4NY315G5RXDH30FP5J39JFF", lastFinishedAt: "2026-10-11T06:05:00.000Z",
      lastFinishedState: "Completed", lastOutcome: "published", lastExitCode: 0,
      published: { harmonie: { run: "2026101106", at: "2026-10-11T06:04:00Z", seconds: 240 } },
      nextDueAt: null,
      runsUrl: "/v1/jobs/harmonie/runs",
    });
    expect(harmonie.activeJobId).toMatch(/^r_/);
    expect(harmonie.recentRuns).toHaveLength(2);
    expect(harmonie.recentRuns[1]).toMatchObject({
      id: "r_01M4NY315G5RXDH30FP5J39JFF", job: "harmonie", state: "Completed", phase: "succeeded", outcome: "published",
      submittedAt: "2026-10-11T06:00:00.000Z", startedAt: "2026-10-11T06:01:00.000Z", finishedAt: "2026-10-11T06:05:00.000Z",
      queueSeconds: 60, durationSeconds: 240, exitCode: 0, metrics: { peakMemoryMb: 500, seconds: 240 },
      published: [{ key: "harmonie", run: "2026101106" }],
    });
    expect(harmonie.recentRuns[1].reports).toBeUndefined();
    expect(gfs).toMatchObject({ id: "gfs", enabled: false, configuredEnabled: true, paused: true, running: false, nextDueAt: null, schedule: { every: "6h" } });
    expect(elapsed).toBeLessThan(250);
  });

  it("lists a job's runs newest first, with paging, and a run with its log", async () => {
    await createJob("blend", { schedule: { at: { minutes: [5] } } }, { now: Date.parse("2026-10-11T00:00:00Z") });
    for (let hour = 0; hour < 5; hour += 1) await cron(Date.parse(`2026-10-11T0${hour}:05:00Z`));
    const page = await call("/v1/jobs/blend/runs?limit=3");
    expect(page.body.runs.map((run) => [run.state, run.skipReason])).toEqual([
      ["Skipped", "coalesced"], ["Skipped", "coalesced"], ["Skipped", "coalesced"]]);
    const rest = await call(`/v1/jobs/blend/runs?limit=3&before=${page.body.next}`);
    expect(rest.body.runs.map((run) => run.state)).toEqual(["Skipped", "Queued"]);
    expect(rest.body.next).toBe(null);
    expect((await call("/v1/jobs/blend/runs?limit=0")).status).toBe(400);

    const id = rest.body.runs[1].id;
    await env.DB.prepare("INSERT INTO run_logs (run_id, tail, bytes_total, truncated, final, updated_at) VALUES (?, ?, 64, 0, 0, 1)")
      .bind(id, "starting\nTraceback (most recent call last):\n  File \"x.py\"\nOSError: disk full\n").run();
    expect((await call(`/v1/runs/${id}`)).body).toMatchObject({ id, job: "blend", phase: "due" });
    const log = await call(`/v1/runs/${id}/logs`);
    expect(log.body).toMatchObject({ runId: id, job: "blend", active: true, partial: true, errorCount: 3, bytes: 64 });
    expect(log.body.lines.map((line) => line.level)).toEqual(["info", "error", "error", "error"]);
    expect((await call("/v1/runs/r_nope/logs")).status).toBe(404);
    expect((await call("/v1/runs/r_01M4NY315G5RXDH30FP5J39JFZ")).status).toBe(404);
  });

  it("answers /v1/changes with 204 until something changes", async () => {
    await createJob("gfs");
    const first = await call("/v1/changes");
    expect(first.status).toBe(200);
    expect((await call(`/v1/changes?since=${first.body.cursor}`)).status).toBe(204);
    await call("/v1/jobs/gfs/pause", { method: "POST" });
    const afterPause = await call(`/v1/changes?since=${first.body.cursor}`);
    expect(afterPause.status).toBe(200);
    await call("/v1/jobs/gfs/run", { method: "POST" });
    expect((await call(`/v1/changes?since=${afterPause.body.cursor}`)).status).toBe(200);
  });

  it("pages the audit log for admins only", async () => {
    await call("/v1/settings", { method: "PATCH", body: { roles: { "op@example.com": "operator" } } });
    for (const id of ["a", "b", "c"]) await createJob(id);
    const page = await call("/v1/audit?limit=2");
    expect(page.body.entries.map((entry) => [entry.action, entry.target])).toEqual([["job.create", "c"], ["job.create", "b"]]);
    const rest = await call(`/v1/audit?limit=2&before=${page.body.next}`);
    expect(rest.body.entries.map((entry) => entry.action)).toEqual(["job.create", "settings.update"]);
    expect(rest.body.entries[1]).toMatchObject({ actor: OWNER, after: { roles: { "op@example.com": "operator" } } });
    expect((await call("/v1/audit", { identity: "op@example.com" })).status).toBe(403);
  });

  it("keeps settings: global pause, retention, roles and the desired agent version, each change audited", async () => {
    const initial = await call("/v1/settings");
    expect(initial.body).toEqual({
      globalPause: false, retention: expect.objectContaining({ runDays: 180, keepRunsPerJob: 50 }), roles: {}, desiredAgentVersion: null,
      cloudflare: { maxConcurrent: 1, maxRunSeconds: 1200, labels: {} },
    });
    const changed = await call("/v1/settings", { method: "PATCH", body: { retention: { runDays: 90 }, globalPause: true } });
    expect(changed.body).toMatchObject({ globalPause: true, retention: { runDays: 90, skippedDays: 14 }, changed: ["retention", "globalPause"] });
    expect((await call("/v1/settings", { method: "PATCH", body: { globalPause: true } })).body.changed).toEqual([]);
    expect((await call("/v1/settings", { method: "PATCH", body: { retention: { runDays: 0 } } })).status).toBe(400);
    expect((await call("/v1/settings", { method: "PATCH", body: { roles: { "me@example.com": "god" } } })).status).toBe(400);
    expect((await call("/v1/settings", { method: "PATCH", body: { vault: 1 } })).status).toBe(400);
    expect((await call("/v1/settings", { method: "PATCH", body: { desiredAgentVersion: "latest" } })).status).toBe(400);
    expect((await audit()).map((entry) => entry.action)).toEqual(["settings.update"]);
    expect((await call("/v1/settings", { method: "PATCH", body: { desiredAgentVersion: "0.3.0" } })).body.desiredAgentVersion).toBe("0.3.0");
    expect((await call("/v1/settings", { method: "PATCH", body: { desiredAgentVersion: null } })).body.desiredAgentVersion).toBe(null);
    expect((await call("/v1/snapshot")).body.controller.globalPause).toBe(true);
  });

  it("serves the dashboard's files from the assets binding, and 404s/405s unknown API paths", async () => {
    const seen = [];
    const assetsEnv = { ...env, ASSETS: { fetch: async (request) => { seen.push(new URL(request.url).pathname); return new Response("ok"); } } };
    const { handle } = await import("../src/hc-web.mjs");
    await handle(new Request(`${ORIGIN}/assets/app.js`), assetsEnv);
    await handle(new Request(`${ORIGIN}/`), assetsEnv);
    expect(seen).toEqual(["/app.js", "/"]);
    expect((await call("/v1/nope")).status).toBe(404);
    expect((await call("/v1/snapshot", { method: "DELETE" })).status).toBe(405);
  });
});

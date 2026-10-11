import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import wingfoil from "../../test/fixtures/wingfoil-home-compute.json";
import preset from "../../presets/wingfoil.json";
import { call, cron, mockCertificates, resetDatabase, rows } from "./helpers.mjs";

const IMAGE = "ghcr.io/sprintengine/wingfoil-forecast@sha256:4f5e6d7c8b9a";
const NOW = Date.parse("2026-10-11T07:00:00Z");
let certificates;

beforeEach(async () => {
  await resetDatabase();
  certificates = mockCertificates();
});
afterEach(() => certificates.mockRestore());

function importFile({ dryRun = false, force, pause, variables = { WINGFOIL_IMAGE: IMAGE }, config = wingfoil, now = NOW } = {}) {
  return call(`/v1/import${dryRun ? "?dryRun=1" : ""}`, { method: "POST", body: { config, preset, variables, force, pause }, now });
}

const counts = async () => (await rows(`SELECT (SELECT COUNT(*) FROM jobs) AS jobs, (SELECT COUNT(*) FROM audit_log) AS audit,
  (SELECT value_json FROM settings WHERE key = 'jobs_version') AS version`))[0];

describe("import", () => {
  it("dry-runs the Wingfoil file as a per-job diff without writing anything", async () => {
    const { status, body } = await importFile({ dryRun: true });
    expect(status).toBe(200);
    expect(body).toMatchObject({ dryRun: true, preset: "wingfoil", summary: { create: 21, update: 0, kept: 0, unchanged: 0 }, notInFile: [] });
    const ecmwf = body.jobs.find((job) => job.id === "ecmwf");
    expect(ecmwf.action).toBe("create");
    expect(ecmwf.changes.find((change) => change.field === "timeouts").after).toEqual({ runSeconds: 3900, maxLatenessSeconds: null });
    expect(ecmwf.warnings).toEqual(["optional S3_PREFIX, FORCE5_BROTLI_QUALITY not set by the preset, so not passed"]);
    expect(await counts()).toEqual({ jobs: 0, audit: 0, version: null });
  });

  it("applies it: every job, schedule, resource and reference as in the file", async () => {
    const { body } = await importFile();
    expect(body.summary.create).toBe(21);
    for (const v1 of wingfoil.jobs) {
      const job = (await call(`/v1/jobs/${v1.id}`)).body;
      expect(job).toMatchObject({
        id: v1.id, enabled: v1.enabled !== false, paused: false, preset: "wingfoil", revision: 1, image: IMAGE,
        args: v1.task.parameters ?? [], entrypoint: v1.task.entrypoint ?? null, labels: v1.labels,
        report: v1.task.report ?? null, network: "bridge",
        placement: { preferMachines: ["mac-mini"], preferWaitSeconds: 300 },
        timeouts: { runSeconds: v1.task.timeouts.totalSeconds - v1.task.timeouts.queueSeconds, maxLatenessSeconds: null },
      });
      expect(job.schedule).toEqual({ at: { ...(v1.schedule.at.hours ? { hours: v1.schedule.at.hours } : {}), minutes: v1.schedule.at.minutes } });
      const memory = Number.parseFloat(v1.task.resources.memory) * (/Gb$/.test(v1.task.resources.memory) ? 1024 : 1);
      expect(job.resources).toEqual({ cpus: Number(v1.task.resources.cpu), memoryMiB: memory, diskMiB: Number.parseFloat(v1.task.resources.disk) * 1024 });
      expect(job.secretEnv).toEqual(Object.fromEntries(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "S3_BUCKET", "S3_ENDPOINT_URL"]
        .map((name) => [name, `vault:${preset.secrets[name]}`])));
      expect(job.policy).toMatchObject({ overlap: "coalesce", catchUp: "latest", retry: { maxAttempts: 3, onLostRunning: true, onFailed: 0 } });
    }
    const audit = await rows("SELECT action, target FROM audit_log ORDER BY id");
    expect(audit).toHaveLength(22);
    expect(audit.at(-1)).toEqual({ action: "import.apply", target: "wingfoil" });
    // Imported jobs wait for their next slot rather than all running at once.
    await cron(NOW + 60_000);
    expect(await rows("SELECT * FROM runs")).toEqual([]);
  });

  it("is idempotent: the same file again changes and audits nothing", async () => {
    await importFile();
    const before = await counts();
    const again = await importFile({ now: NOW + 60_000 });
    expect(again.body.summary).toEqual({ create: 0, update: 0, kept: 0, unchanged: 21 });
    expect(await counts()).toEqual(before);
    expect((await rows("SELECT DISTINCT revision FROM jobs"))).toEqual([{ revision: 1 }]);
  });

  it("updates what the file changed, keeps what the dashboard changed since, unless forced", async () => {
    await importFile();
    await call("/v1/jobs/ecmwf/timetable", { method: "PATCH", body: { minutes: [25] } });
    const edited = structuredClone(wingfoil);
    const ecmwf = edited.jobs.find((job) => job.id === "ecmwf");
    ecmwf.schedule.at.minutes = [30];
    ecmwf.task.parameters = [...ecmwf.task.parameters, "--fast"];
    const plan = await importFile({ config: edited, dryRun: true });
    const entry = plan.body.jobs.find((job) => job.id === "ecmwf");
    expect(entry.action).toBe("update");
    expect(entry.changes.map((change) => change.field)).toEqual(["args"]);
    expect(entry.kept).toEqual([{ field: "schedule", before: { at: { hours: [8, 10], minutes: [25] } },
      after: { at: { hours: [8, 10], minutes: [30] } }, reason: "edited since the last import" }]);
    await importFile({ config: edited });
    let job = (await call("/v1/jobs/ecmwf")).body;
    expect([job.schedule.at.minutes, job.args.at(-1), job.revision]).toEqual([[25], "--fast", 3]);
    await importFile({ config: edited, force: true });
    job = (await call("/v1/jobs/ecmwf")).body;
    expect([job.schedule.at.minutes, job.revision]).toEqual([[30], 4]);
    const last = (await rows("SELECT action, before_json, after_json FROM audit_log WHERE target = 'ecmwf' ORDER BY id DESC LIMIT 1"))[0];
    expect([last.action, JSON.parse(last.after_json)]).toEqual(["job.update", { schedule: { at: { hours: [8, 10], minutes: [30] } } }]);
  });

  it("imports new jobs paused on request, and never deletes jobs missing from the file", async () => {
    await call("/v1/jobs/hello", { method: "PUT", body: { image: "hello-world", schedule: null } });
    const { body } = await importFile({ pause: true });
    expect(body.notInFile).toEqual(["hello"]);
    expect((await rows("SELECT COUNT(*) AS n FROM jobs WHERE paused = 1"))[0].n).toBe(21);
    expect((await rows("SELECT id FROM jobs WHERE id = 'hello'"))).toHaveLength(1);
  });

  it("refuses a malformed file, preset or image variable with the reason", async () => {
    expect((await call("/v1/import", { method: "POST", body: { config: {} } })).status).toBe(400);
    expect((await call("/v1/import", { method: "POST", body: { config: wingfoil } })).body.error).toMatch(/needs WINGFOIL_IMAGE/);
    expect((await importFile({ variables: { WINGFOIL_IMAGE: "" } })).status).toBe(400);
    const tagged = await importFile({ variables: {}, dryRun: true });
    expect(tagged.body.jobs[0].changes.find((change) => change.field === "image").after)
      .toBe("ghcr.io/sprintengine/wingfoil-forecast:production", "the preset's default until --image pins a digest");
    const badPreset = await call("/v1/import", { method: "POST", body: { config: wingfoil, preset: { ...preset, secrets: { S3_BUCKET: "Bad Name" } } } });
    expect(badPreset.status).toBe(422);
    const badJob = structuredClone(wingfoil);
    badJob.jobs[0].schedule = { at: { hours: [25] } };
    expect((await importFile({ config: badJob })).body.error).toMatch(/jobs\[0\] \(harmonie\).*0 to 23/);
    expect((await importFile({ config: { jobs: [wingfoil.jobs[0], wingfoil.jobs[0]] } })).body.error).toMatch(/Duplicate/);
    expect((await call("/v1/import", { method: "POST", body: { config: wingfoil, preset }, identity: "service:nobody" })).status).toBe(403);
    expect((await rows("SELECT COUNT(*) AS n FROM jobs"))[0].n).toBe(0);
  });
});

describe("cost per request with the real timetable (21 jobs)", () => {
  it("stays small: wall time in local workerd, D1 included, as an upper bound for CPU", async () => {
    const timings = {};
    timings.importDryRun = (await importFile({ dryRun: true })).elapsed;
    timings.importApply = (await importFile()).elapsed;
    timings.importAgain = (await importFile({ now: NOW + 1 })).elapsed;
    for (const job of ["blend", "prune", "wind-obs"]) await call(`/v1/jobs/${job}/run`, { method: "POST" });
    const snapshot = await call("/v1/snapshot");
    expect([snapshot.status, snapshot.body.jobs?.length]).toEqual([200, 21]);
    timings.snapshot = snapshot.elapsed;
    timings.session = (await call("/v1/session")).elapsed;
    timings.changes = (await call("/v1/changes")).elapsed;
    timings.pause = (await call("/v1/jobs/gfs/pause", { method: "POST" })).elapsed;
    let started = performance.now();
    const summary = await cron(Date.parse("2026-10-11T10:20:00Z"));
    timings.cronWithSlots = performance.now() - started;
    expect(summary.materialised.jobs).toBe(21);
    started = performance.now();
    await cron(Date.parse("2026-10-11T10:21:00Z"));
    timings.cronIdle = performance.now() - started;
    console.log(JSON.stringify({ event: "timings_ms", ...timings }));
    // Loose bounds that catch a regression by an order of magnitude, not jitter.
    for (const [name, ms] of Object.entries(timings)) expect(ms, name).toBeLessThan(500);
  });
});

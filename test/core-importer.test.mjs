import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { validateConfig } from "../src/config.mjs";
import { jobFromV1, parseCpus, parseMiB, planImport, validatePreset } from "../src/core/importer.mjs";

const root = path.resolve(import.meta.dirname, "..");
const readJson = async (file) => JSON.parse(await readFile(path.join(root, file), "utf8"));
const IMAGE = "ghcr.io/sprintengine/wingfoil-forecast@sha256:0123456789abcdef";

test("Bacalhau resource strings become numbers", () => {
  assert.deepEqual(["1", "0.5", "500m", 2].map(parseCpus), [1, 0.5, 0.5, 2]);
  assert.deepEqual(["512Mb", "1Gb", "12Gb", "2GiB", "1.5Gb", "1024Kb"].map(parseMiB), [512, 1024, 12288, 2048, 1536, 1]);
  assert.throws(() => parseMiB("lots"), /Invalid size/);
  assert.throws(() => parseCpus("two"), /Invalid CPU/);
});

test("the Wingfoil preset is valid and holds references, not secrets", async () => {
  const preset = validatePreset(await readJson("presets/wingfoil.json"));
  assert.equal(preset.id, "wingfoil");
  assert.deepEqual(Object.keys(preset.secrets).sort(), ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "S3_BUCKET", "S3_ENDPOINT_URL"]);
  assert.throws(() => validatePreset({ id: "x", secrets: { A: "Not A Name" } }), /secret name/);
  assert.throws(() => validatePreset({ id: "x", secrets: { A: "a" }, env: { A: "1" } }), /both/);
  assert.throws(() => validatePreset({ id: "x", extra: 1 }), /Unknown preset field/);
  assert.throws(() => validatePreset({ id: "x", freshness: { outputs: { a: { maxAgeHours: 3, pointer: "a.json" } } } }), /needs baseUrl/);
  assert.throws(() => validatePreset({ id: "x", freshness: { baseUrl: "http://x/", outputs: {} } }), /baseUrl must be an https/);
  assert.throws(() => validatePreset({ id: "x", freshness: { baseUrl: "https://x/", outputs: { a: { maxAgeHours: 0 } } } }), /maxAgeHours/);
  assert.throws(() => validatePreset({ id: "x", freshness: { baseUrl: "https://x/", outputs: { a: { maxAgeHours: 1, pointer: "../a" } } } }), /relative path/);
});

test("every Wingfoil job imports with its timetable, resources, timeouts and env", async () => {
  const config = await readJson("test/fixtures/wingfoil-home-compute.json");
  validateConfig(config);
  const preset = validatePreset(await readJson("presets/wingfoil.json"));
  const imported = config.jobs.map((v1) => ({ v1, ...jobFromV1(v1, { preset, variables: { WINGFOIL_IMAGE: IMAGE } }) }));
  assert.equal(imported.length, 21);
  for (const { v1, job, warnings } of imported) {
    assert.equal(job.id, v1.id);
    assert.equal(job.enabled, v1.enabled !== false, v1.id);
    assert.equal(job.description, v1.description);
    assert.equal(job.image, IMAGE);
    assert.deepEqual(job.args, v1.task.parameters ?? []);
    assert.deepEqual(job.entrypoint, v1.task.entrypoint ?? null);
    assert.deepEqual(job.schedule.at.hours, v1.schedule.at.hours, v1.id);
    assert.deepEqual(job.schedule.at.minutes, v1.schedule.at.minutes, v1.id);
    assert.equal(job.resources.cpus, Number(v1.task.resources.cpu));
    assert.equal(job.resources.memoryMiB, parseMiB(v1.task.resources.memory));
    assert.equal(job.resources.diskMiB, parseMiB(v1.task.resources.disk));
    assert.equal(job.timeouts.runSeconds, v1.task.timeouts.totalSeconds - v1.task.timeouts.queueSeconds);
    assert.equal(job.timeouts.maxLatenessSeconds, null, "catch-up latest never expires a run");
    const { freshness, ...report } = job.report ?? {};
    assert.deepEqual(job.report ? report : null, v1.task.report ?? null);
    // The stale-output alert: each model's limit and published pointer, from the preset by the job's `models` label.
    if (job.report) assert.deepEqual(Object.keys(freshness), [v1.labels.models], v1.id);
    assert.deepEqual(job.labels, v1.labels);
    assert.deepEqual(job.placement, { requireLabels: { pool: "wingfoil" }, preferMachines: ["mac-mini"], preferWaitSeconds: 300 });
    assert.equal(job.registryAuth, "vault:ghcr-read");
    assert.deepEqual([job.policy.overlap, job.policy.catchUp, job.policy.retry.onLostRunning], ["coalesce", "latest", true]);
    assert.equal(job.network, "bridge");
    // Secrets are references to the vault; plain values come only from the preset.
    for (const name of v1.task.requiredEnv) assert.ok(job.secretEnv[name] || job.env[name], `${v1.id} ${name}`);
    assert.ok(Object.values(job.secretEnv).every((reference) => reference.startsWith("vault:wingfoil-r2-")));
    assert.deepEqual(warnings, ["optional S3_PREFIX, FORCE5_BROTLI_QUALITY not set by the preset, so not passed"]);
  }
  const byId = Object.fromEntries(imported.map(({ job }) => [job.id, job]));
  assert.deepEqual(byId.ecmwf.env, { AWS_REGION: "auto", ECMWF_SOURCE: "ecmwf", FORCE5_SIDECARS: "0" });
  assert.deepEqual(byId.ecmwf.timeouts, { runSeconds: 3900, maxLatenessSeconds: null }, "importer timeout 3300 s + 600 s start margin");
  assert.deepEqual(byId.ecmwf.resources, { cpus: 1, memoryMiB: 1024, diskMiB: 12288 });
  assert.deepEqual(byId.prune.resources, { cpus: 0.5, memoryMiB: 512, diskMiB: 1024 });
  assert.equal(byId.prune.env.FORCE5_SIDECARS, undefined, "prune never asked for it");
  assert.equal(byId.prune.report, null);
  assert.deepEqual(byId.gfs.report.freshness, { gfs: { maxAgeHours: 12, url: "https://data.wingfoil.ie/weather/gfs.json" } });
  assert.deepEqual(byId["icon-eu"].report.freshness, { "icon-eu": { maxAgeHours: 30, url: "https://data.wingfoil.ie/weather/latest.json" } });
  assert.equal(byId["harmonie-eps"].schedule.at.hours, undefined, "hourly stays hourly");
  assert.deepEqual(imported.filter(({ job }) => !job.enabled).map(({ job }) => job.id),
    ["harmonie-eps", "ecmwf-ens", "aifs", "gefs", "arpege", "arome", "ecmwf-wave"]);
});

test("without a preset, required names come from the agent's env file and the image must be given", () => {
  const v1 = { id: "a", schedule: { every: "1h" }, task: { image: "${IMAGE}", requiredEnv: ["TOKEN"], passEnv: ["DEBUG"], network: { type: "None" } } };
  assert.throws(() => jobFromV1(v1), /needs IMAGE/);
  const { job, warnings } = jobFromV1(v1, { variables: { IMAGE: "x:1" } });
  assert.deepEqual(job.secretEnv, { TOKEN: "local:TOKEN" });
  assert.equal(job.network, "none");
  assert.deepEqual(job.timeouts, { runSeconds: 3600, maxLatenessSeconds: null });
  assert.equal(warnings.length, 2);
  const strict = jobFromV1({ ...v1, task: { ...v1.task, timeouts: { queueSeconds: 600, totalSeconds: 1200 } } },
    { preset: validatePreset({ id: "p", policy: { catchUp: "none" } }), variables: { IMAGE: "x:1" } }).job;
  assert.deepEqual(strict.timeouts, { runSeconds: 600, maxLatenessSeconds: 600 }, "the queue limit becomes the lateness limit");
});

test("an import plan creates, updates, and keeps what the dashboard changed since the last import", () => {
  const base = jobFromV1({ id: "a", schedule: { at: { minutes: [5] } }, task: { image: "x:1" } }).job;
  const other = jobFromV1({ id: "b", schedule: { every: "1h" }, task: { image: "x:1" } }).job;
  const created = planImport({ incoming: [base] });
  assert.deepEqual(created.jobs.map((job) => job.action), ["create"]);
  assert.deepEqual(created.summary, { create: 1, update: 0, kept: 0, unchanged: 0 });

  const same = planImport({ incoming: [base], existing: { a: base, b: other }, baseline: { a: base } });
  assert.deepEqual(same.jobs.map((job) => job.action), ["unchanged"]);
  assert.deepEqual(same.notInFile, ["b"], "never deleted, only listed");

  // The schedule was edited from a phone since the import; the file changes the image and the schedule.
  const edited = { ...base, schedule: { at: { minutes: [35] } } };
  const incoming = { ...base, image: "x:2", schedule: { at: { minutes: [10] } } };
  const plan = planImport({ incoming: [incoming], existing: { a: edited }, baseline: { a: base } });
  assert.equal(plan.jobs[0].action, "update");
  assert.deepEqual(plan.jobs[0].changes.map((change) => change.field), ["image"]);
  assert.deepEqual(plan.jobs[0].kept.map((change) => [change.field, change.before, change.after]),
    [["schedule", { at: { minutes: [35] } }, { at: { minutes: [10] } }]]);
  assert.deepEqual(plan.jobs[0].next.schedule, { at: { minutes: [35] } });
  const forced = planImport({ incoming: [incoming], existing: { a: edited }, baseline: { a: base }, force: true });
  assert.deepEqual(forced.jobs[0].next.schedule, { at: { minutes: [10] } });
  const onlyKept = planImport({ incoming: [{ ...base, schedule: { at: { minutes: [10] } } }], existing: { a: edited }, baseline: { a: base } });
  assert.equal(onlyKept.jobs[0].action, "kept");
  assert.throws(() => planImport({ incoming: [base, base] }), /Duplicate/);
});

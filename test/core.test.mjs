import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { constantTimeEqual, csrfRefusal, originMatches } from "../src/core/csrf.mjs";
import { newId, ulid } from "../src/core/ids.mjs";
import { jobDifferences, jobEnvironmentNames, normaliseJob } from "../src/core/job.mjs";
import { publishedEntries, runOutcome, trackPublished } from "../src/core/reports.mjs";
import { applyTimetable, timetableChange } from "../src/core/timetable.mjs";

const CORE = path.resolve(import.meta.dirname, "../src/core");

test("core modules import nothing from Node or outside src/core, so Workers can run them", async () => {
  const files = (await readdir(CORE)).filter((name) => name.endsWith(".mjs"));
  assert.ok(files.length >= 10);
  for (const name of files) {
    const text = await readFile(path.join(CORE, name), "utf8");
    for (const [, specifier] of text.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+["']([^"']+)["']/gm)) {
      assert.match(specifier, /^\.\/[a-z-]+\.mjs$/, `${name} imports ${specifier}`);
    }
    assert.doesNotMatch(text, /\b(?:process|Buffer|require)\b\s*[.(]/, `${name} uses a Node global`);
  }
});

test("a hosted job is normalised: defaults filled, keys ordered, references only", () => {
  const job = normaliseJob({ id: "ecmwf", image: "ghcr.io/x/y@sha256:abc", schedule: { at: { hours: [10, 8, 8] }, timezone: "UTC" } });
  assert.deepEqual(job, {
    id: "ecmwf", description: null, enabled: true, image: "ghcr.io/x/y@sha256:abc", entrypoint: null, args: [],
    env: {}, secretEnv: {},
    resources: { cpus: 1, memoryMiB: 2048, diskMiB: 2048 },
    timeouts: { runSeconds: 3600, maxLatenessSeconds: null },
    schedule: { at: { hours: [8, 10], minutes: [0] } },
    placement: {},
    policy: { overlap: "coalesce", catchUp: "latest", retry: { maxAttempts: 3, onLostRunning: false, lostGraceSeconds: 600, onFailed: 0, backoffSeconds: 300 }, priority: 0 },
    report: null, network: "bridge", labels: {}, registryAuth: null,
  });
  assert.deepEqual(normaliseJob(job), job, "normalising is idempotent");
  assert.deepEqual(normaliseJob({ ...job, env: { B: "2", A: "1" } }).env, { A: "1", B: "2" });
  for (const [change, message] of [
    [{ id: "Bad" }, /Invalid job id/],
    [{ image: "" }, /image/],
    [{ image: "a b" }, /spaces/],
    [{ schedule: { at: { hours: [24] } } }, /0 to 23/],
    [{ schedule: { every: "5" } }, /Invalid duration/],
    [{ schedule: { at: {}, timezone: "Europe/Dublin" } }, /UTC/],
    [{ env: { "bad-name": "x" } }, /invalid environment name/],
    [{ env: { A: 1 } }, /must be a string/],
    [{ secretEnv: { A: "plaintext" } }, /vault:/],
    [{ secretEnv: { A: "vault:Bad Name" } }, /vault:/],
    [{ env: { A: "1" }, secretEnv: { A: "vault:a" } }, /both env and secretEnv/],
    [{ resources: { cpus: 0 } }, /cpus/],
    [{ resources: { memoryMiB: 1.5 } }, /memoryMiB/],
    [{ timeouts: { runSeconds: 0 } }, /runSeconds/],
    [{ policy: { overlap: "queue" } }, /overlap/],
    [{ policy: { catchUp: "all" } }, /catchUp/],
    [{ network: "host" }, /network/],
    [{ report: { format: "text" } }, /json-lines/],
    [{ entrypoint: [] }, /entrypoint/],
    [{ args: ["--a", 1] }, /args/],
    [{ registryAuth: "ghcr-read" }, /registryAuth/],
    [{ registryAuth: "vault:Bad Name" }, /registryAuth/],
  ]) {
    assert.throws(() => normaliseJob({ ...job, ...change }), message, JSON.stringify(change));
  }
});

test("job differences name each changed field with both values", () => {
  const before = normaliseJob({ id: "a", image: "x", schedule: { every: "1h" } });
  const after = normaliseJob({ ...before, image: "y", schedule: { every: "2h" } });
  assert.deepEqual(jobDifferences(before, after), [
    { field: "image", before: "x", after: "y" },
    { field: "schedule", before: { every: "1h" }, after: { every: "2h" } },
  ]);
  assert.deepEqual(jobDifferences(before, before), []);
  assert.equal(jobDifferences(null, before).length, 16, "against nothing, every field differs");
  assert.deepEqual(jobEnvironmentNames({ task: { passEnv: ["A", "B"], requiredEnv: ["B", "C"] } }), ["A", "B", "C"]);
});

test("timetable changes are checked once for both controllers", () => {
  const job = { id: "gfs", schedule: { at: { hours: [4, 10], minutes: [0] } } };
  assert.deepEqual(timetableChange(job, { hours: [22, 4, 4], minutes: [30, 0] }), { hours: [4, 22], minutes: [0, 30] });
  assert.deepEqual(applyTimetable(job.schedule, { hours: "every", minutes: [5] }), { at: { minutes: [5] } });
  assert.deepEqual(applyTimetable(job.schedule, { enabled: false }), job.schedule);
  assert.throws(() => timetableChange(job, { hours: [24] }), (error) => error.status === 400);
  assert.throws(() => timetableChange({ id: "sweep", schedule: { every: "1h" } }, { minutes: [5] }), /interval/);
});

test("a hosted run's outcome follows the local controller's rules", () => {
  const report = { format: "json-lines", trackEvent: "forecast_complete", trackBy: "model" };
  assert.equal(runOutcome({ exitCode: 0, reports: [{ event: "forecast_complete" }], report }), "published");
  assert.equal(runOutcome({ exitCode: 0, reports: [{ event: "x_unchanged" }], report }), "unchanged");
  assert.equal(runOutcome({ exitCode: 0 }), "completed");
  assert.equal(runOutcome({ exitCode: null }), "completed", "an unknown exit is not a failure by itself");
  assert.equal(runOutcome({ exitCode: 0, oomKilled: true }), "failed");
  assert.equal(runOutcome({ exitCode: 0, timedOut: true }), "failed");

  const reports = [{ event: "forecast_complete", model: "gfs", run: "2026101106", seconds: 12, time: "2026-10-11T10:00:00Z" },
    { event: "forecast_complete", run: "2026101106" }];
  assert.deepEqual(trackPublished({ old: { run: "1" } }, reports, report, { fallbackKey: "gfs-job", at: "now", runId: "r_1" }), {
    old: { run: "1" },
    gfs: { run: "2026101106", at: "2026-10-11T10:00:00Z", seconds: 12, runId: "r_1" },
    "gfs-job": { run: "2026101106", at: "now", seconds: null, runId: "r_1" },
  });
  assert.deepEqual(publishedEntries(reports.slice(0, 1), report, "gfs-job"), [{ key: "gfs", run: "2026101106" }]);
});

test("ids are prefixed ULIDs that sort by time", () => {
  assert.equal(ulid(1469918176385, (bytes) => bytes.fill(255)), "01ARYZ6S41ZZZZZZZZZZZZZZZZ");
  assert.match(newId("r"), /^r_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(newId("r", 1000) < newId("r", 2000));
  assert.notEqual(newId("r"), newId("r"));
});

test("CSRF: JSON only, same origin, and a browser echoes its token", () => {
  const hosts = ["hc.example.com"];
  const base = { contentType: "application/json", origin: "https://hc.example.com", hosts, fetchSite: "same-origin", browser: true, token: "t", expected: "t" };
  assert.equal(csrfRefusal(base), null);
  assert.equal(csrfRefusal({ ...base, contentType: "text/plain" }), "content_type");
  assert.equal(csrfRefusal({ ...base, fetchSite: "cross-site" }), "cross_site");
  assert.equal(csrfRefusal({ ...base, origin: "https://evil.example" }), "origin");
  assert.equal(csrfRefusal({ ...base, origin: undefined }), "origin", "a browser always says where it is");
  assert.equal(csrfRefusal({ ...base, token: "u" }), "csrf_token");
  assert.equal(csrfRefusal({ ...base, expected: undefined, token: undefined }), "csrf_token");
  assert.equal(csrfRefusal({ ...base, browser: false, origin: undefined, fetchSite: undefined, token: undefined }), null,
    "a service token is not a browser");
  assert.equal(csrfRefusal({ ...base, browser: false, contentType: undefined }), "content_type");
  assert.ok(originMatches("https://HC.example.com", ["hc.example.com, proxy"]));
  assert.ok(!originMatches("not a url", hosts));
  assert.ok(constantTimeEqual("abc", "abc") && !constantTimeEqual("abc", "abd") && !constantTimeEqual("abc", "ab"));
});

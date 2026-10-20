// The local run history (agent/src/history.mjs): what a line holds and
// leaves out, how lines fold into runs, and rotation.
import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { historyEntry, historyOutcome, parseHistory, reportedEntry, RunHistory } from "../src/history.mjs";
import { tempState } from "./support.mjs";

const T0 = Date.parse("2026-10-18T12:00:00Z");

function record(overrides = {}) {
  return {
    exitCode: 0, oomKilled: false, timedOut: false, cancelled: false, failed: false, error: null, errorDetail: null, reports: [],
    logTail: { text: "SECRET_LOG_LINE", bytesTotal: 15, linesTotal: 1, truncated: false },
    stats: { peakMemoryBytes: 300 * 1048576, memoryLimitBytes: 1024 * 1048576, avgCpuPct: 41.5, peakCpuPct: 90, cpuSeconds: 12, samples: 4 },
    durations: { durationMs: 64_000, vmWaitMs: 0, pullMs: 1200 },
    image: { ref: "ghcr.io/example/worker:1", digest: "sha256:abc" },
    ...overrides,
  };
}

function claim(id, jobId = "gfs", spec = {}) {
  return {
    run: { id, jobId, attempt: 1, source: "schedule" },
    spec: { image: "ghcr.io/example/worker:1", secretEnv: { R2_SECRET_ACCESS_KEY: "r2-secret-value-123" }, registryAuth: { password: "regpass" }, ...spec },
  };
}

const line = (value) => JSON.stringify(value);

test("outcomes: cancelled, failed early, failed by exit, and what the reports say", () => {
  assert.equal(historyOutcome(record({ cancelled: true, exitCode: 143 })), "cancelled");
  assert.equal(historyOutcome(record({ exitCode: null, error: "pull failed: denied" })), "failed");
  assert.equal(historyOutcome(record({ exitCode: 1 })), "failed");
  assert.equal(historyOutcome(record({ oomKilled: true, exitCode: 137 })), "failed");
  assert.equal(historyOutcome(record()), "completed");
  const report = { trackEvent: "forecast_complete", trackBy: "model" };
  assert.equal(historyOutcome(record({ reports: [{ event: "forecast_complete", model: "gfs", run: "2026101812" }] }), report), "published");
  assert.equal(historyOutcome(record({ reports: [{ event: "gfs_unchanged" }] }), report), "unchanged");
  assert.equal(historyOutcome(record({ reports: [{ event: "gfs_failed", error: "HTTP 503" }] }), report), "failed");
});

test("a line holds the job, times, outcome, exit code, error and published run, and never a secret", () => {
  const failed = historyEntry({
    claim: claim("r_1"),
    record: record({ exitCode: 1, error: "upload failed with r2-secret-value-123 and Bearer abcdefghijklmnop", errorDetail: "Traceback\nOSError: token=hunter22" }),
    claimedAt: T0, startedAt: T0 + 5000, finishedAt: T0 + 69_000,
    redact: (text) => text.split("r2-secret-value-123").join("<redacted>"),
  });
  assert.deepEqual(
    [failed.run, failed.job, failed.attempt, failed.source, failed.outcome, failed.exitCode, failed.claimedAt, failed.startedAt, failed.finishedAt],
    ["r_1", "gfs", 1, "schedule", "failed", 1, "2026-10-18T12:00:00.000Z", "2026-10-18T12:00:05.000Z", "2026-10-18T12:01:09.000Z"]);
  assert.equal(failed.error, "upload failed with <redacted> and Bearer <redacted>");
  assert.equal(failed.errorDetail, "Traceback\nOSError: token=<redacted>");
  assert.deepEqual([failed.durationMs, failed.peakMemoryBytes, failed.avgCpuPct, failed.image, failed.digest],
    [64_000, 300 * 1048576, 41.5, "ghcr.io/example/worker:1", "sha256:abc"]);
  const text = JSON.stringify(failed);
  for (const secret of ["r2-secret-value-123", "regpass", "hunter22", "SECRET_LOG_LINE", "R2_SECRET_ACCESS_KEY", "abcdefghijklmnop"]) {
    assert.ok(!text.includes(secret), `${secret} must not be in the history`);
  }

  const published = historyEntry({
    claim: claim("r_2", "harmonie", { report: { trackEvent: "forecast_complete", trackBy: "model" } }),
    record: record({ reports: [{ event: "forecast_complete", model: "harmonie", run: "2026101806" }] }), claimedAt: T0, startedAt: T0, finishedAt: T0 + 1000,
  });
  assert.equal(published.outcome, "published");
  assert.deepEqual(published.published, [{ key: "harmonie", run: "2026101806" }]);
  assert.equal(published.error, null, "a passed run carries no error");
});

test("parsing folds run and reported lines, newest first, and skips what it cannot use", () => {
  const run = (id, finishedAt, outcome = "completed", extra = {}) => line({ v: 1, type: "run", run: id, job: "gfs", finishedAt, outcome, ...extra });
  const text = [
    line(reportedEntry("r_early", { at: T0 + 10, state: "succeeded" })), // reported before its run line (a rotation cut between them)
    run("r_early", "2026-10-18T11:00:00Z"),
    run("r_a", "2026-10-18T12:00:00Z", "failed", { error: "HTTP 503", exitCode: 1 }),
    "not json",
    "",
    line({ v: 2, type: "run", run: "r_future", finishedAt: "2026-10-18T13:00:00Z" }),
    line({ v: 1, type: "reported", run: "r_gone", at: "2026-10-18T09:00:00Z", state: "succeeded" }),
    run("r_b", "2026-10-18T12:30:00Z", "cancelled"),
    line(reportedEntry("r_a", { at: T0 + 90_000, state: "failed" })),
    run("r_c", "2026-10-18T12:15:00Z", "published"),
    line({ v: 1, type: "run", run: "r_c", job: "gfs", finishedAt: "2026-10-18T12:15:00Z", outcome: "unchanged" }), // written twice: the later wins
    "{\"v\":1,\"type\":\"run\",\"run\":\"r_torn\"", // a torn last line
  ].join("\n");
  const runs = parseHistory(text);
  assert.deepEqual(runs.map((entry) => entry.run), ["r_b", "r_c", "r_a", "r_early"]);
  assert.deepEqual(runs.map((entry) => entry.passed), [null, true, false, true]);
  assert.equal(runs[1].outcome, "unchanged");
  assert.deepEqual(runs[2].reported, { at: new Date(T0 + 90_000).toISOString(), state: "failed" });
  assert.equal(runs[3].reported.state, "succeeded", "a report read before its run still lands on it");
  assert.equal(runs[0].reported, null);
  assert.ok(!("v" in runs[0]) && !("type" in runs[0]));
  assert.deepEqual(parseHistory(""), []);
});

test("the file is 0600, rotates past maxBytes into history.jsonl.1, and recent() reads both", async (t) => {
  const state = await tempState(t);
  const history = new RunHistory(state.dir, { maxBytes: 2000 });
  const entry = (index) => ({ v: 1, type: "run", run: `r_${String(index).padStart(3, "0")}`, job: "job", outcome: "completed",
    finishedAt: new Date(T0 + index * 1000).toISOString(), note: "x".repeat(150) });
  for (let index = 0; index < 40; index += 1) await history.append(entry(index));
  const current = await stat(history.file);
  const previous = await stat(history.previous);
  assert.equal(current.mode & 0o777, 0o600);
  assert.ok(current.size <= 2000 && previous.size <= 2000, "each file stays under maxBytes");
  const runs = await history.recent(1000);
  assert.equal(runs[0].run, "r_039", "newest first");
  assert.ok(runs.length >= 12 && runs.length < 40, `older runs rotated away (${runs.length} kept)`);
  assert.deepEqual(runs.map((run) => run.run), [...runs.map((run) => run.run)].sort().reverse());
  assert.deepEqual((await history.recent(3)).map((run) => run.run), ["r_039", "r_038", "r_037"]);
  // A second rotation replaces the first .1 rather than keeping it.
  const before = await readFile(history.previous, "utf8");
  for (let index = 40; index < 60; index += 1) await history.append(entry(index));
  assert.notEqual(await readFile(history.previous, "utf8"), before);
  assert.ok(!(await readFile(history.previous, "utf8")).includes("r_000"));
});

test("appends are serialised, and a missing or empty history is no runs", async (t) => {
  const state = await tempState(t);
  const history = new RunHistory(state.dir);
  assert.deepEqual(await history.recent(), []);
  await Promise.all(Array.from({ length: 25 }, (_, index) => history.append({ v: 1, type: "run", run: `r_${index}`, outcome: "completed",
    finishedAt: new Date(T0 + index).toISOString() })));
  const lines = (await readFile(history.file, "utf8")).trim().split("\n");
  assert.equal(lines.length, 25);
  for (const text of lines) JSON.parse(text);
  await writeFile(path.join(state.dir, "history.jsonl"), "");
  assert.deepEqual(await history.recent(), []);
});

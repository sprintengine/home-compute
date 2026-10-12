import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { completeRun, HistoryStore, reportMetrics } from "../src/history.mjs";

async function directory() {
  return mkdtemp(path.join(os.tmpdir(), "home-compute-history-"));
}

test("metrics take every numeric field: the largest peak, the sum of the rest", () => {
  assert.deepEqual(reportMetrics([
    { event: "forecast_complete", model: "a", seconds: 100, peakMemoryMb: 900, cpuSeconds: 50.5, objects: 3, run: "2026101100" },
    { event: "forecast_complete", model: "b", seconds: 20, peakMemoryMb: 1400, cpuSeconds: 4.25, newField: 7 },
  ]), { seconds: 120, peakMemoryMb: 1400, cpuSeconds: 54.75, objects: 3, newField: 7 });
  assert.deepEqual(reportMetrics([]), {});
});

test("a run's durations count queueing apart from running", () => {
  const run = completeRun({
    id: "j-1", submittedAt: "2026-10-11T10:00:00Z", startedAt: "2026-10-11T10:04:30Z", finishedAt: "2026-10-11T10:10:30Z",
  });
  assert.equal(run.queueSeconds, 270);
  assert.equal(run.durationSeconds, 360);
  const unstarted = completeRun({ id: "j-2", submittedAt: "2026-10-11T10:00:00Z", finishedAt: "2026-10-11T10:01:00Z" });
  assert.equal(unstarted.durationSeconds, 60, "without a start, the run took from submission");
  assert.equal(unstarted.queueSeconds, undefined);
});

test("history keeps the newest runs per job, persisted privately, and survives a restart", async () => {
  const dir = await directory();
  const store = new HistoryStore(dir, { keep: 3 });
  for (let hour = 0; hour < 5; hour += 1) {
    await store.record("harmonie", `j-${hour}`, { submittedAt: `2026-10-11T0${hour}:00:00Z`, state: "Submitted" });
  }
  await store.record("harmonie", "j-4", { state: "Completed", outcome: "published", finishedAt: "2026-10-11T04:05:00Z" });
  const runs = await store.runs("harmonie");
  assert.deepEqual(runs.map((run) => run.id), ["j-4", "j-3", "j-2"]);
  assert.equal(runs[0].outcome, "published");
  assert.equal(runs[0].durationSeconds, 300);

  const file = path.join(dir, "harmonie.json");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(file, "utf8")).runs.length, 3);
  const reopened = new HistoryStore(dir, { keep: 3 });
  assert.deepEqual((await reopened.runs("harmonie")).map((run) => run.id), ["j-4", "j-3", "j-2"]);
  assert.deepEqual(await reopened.locate("j-3", ["icon-eu", "harmonie"]).then((found) => found.job), "harmonie");
  assert.equal(await reopened.locate("j-0", ["harmonie"]), undefined, "dropped runs are gone");
  await assert.rejects(() => reopened.runs("../escape"), /Invalid job id/);
});

test("a job without history starts from what its state says of its last run", async () => {
  const store = new HistoryStore(await directory());
  await store.seed("ecmwf", {
    lastSubmittedAt: "2026-10-11T15:20:19Z",
    lastFinishedJobId: "j-aee6",
    lastFinishedAt: "2026-10-11T15:20:49Z",
    lastFinishedState: "Completed",
    lastOutcome: "unchanged",
    lastExitCode: 0,
    lastReports: [{ event: "forecast_unchanged", model: "ecmwf", seconds: 1 }],
  });
  const [run] = await store.runs("ecmwf");
  assert.equal(run.id, "j-aee6");
  assert.equal(run.source, "state");
  assert.equal(run.durationSeconds, 30);
  assert.deepEqual(run.metrics, { seconds: 1 });
  await store.seed("ecmwf", { lastFinishedJobId: "j-other" });
  assert.equal((await store.runs("ecmwf")).length, 1, "seeding never adds to an existing history");

  await store.seed("gfs", { lastFinishedJobId: "j-old", lastFinishedAt: "2026-10-11T10:00:00Z", lastSubmittedAt: "2026-10-11T11:00:00Z" });
  assert.equal((await store.runs("gfs"))[0].submittedAt, undefined, "a newer submission's time is not this run's");
});

test("oversized reports are cut to the newest that fit", async () => {
  const store = new HistoryStore(await directory());
  const reports = Array.from({ length: 50 }, (_, index) => ({ event: "chunk", index, padding: "x".repeat(2000) }));
  const run = await store.record("blend", "j-big", { reports });
  assert.ok(run.reports.length < 50 && run.reports.length > 0);
  assert.equal(run.reports.at(-1).index, 49);
});

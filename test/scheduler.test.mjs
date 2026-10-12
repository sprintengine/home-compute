import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { reconcile } from "../src/scheduler.mjs";

function configuration() {
  return {
    jobs: [{
      id: "forecast",
      schedule: { every: "15m" },
      task: { image: "example/forecast", parameters: [] },
    }],
  };
}

function quietLogger() {
  return { log() {}, error() {} };
}

test("reconcile submits due work and forbids overlap", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "home-compute-test-"));
  const stateFile = path.join(directory, "state.json");
  let submissions = 0;
  let state = "Running";
  const client = {
    async submit() { submissions += 1; return `j-${submissions}`; },
    async describe() { return { state, terminal: state === "Completed" }; },
  };
  const start = new Date("2026-09-13T12:00:00.000Z");
  const first = await reconcile({
    config: configuration(), client, environment: {}, stateFile, now: start, logger: quietLogger(),
  });
  assert.equal(first.state.jobs.forecast.activeJobId, "j-1");
  assert.equal(submissions, 1);

  await reconcile({
    config: configuration(), client, environment: {}, stateFile,
    now: new Date("2026-09-13T12:16:00.000Z"), logger: quietLogger(),
  });
  assert.equal(submissions, 1, "an active run prevents a second submission");

  state = "Completed";
  const third = await reconcile({
    config: configuration(), client, environment: {}, stateFile,
    now: new Date("2026-09-13T12:17:00.000Z"), logger: quietLogger(),
  });
  assert.equal(submissions, 1, "the interval restarts when a long-running job finishes");
  assert.equal(third.state.jobs.forecast.lastFinishedJobId, "j-1");
  assert.equal(third.state.jobs.forecast.activeJobId, undefined);

  const fourth = await reconcile({
    config: configuration(), client, environment: {}, stateFile,
    now: new Date("2026-09-13T12:33:00.000Z"), logger: quietLogger(),
  });
  assert.equal(submissions, 2);
  assert.equal(fourth.state.jobs.forecast.activeJobId, "j-2");
});

test("reconcile leaves disabled jobs dormant", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "home-compute-test-"));
  const config = configuration();
  config.jobs[0].enabled = false;
  let submissions = 0;
  await reconcile({
    config,
    client: { async submit() { submissions += 1; } },
    environment: {},
    stateFile: path.join(directory, "state.json"),
    logger: quietLogger(),
  });
  assert.equal(submissions, 0);
});

test("reconcile leaves operator-paused jobs dormant", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "home-compute-test-"));
  const stateFile = path.join(directory, "state.json");
  await import("../src/scheduler.mjs").then(({ writeState }) => writeState(stateFile, {
    version: 1,
    jobs: { forecast: { paused: true } },
  }));
  let submissions = 0;
  await reconcile({
    config: configuration(),
    client: { async submit() { submissions += 1; } },
    environment: {},
    stateFile,
    logger: quietLogger(),
  });
  assert.equal(submissions, 0);
});

test("an at schedule is due once per UTC slot and names its next one", async () => {
  const { isDue, nextDueAt } = await import("../src/scheduler.mjs");
  const job = { id: "icon", schedule: { at: { hours: [3, 9, 15, 21], minutes: [30] } }, task: { image: "x" } };
  const now = new Date("2026-10-08T10:00:00.000Z");
  assert.equal(isDue(job, {}, now), true, "never submitted is due at once");
  assert.equal(isDue(job, { lastSubmittedAt: "2026-10-08T09:30:05.000Z" }, now), false);
  assert.equal(isDue(job, { lastSubmittedAt: "2026-10-08T03:31:00.000Z" }, now), true, "the 09:30 slot passed since");
  assert.equal(nextDueAt(job, { lastSubmittedAt: "2026-10-08T09:30:05.000Z" }, now), "2026-10-08T15:30:00.000Z");
  const late = new Date("2026-10-08T22:00:00.000Z");
  assert.equal(nextDueAt(job, { lastSubmittedAt: "2026-10-08T21:30:01.000Z" }, late), "2026-10-09T03:30:00.000Z");
  const early = new Date("2026-10-09T01:00:00.000Z");
  assert.equal(isDue(job, { lastSubmittedAt: "2026-10-08T21:30:01.000Z" }, early), false, "yesterday's last slot counts");
  assert.equal(nextDueAt(job, { activeJobId: "j-1" }, now), null, "a running job has no next time");
  const hourly = { ...job, schedule: { at: { minutes: [45] } } };
  assert.equal(nextDueAt(hourly, { lastSubmittedAt: "2026-10-08T09:45:00.000Z" }, now), "2026-10-08T10:45:00.000Z");
});

test("a finished run reads its exit code and JSON-line reports", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "home-compute-test-"));
  const stateFile = path.join(directory, "state.json");
  const config = {
    jobs: [{
      id: "harmonie",
      schedule: { every: "1h" },
      task: { image: "forecast", report: { format: "json-lines", trackEvent: "forecast_complete", trackBy: "model" } },
    }],
  };
  let status = { state: "Running", terminal: false };
  const client = {
    async submit() { return "j-1"; },
    async describe() { return status; },
  };
  await reconcile({ config, client, environment: {}, stateFile, now: new Date("2026-10-08T10:00:00Z"), logger: quietLogger() });
  status = {
    state: "Completed", terminal: true, exitCode: 0,
    stdout: 'downloading\n{"event":"forecast_complete","model":"harmonie","run":"2026100809","seconds":412,"time":"2026-10-08T10:07:00Z"}\n',
    stderr: "",
  };
  const done = await reconcile({ config, client, environment: {}, stateFile, now: new Date("2026-10-08T10:08:00Z"), logger: quietLogger() });
  const record = done.state.jobs.harmonie;
  assert.equal(record.lastOutcome, "published");
  assert.deepEqual(record.published.harmonie, { run: "2026100809", at: "2026-10-08T10:07:00Z", seconds: 412 });
  assert.equal(done.events[0].outcome, "published");

  await reconcile({ config, client, environment: {}, stateFile, now: new Date("2026-10-08T11:09:00Z"), logger: quietLogger() });
  status = {
    state: "Completed", terminal: true, exitCode: 1, stdout: "",
    stderr: '{"event":"forecast_failed","model":"harmonie","error":"HTTP 503"}\n',
  };
  const failed = await reconcile({ config, client, environment: {}, stateFile, now: new Date("2026-10-08T11:10:00Z"), logger: quietLogger() });
  const after = failed.state.jobs.harmonie;
  assert.equal(after.lastFinishedState, "Failed", "Completed with a nonzero exit is a failure");
  assert.equal(after.lastExitCode, 1);
  assert.equal(after.lastOutcome, "failed");
  assert.equal(after.lastError, "HTTP 503");
  assert.equal(after.published.harmonie.run, "2026100809", "a failure keeps the last publication");
});

test("a run whose every report is unchanged is said so", async () => {
  const { parseReports, recordFinished } = await import("../src/scheduler.mjs");
  assert.deepEqual(parseReports('{"a":1}\nnot json {\n{"event":"x"}').map((entry) => entry.event), ["x"]);
  const job = { id: "ecmwf", task: { image: "x", report: { format: "json-lines", trackEvent: "forecast_complete", trackBy: "model" } } };
  const record = { activeJobId: "j-9" };
  const event = await recordFinished({
    job, record, client: {}, now: new Date("2026-10-08T10:00:00Z"),
    status: { state: "Completed", exitCode: 0, stdout: '{"event":"forecast_unchanged","model":"ecmwf","run":"2026100800"}', stderr: "" },
  });
  assert.equal(event.outcome, "unchanged");
  assert.deepEqual(record.published, {}, "nothing new was published");
  assert.equal(record.activeJobId, undefined);
});

test("each run is kept in its job's history: queued, running, then its outcome and numbers", async () => {
  const { HistoryStore } = await import("../src/history.mjs");
  const { createRedactor } = await import("../src/redact.mjs");
  const directory = await mkdtemp(path.join(os.tmpdir(), "home-compute-test-"));
  const stateFile = path.join(directory, "state.json");
  const history = new HistoryStore(path.join(directory, "history"));
  const redact = createRedactor(["hunter2-secret"]);
  const config = {
    jobs: [{
      id: "gfs",
      schedule: { every: "1h" },
      task: { image: "x", report: { format: "json-lines", trackEvent: "forecast_complete", trackBy: "model" } },
    }],
  };
  let status = { state: "Queued", terminal: false, timing: { submittedAt: "2026-10-08T10:00:01.000Z" } };
  const client = { async submit() { return "j-7"; }, async describe() { return status; } };
  const pass = (at) => reconcile({ config, client, environment: {}, stateFile, now: new Date(at), logger: quietLogger(), history, redact });

  await pass("2026-10-08T10:00:00Z");
  assert.deepEqual(await history.runs("gfs").then(([run]) => [run.id, run.state, run.source]), ["j-7", "Submitted", "schedule"]);
  await pass("2026-10-08T10:00:30Z");
  assert.equal((await history.find("gfs", "j-7")).state, "Queued");
  assert.equal((await history.find("gfs", "j-7")).startedAt, undefined);
  status = { state: "Running", terminal: false, timing: { submittedAt: "2026-10-08T10:00:01.000Z", startedAt: "2026-10-08T10:02:00.000Z" } };
  await pass("2026-10-08T10:03:00Z");
  assert.equal((await history.find("gfs", "j-7")).queueSeconds, 120);

  status = {
    state: "Completed", terminal: true, exitCode: 0,
    timing: { startedAt: "2026-10-08T10:02:00.000Z", finishedAt: "2026-10-08T10:07:30.000Z" },
    stdout: `${JSON.stringify({ event: "forecast_complete", model: "gfs", run: "2026100806", seconds: 300, peakMemoryMb: 1830, cpuSeconds: 211.5 })}\n`,
    stderr: "",
  };
  await pass("2026-10-08T10:08:00Z");
  const run = await history.find("gfs", "j-7");
  assert.equal(run.outcome, "published");
  assert.equal(run.durationSeconds, 330);
  assert.equal(run.queueSeconds, 120);
  assert.deepEqual(run.metrics, { seconds: 300, peakMemoryMb: 1830, cpuSeconds: 211.5 });
  assert.deepEqual(run.published, [{ key: "gfs", run: "2026100806" }]);
  assert.equal(run.reports.length, 1);

  // The next run fails; its output is kept, without the secret it printed.
  client.submit = async () => "j-8";
  await pass("2026-10-08T11:08:00Z");
  status = { state: "Running", terminal: false };
  await pass("2026-10-08T11:09:00Z");
  status = {
    state: "Completed", terminal: true, exitCode: 1, stdout: "",
    stderr: "using key hunter2-secret\nTraceback (most recent call last):\nRuntimeError: HTTP 503\n",
  };
  await pass("2026-10-08T11:10:00Z");
  const failed = (await history.runs("gfs"))[0];
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.exitCode, 1);
  assert.match(failed.failureDetail, /RuntimeError: HTTP 503/);
  assert.doesNotMatch(failed.failureDetail, /hunter2/);
  assert.equal((await history.runs("gfs")).length, 2);
});

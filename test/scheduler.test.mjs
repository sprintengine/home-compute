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

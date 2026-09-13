import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApiServer } from "../src/api.mjs";
import { HomeComputeService } from "../src/service.mjs";

function fixture(stateFile) {
  const calls = { submissions: 0 };
  const config = {
    pollEvery: "30s",
    jobs: [{
      id: "forecast",
      schedule: { every: "15m" },
      task: { image: "example/forecast:1", parameters: ["--region", "west"] },
    }],
  };
  const client = {
    async submit() { calls.submissions += 1; return `j-${calls.submissions}`; },
    async describe() { return { state: "Running", terminal: false }; },
    async nodes() { return [{ Info: { NodeID: "worker-one" } }, { Info: { NodeID: "worker-two" } }]; },
  };
  return { calls, service: new HomeComputeService({ config, client, environment: {}, stateFile, logger: { log() {}, error() {} } }) };
}

test("control API authenticates, reports a snapshot, and operates jobs", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "home-compute-api-"));
  const { calls, service } = fixture(path.join(directory, "state.json"));
  const api = createApiServer({ service, port: 0, token: "test-token", logger: { error() {} } });
  const address = await api.listen();
  context.after(() => api.close());
  const root = `http://127.0.0.1:${address.port}`;

  const denied = await fetch(`${root}/v1/snapshot`);
  assert.equal(denied.status, 401);

  const headers = { authorization: "Bearer test-token" };
  const initial = await fetch(`${root}/v1/snapshot`, { headers }).then((response) => response.json());
  assert.equal(initial.controller.status, "online");
  assert.equal(initial.nodeCount, 2);
  assert.equal(initial.jobs[0].id, "forecast");

  const run = await fetch(`${root}/v1/jobs/forecast/run`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ extraParameters: ["--run", "latest"] }),
  });
  assert.equal(run.status, 202);
  assert.equal((await run.json()).bacalhauJobId, "j-1");
  assert.equal(calls.submissions, 1);

  await fetch(`${root}/v1/jobs/forecast/pause`, { method: "POST", headers });
  const paused = await fetch(`${root}/v1/snapshot?live=false`, { headers }).then((response) => response.json());
  assert.equal(paused.jobs[0].paused, true);
  assert.equal(paused.jobs[0].enabled, false);

  await fetch(`${root}/v1/jobs/forecast/resume`, { method: "POST", headers });
  const resumed = await fetch(`${root}/v1/snapshot?live=false`, { headers }).then((response) => response.json());
  assert.equal(resumed.jobs[0].paused, false);
});

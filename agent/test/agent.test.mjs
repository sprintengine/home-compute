// The agent against a stand-in control plane: the sync loop's backoff and
// jitter, revocation, the protocol check, credential rotation, the outbox,
// tails sent only when changed, drain and the local status server, and
// adopting containers after a restart.
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import test from "node:test";
import { Agent, backoffDelay, MAX_BACKOFF_MS } from "../src/agent.mjs";
import { systemClock } from "../src/clock.mjs";
import { FakeRuntime } from "../src/runtime/fake.mjs";
import { startStatusServer } from "../src/status-server.mjs";
import { claimFor, CONFIG, events, runId, stubFetch, tempState, until } from "./support.mjs";

const OK_SYNC = () => ({ serverTime: Date.now(), nextSyncInMs: 10_000, claims: [], cancel: [], upcoming: [], config: {}, update: null,
  provisioningTasks: [], rotateCredential: null });

/** A stand-in hc-core: `plan` answers in order (then OK), `claims`/`cancel`/`rotate` ride on the next sync. */
function controlPlane() {
  const plane = { syncs: [], completes: [], claims: [], cancel: [], rotate: null, syncPlan: [], completePlan: [] };
  plane.fetch = stubFetch(({ path, body, headers }) => {
    if (path === "/agent/v1/sync") {
      plane.syncs.push({ body, authorization: headers.authorization });
      const planned = plane.syncPlan.shift();
      if (typeof planned === "function") return planned();
      if (planned) return planned;
      const rotateCredential = plane.rotate ? { credential: plane.rotate } : null;
      plane.rotate = null;
      return { body: { ...OK_SYNC(), claims: plane.claims.splice(0), cancel: plane.cancel.splice(0), rotateCredential } };
    }
    const complete = path.match(/^\/agent\/v1\/runs\/([^/]+)\/complete$/);
    if (complete) {
      const planned = plane.completePlan.shift();
      if (typeof planned === "function") return planned();
      if (planned) return planned;
      plane.completes.push({ id: complete[1], body });
      return { body: { ok: true, runId: complete[1], state: body.exitCode === 0 ? "succeeded" : "failed" } };
    }
    return { status: 404, body: { error: "not_found" } };
  });
  return plane;
}

async function makeAgent(t, { plane = controlPlane(), runtime = new FakeRuntime(), clock = systemClock, config = {}, state, random } = {}) {
  const agentState = state ?? await tempState(t);
  const log = events();
  const agent = new Agent({ state: agentState, config: { ...CONFIG, ...config }, credential: "hca_first", runtime, clock, fetch: plane.fetch, log, random });
  await agent.start();
  t.after?.(() => agent.kill());
  return { agent, plane, runtime, state: agentState, log };
}

/** A clock whose sleeps return at once and are remembered: the loop's waits, without waiting. */
function recordingClock() {
  const sleeps = [];
  return { ...systemClock, sleeps, sleep: async (ms) => { sleeps.push(ms); } };
}

test("backoff: exponential with jitter, capped at 5 minutes", () => {
  assert.equal(backoffDelay(1, () => 0), 1000);
  assert.equal(backoffDelay(1, () => 1), 2000);
  assert.equal(backoffDelay(3, () => 0.5), 6000);
  for (const failures of [9, 10, 30]) {
    const delay = backoffDelay(failures, Math.random);
    assert.ok(delay >= MAX_BACKOFF_MS / 2 && delay <= MAX_BACKOFF_MS, String(delay));
  }
});

test("the loop waits as the server says, and backs off on 5xx, 429, 1027 and network errors while runs go on", async (t) => {
  const plane = controlPlane();
  const clock = recordingClock();
  let failNetwork = true;
  plane.syncPlan.push(
    { status: 503, body: { error: "unavailable" } },
    { status: 429, body: "rate limited" },
    { status: 500, body: "<html>error code: 1027</html>" },
    () => {
      if (failNetwork) {
        failNetwork = false;
        throw new TypeError("fetch failed");
      }
      return { body: OK_SYNC() };
    },
  );
  const { agent, log } = await makeAgent(t, { plane, clock: { ...clock, now: Date.now }, random: () => 0.5 });
  plane.syncPlan.push(undefined, () => {
    agent.stop();
    return { body: { ...OK_SYNC(), nextSyncInMs: 400_000 } };
  });
  await agent.run();
  assert.deepEqual(clock.sleeps, [1500, 3000, 6000, 12_000, 10_000]);
  assert.deepEqual(log.seen.filter((entry) => entry.event === "backoff").map((entry) => entry.failures), [1, 2, 3, 4]);
  assert.equal(agent.connection, "online");
});

test("426 means wait for an update: claim nothing, sync again in an hour", async (t) => {
  const plane = controlPlane();
  const clock = recordingClock();
  const { agent } = await makeAgent(t, { plane, clock });
  plane.syncPlan.push({ status: 426, body: { error: "update the agent", code: "upgrade_required" } }, () => {
    agent.stop();
    return { status: 426, body: { error: "update the agent", code: "upgrade_required" } };
  });
  await agent.run();
  assert.equal(agent.connection, "upgrade-required");
  assert.deepEqual(clock.sleeps, [3_600_000]);
  plane.syncPlan.push({ status: 426, body: { code: "upgrade_required" } });
  await assert.rejects(agent.syncOnce(), (error) => error.kind === "upgrade");
  assert.equal(plane.syncs.at(-1).body.claim, false);
});

test("revoked: claims nothing, finishes the current run, keeps its result in the outbox", async (t) => {
  const runtime = new FakeRuntime({ script: { output: ["working", { sleepMs: 150 }, "done"], exitCode: 0 } });
  const { agent, plane, log } = await makeAgent(t, { runtime });
  const id = runId();
  plane.claims.push(claimFor(id));
  await agent.syncOnce();
  assert.equal(plane.syncs[0].body.claim, true);
  plane.syncPlan.push({ status: 401, body: { error: "revoked", code: "revoked" } }, { status: 401, body: { code: "revoked" } });
  plane.completePlan.push({ status: 401, body: { code: "revoked" } });
  await assert.rejects(agent.syncOnce(), (error) => error.kind === "revoked");
  assert.equal(agent.connection, "revoked");
  await agent.idle();
  assert.equal(runtime.containers.size, 0, "the run finished");
  assert.deepEqual(await agent.outbox.ids(), [id], "its result waits");
  await assert.rejects(agent.syncOnce());
  assert.equal(plane.syncs.at(-1).body.claim, false);
  assert.equal((await agent.status()).revoked, true);
  assert.ok(log.names().includes("revoked"));
});

test("a rotated credential is stored (0600) before it is used", async (t) => {
  const { agent, plane, state } = await makeAgent(t);
  plane.rotate = "hca_second";
  await agent.syncOnce();
  assert.equal(await state.readCredential(), "hca_second");
  assert.equal((await stat(state.credentialPath)).mode & 0o777, 0o600);
  await agent.syncOnce();
  assert.deepEqual(plane.syncs.map((entry) => entry.authorization), ["Bearer hca_first", "Bearer hca_second"]);
});

test("results wait in the outbox while the control plane is unreachable, and are reported as reporting until sent", async (t) => {
  const runtime = new FakeRuntime({ script: { output: [JSON.stringify({ event: "forecast_complete", model: "ecmwf" })], exitCode: 0 } });
  const { agent, plane } = await makeAgent(t, { runtime });
  const id = runId();
  plane.claims.push(claimFor(id));
  let down = true;
  plane.completePlan.push(() => {
    throw new TypeError("fetch failed");
  });
  await agent.syncOnce();
  await agent.idle();
  assert.deepEqual(await agent.outbox.ids(), [id]);
  assert.equal(agent.connection, "offline");
  plane.syncPlan.push(() => {
    if (down) throw new TypeError("fetch failed");
    return { body: OK_SYNC() };
  });
  await assert.rejects(agent.syncOnce());
  down = false;
  await agent.syncOnce();
  assert.deepEqual(plane.syncs.at(-1).body.runs.map((run) => [run.id, run.phase]), [[id, "reporting"]]);
  await agent.idle();
  assert.deepEqual(await agent.outbox.ids(), []);
  assert.equal(plane.completes.length, 1);
  assert.deepEqual(plane.completes[0].body.reports, [{ event: "forecast_complete", model: "ecmwf" }]);
  assert.equal(agent.runs.size, 0);
});

test("a run's tail goes up only when it changed; stats and phase go every sync", async (t) => {
  const runtime = new FakeRuntime({ script: { output: ["first", { memoryBytes: 1e6, cpuPct: 10 }], hang: true } });
  const { agent, plane } = await makeAgent(t, { runtime, config: { statsIntervalSeconds: 0.01 } });
  const id = runId();
  plane.claims.push(claimFor(id));
  await agent.syncOnce();
  await until(() => agent.runs.get(id)?.phase === "running" && agent.runs.get(id).stats.samples > 0);
  await agent.syncOnce();
  await agent.syncOnce();
  const [withTail, without] = plane.syncs.slice(-2).map((entry) => entry.body.runs[0]);
  assert.equal(withTail.logTail.text, "first");
  assert.equal(without.logTail, undefined);
  assert.equal(without.phase, "running");
  assert.equal(without.stats.peakMemoryBytes, 1e6);
  plane.cancel.push(id);
  await agent.syncOnce();
  await agent.idle();
  assert.equal(plane.completes[0].body.cancelled, true);
});

test("drain from the local status server: claims stop and the machine says so; the server needs its token", async (t) => {
  const { agent, plane, state } = await makeAgent(t);
  const token = await state.statusToken();
  const server = await startStatusServer({ agent, token, port: 0 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  assert.equal((await fetch(`${base}/status`)).status, 401);
  assert.equal((await fetch(`${base}/status`, { headers: { authorization: "Bearer wrong" } })).status, 401);
  const headers = { authorization: `Bearer ${token}` };
  const status = await (await fetch(`${base}/status`, { headers })).json();
  assert.equal(status.drain, false);
  assert.equal((await fetch(`${base}/drain`, { method: "POST", headers, body: "{}" })).status, 415);
  const drained = await fetch(`${base}/drain`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: '{"drain":true}' });
  assert.equal((await drained.json()).drain, true);
  await agent.syncOnce();
  assert.deepEqual([plane.syncs.at(-1).body.claim, plane.syncs.at(-1).body.machine.drain], [false, true]);
  assert.equal((await state.readLocalState()).drain, true, "kept across restarts");
});

test("after a restart the agent adopts its containers, and fails a run whose container is gone", async (t) => {
  const runtime = new FakeRuntime({ script: { output: ["before restart"], hang: true } });
  const first = await makeAgent(t, { runtime });
  const id = runId();
  first.plane.claims.push(claimFor(id, {}, { jobId: "ecmwf" }));
  await first.agent.syncOnce();
  await until(() => first.agent.runs.get(id)?.phase === "running");
  first.agent.kill();

  const second = await makeAgent(t, { runtime, state: first.state, plane: first.plane });
  assert.equal(second.agent.runs.get(id)?.jobId, "ecmwf");
  assert.ok(second.log.names().includes("run_adopted"));
  await second.agent.syncOnce();
  assert.equal(first.plane.syncs.at(-1).body.runs[0].phase, "running");
  runtime.containerOf(id).print("after restart");
  runtime.containerOf(id).exit({ exitCode: 0, oomKilled: false });
  await second.agent.idle();
  const report = first.plane.completes.find((entry) => entry.id === id);
  assert.equal(report.body.exitCode, 0);
  assert.equal(report.body.logTail.text, "before restart\nafter restart");

  // A run recorded as started whose container vanished (a reboot): failed, exit unknown.
  const lost = runId();
  await first.state.writeRunRecord(lost, { claim: claimFor(lost), startedAt: Date.now() });
  const third = await makeAgent(t, { runtime, state: first.state, plane: first.plane });
  await third.agent.idle();
  const orphan = first.plane.completes.find((entry) => entry.id === lost);
  assert.match(orphan.body.error, /container was gone/);
  assert.equal(orphan.body.failed, true);
});

test("a sync body stays inside 128 KB however wide its runs' output, and free figures never go below zero", async (t) => {
  const bar = "█".repeat(150);
  const runtime = new FakeRuntime({ script: { output: Array.from({ length: 400 }, (_, index) => `${index} ${bar}`), hang: true } });
  const { agent, plane } = await makeAgent(t, { runtime, config: { caps: { maxRuns: 4, cpus: 1 } } });
  for (let index = 0; index < 3; index += 1) plane.claims.push(claimFor(runId()));
  await agent.syncOnce();
  await until(() => [...agent.runs.values()].every((run) => run.capture?.linesTotal === 400));
  runtime.facts = async () => {
    throw new Error("docker: Cannot connect to the Docker daemon ".repeat(100));
  };
  await agent.syncOnce();
  const sent = plane.fetch.requests.at(-1);
  const bytes = Buffer.byteLength(JSON.stringify({ protocol: 1, ...sent.body }));
  assert.ok(bytes <= 128 * 1024, `${bytes} bytes`);
  assert.ok(sent.body.runs.every((run) => run.logTail.truncated));
  assert.deepEqual(sent.body.machine.free, { cpus: 0, memoryMiB: 0, diskMiB: 0, runs: 1 });
  assert.ok(sent.body.machine.health.lastError.length <= 300);
  assert.equal(sent.body.claim, false, "the runtime did not answer");
});

test("a result is kept on a 409 (send again later), set aside on other refusals, and dropped only when the run is gone", async (t) => {
  const { agent, plane, state } = await makeAgent(t);
  const [again, refused, gone] = [runId(), runId(), runId()];
  for (const id of [again, refused, gone]) await agent.outbox.put(id, { exitCode: 0 });
  plane.completePlan.push({ status: 409, body: { error: "send it again" } });
  await agent.flushOutbox();
  assert.deepEqual(await agent.outbox.ids(), [again, refused, gone], "a 409 stops the round and keeps everything");
  plane.completePlan.push(undefined, { status: 400, body: { error: "bad" } }, { status: 404, body: { error: "Unknown run" } });
  await agent.flushOutbox();
  assert.deepEqual(await agent.outbox.ids(), []);
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(await readdir(`${state.outboxDir}/rejected`), [`${refused}.json`]);
  assert.deepEqual(plane.completes.map((entry) => entry.id), [again]);
});

test("after three failed runtime starts the machine reports its VM failed, and recovers when a probe starts it", async (t) => {
  const runtime = new FakeRuntime({ failReady: 3 });
  const { agent, plane } = await makeAgent(t, { runtime });
  for (let index = 0; index < 3; index += 1) {
    plane.claims.push(claimFor(runId()));
    await agent.syncOnce();
    await agent.idle();
  }
  await agent.syncOnce();
  assert.deepEqual([plane.syncs.at(-1).body.machine.health.vm, plane.syncs.at(-1).body.claim], ["failed", false]);
  agent.lastProbeAt = Date.now() - 5 * 60_000;
  await agent.syncOnce();
  assert.deepEqual([plane.syncs.at(-1).body.machine.health.vm, plane.syncs.at(-1).body.claim], [undefined, true]);
});

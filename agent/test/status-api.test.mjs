// The local status API (agent/src/status-server.mjs) with a real agent on
// FakeRuntime behind it: the token, 127.0.0.1 only, Host and Origin checks,
// the runs in hand, history, pause kept across a restart, drain, restart,
// and no secret in any answer or in the history file.
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import os from "node:os";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { Agent, RESTART_EXIT_CODE } from "../src/agent.mjs";
import { FakeRuntime } from "../src/runtime/fake.mjs";
import { hostAllowed, startStatusServer } from "../src/status-server.mjs";
import { claimFor, CONFIG, controlPlane, events, runId, tempState, until } from "./support.mjs";

const CREDENTIAL = `hca_m_01J00000000000000000000000_${"C".repeat(43)}`;

async function makeAgent(t, { plane = controlPlane(), runtime = new FakeRuntime(), config = {}, state } = {}) {
  const agentState = state ?? await tempState(t);
  const log = events();
  const agent = new Agent({ state: agentState, config: { ...CONFIG, ...config }, credential: CREDENTIAL, runtime, fetch: plane.fetch, log });
  await agent.start();
  t.after?.(() => agent.kill());
  return { agent, plane, runtime, state: agentState, log };
}

async function serve(t, agent, state) {
  const token = await state.statusToken();
  const server = await startStatusServer({ agent, token, port: 0 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const call = async (path, { method = "GET", body, headers = {} } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { server, token, base, call };
}

/** A raw request, for headers fetch will not let a caller set (Host). */
function raw(port, { path = "/v1/status", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, headers, setHost: false }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    request.end();
  });
}

test("every request needs the token; a browser's Origin, another Host, a GET to an action and a non-JSON POST are refused", async (t) => {
  const { agent, state } = await makeAgent(t);
  const { server, token, base, call } = await serve(t, agent, state);
  assert.equal((await fetch(`${base}/v1/status`)).status, 401);
  assert.equal((await fetch(`${base}/v1/status`, { headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await fetch(`${base}/v1/status`, { headers: { authorization: `Bearer ${token}x` } })).status, 401);
  assert.equal((await fetch(`${base}/v1/pause`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  assert.equal((await call("/v1/status")).status, 200);
  assert.equal((await call("/v1/status", { headers: { origin: "https://evil.example" } })).status, 403, "a web page cannot use it, even with the token");
  assert.equal(await raw(server.port, { headers: { host: `evil.example:${server.port}`, authorization: `Bearer ${token}` } }), 421, "DNS rebinding");
  assert.equal(await raw(server.port, { headers: { host: `localhost:${server.port}`, authorization: `Bearer ${token}` } }), 200);
  // Node itself refuses an HTTP/1.1 request without a Host (400) before the server sees it.
  assert.ok([400, 421].includes(await raw(server.port, { headers: { authorization: `Bearer ${token}` } })), "no Host at all");
  assert.equal((await call("/v1/pause")).status, 405);
  assert.equal((await fetch(`${base}/v1/pause`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" })).status, 415);
  assert.equal((await call("/v1/nothing")).status, 404);
  assert.equal((await call("/v1/history?limit=x")).status, 400);
  assert.equal((await call("/v1/drain", { method: "POST", body: { drain: "yes" } })).status, 400);
  assert.equal(agent.paused, false, "nothing refused changed anything");
  assert.ok(hostAllowed("127.0.0.1:4787", 4787) && !hostAllowed("127.0.0.1:4788", 4787) && !hostAllowed("[::1]:4787", 4787));
});

test("it listens on 127.0.0.1 only: no other address can be asked for, and other interfaces are refused", async (t) => {
  const { agent, state } = await makeAgent(t);
  const token = await state.statusToken();
  for (const host of ["0.0.0.0", "::", "192.168.1.10", "localhost"]) {
    await assert.rejects(startStatusServer({ agent, token, port: 0, host }), /127\.0\.0\.1 only/);
  }
  await assert.rejects(startStatusServer({ agent, token: "short", port: 0 }), /token of at least 32/);
  const { server } = await serve(t, agent, state);
  assert.equal(server.address, "127.0.0.1");
  const outside = Object.values(os.networkInterfaces()).flat().find((entry) => entry && !entry.internal && entry.family === "IPv4");
  if (!outside) return t.diagnostic("no non-loopback IPv4 interface here; only the binding was checked");
  const outcome = await new Promise((resolve) => {
    const socket = connect({ host: outside.address, port: server.port });
    socket.once("connect", () => { socket.destroy(); resolve("connected"); });
    socket.once("error", (error) => resolve(error.code));
    socket.setTimeout(2000, () => { socket.destroy(); resolve("timeout"); });
  });
  assert.notEqual(outcome, "connected", `${outside.address}:${server.port} must not answer`);
});

test("pause is kept across a restart and stops claims; resume takes jobs again; the old POST /drain is the same switch", async (t) => {
  const first = await makeAgent(t);
  const { call } = await serve(t, first.agent, first.state);
  const paused = await call("/v1/pause", { method: "POST", body: {} });
  assert.equal(paused.status, 200);
  assert.deepEqual([paused.body.paused, paused.body.claiming, paused.body.notClaimingBecause], [true, false, ["paused"]]);
  assert.ok(paused.body.pausedAt);
  await first.agent.syncOnce();
  assert.deepEqual([first.plane.syncs.at(-1).body.claim, first.plane.syncs.at(-1).body.machine.drain], [false, true]);
  const stored = await first.state.readLocalState();
  assert.deepEqual([stored.paused, stored.drain], [true, true], "kept in state.json, under the old key too");
  first.agent.kill();

  const second = await makeAgent(t, { state: first.state, plane: first.plane });
  assert.equal(second.agent.paused, true, "still paused after a restart");
  assert.equal(second.agent.pausedAt, first.agent.pausedAt);
  await second.agent.syncOnce();
  assert.equal(first.plane.syncs.at(-1).body.claim, false);
  const again = await serve(t, second.agent, second.state);
  const resumed = await again.call("/v1/resume", { method: "POST", body: {} });
  assert.deepEqual([resumed.body.paused, resumed.body.claiming, resumed.body.pausedAt], [false, true, null]);
  await second.agent.syncOnce();
  assert.equal(first.plane.syncs.at(-1).body.claim, true);
  assert.equal((await again.call("/drain", { method: "POST", body: { drain: true } })).body.paused, true);
  assert.equal((await second.state.readLocalState()).paused, true);
  // An agent from before the switch had its name stored only `drain`.
  await second.state.writeLocalState({ drain: true });
  second.agent.kill();
  const third = await makeAgent(t, { state: first.state, plane: first.plane });
  assert.equal(third.agent.paused, true);
});

test("the runs in hand: job, phase, elapsed time, CPU and memory; the dashboard's drain and address come from hc-core", async (t) => {
  const runtime = new FakeRuntime({ script: { output: ["working", { memoryBytes: 200 * 1048576, cpuPct: 55 }], hang: true } });
  const { agent, plane, state } = await makeAgent(t, { runtime, config: { caps: { maxRuns: 1 } } });
  const { call } = await serve(t, agent, state);
  const id = runId();
  plane.claims.push(claimFor(id, {}, { jobId: "harmonie" }));
  plane.syncPlan.push(() => ({ body: { serverTime: Date.now(), nextSyncInMs: 10_000, claims: plane.claims.splice(0), cancel: [], upcoming: [],
    config: { dashboardUrl: "https://hc-web.example.workers.dev/" }, machine: { drain: true } } }));
  await agent.syncOnce();
  await until(() => agent.runs.get(id)?.phase === "running" && agent.runs.get(id).stats.samples > 0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const { body } = await call("/v1/status");
  assert.equal(body.statusApi, 1);
  assert.deepEqual([body.connected, body.connection, body.dashboardUrl, body.serverDrain], [true, "online", "https://hc-web.example.workers.dev/", true]);
  assert.deepEqual(body.notClaimingBecause, ["drained-on-dashboard", "full"]);
  assert.equal(body.claiming, false);
  const [run] = body.current;
  assert.deepEqual([run.id, run.job, run.phase, run.cpuPct, run.memoryBytes, run.memoryLimitBytes], [id, "harmonie", "running", 55, 200 * 1048576, 256 * 1048576]);
  assert.ok(run.elapsedMs >= 30 && run.runningMs >= 0 && run.startedAt && run.claimedAt);
  assert.ok(body.agent.pid === process.pid && body.agent.uptimeSeconds >= 0 && body.agent.rssBytes > 0);
  plane.cancel.push(id);
  await agent.syncOnce();
  await agent.idle();
  assert.deepEqual((await call("/v1/status")).body.current, []);
  const local = await makeAgent(t, { config: { dashboardUrl: "https://mine.example/" } });
  await local.agent.syncOnce();
  assert.equal((await local.agent.status()).dashboardUrl, "https://mine.example/", "config.json's dashboardUrl wins");
});

test("history: a failed run's error and exit code, then the control plane's verdict, with no secret anywhere", async (t) => {
  const SECRET = "s3cr3t-delivered-value";
  const LOCAL = "local-env-secret-value";
  const REGISTRY = "registry-password-value";
  const runtime = new FakeRuntime({
    scripts: {
      upload: { output: [`using ${SECRET} and ${LOCAL}`, "Traceback (most recent call last):", `RuntimeError: upload refused for ${SECRET} (Bearer ${LOCAL})`], exitCode: 1 },
      hello: { output: ["hi"], exitCode: 0 },
    },
  });
  const state = await tempState(t);
  await writeFile(state.defaultEnvPath, `UPLOAD_KEY=${LOCAL}\n`, { mode: 0o600 });
  const { agent, plane } = await makeAgent(t, { runtime, state });
  const { call, token } = await serve(t, agent, state);
  const failed = runId();
  const passed = runId();
  plane.claims.push(claimFor(failed, {
    secretEnv: { R2_SECRET_ACCESS_KEY: SECRET }, localEnv: [{ name: "UPLOAD_KEY", from: "UPLOAD_KEY" }],
    registryAuth: { server: "ghcr.io", username: "me", password: REGISTRY },
  }, { jobId: "upload" }));
  await agent.syncOnce();
  await agent.idle();
  plane.claims.push(claimFor(passed, {}, { jobId: "hello" }));
  await agent.syncOnce();
  await agent.idle();
  await until(async () => (await call("/v1/history")).body.runs.filter((entry) => entry.reported).length === 2);
  const { body } = await call("/v1/history?limit=5");
  assert.deepEqual(body.runs.map((entry) => [entry.run, entry.job, entry.passed]), [[passed, "hello", true], [failed, "upload", false]]);
  const bad = body.runs[1];
  assert.equal(bad.exitCode, 1);
  assert.match(bad.error, /RuntimeError: upload refused for <redacted>/);
  assert.deepEqual(bad.reported.state, "failed");
  assert.equal(body.runs[0].reported.state, "succeeded");
  assert.equal((await call("/v1/history?limit=1")).body.runs.length, 1);

  // The control plane goes away with the credential in its error.
  plane.syncPlan.push(() => { throw new Error(`connect failed for ${CREDENTIAL}`); });
  await agent.syncOnce().catch(() => {});
  const status = await call("/v1/status");
  assert.equal(status.body.connected, false);
  assert.match(status.body.lastError, /<redacted>/);
  const everything = [JSON.stringify(status.body), JSON.stringify(body), await readFile(agent.history.file, "utf8")].join("\n");
  for (const secret of [SECRET, LOCAL, REGISTRY, CREDENTIAL, token, "R2_SECRET_ACCESS_KEY"]) {
    assert.ok(!everything.includes(secret), `${secret.slice(0, 12)}… leaked into the status API or history`);
  }
});

test("drain: no new claims, the run in hand finishes and is reported, then the agent restarts; it can be cancelled", async (t) => {
  const runtime = new FakeRuntime({ script: { output: ["long"], hang: true } });
  const { agent, plane, state, log } = await makeAgent(t, { runtime });
  const { call } = await serve(t, agent, state);
  const id = runId();
  plane.claims.push(claimFor(id));
  await agent.syncOnce();
  await until(() => agent.runs.get(id)?.phase === "running");
  const loop = agent.run();
  const draining = await call("/v1/drain", { method: "POST", body: { drain: true } });
  assert.deepEqual([draining.body.draining, draining.body.claiming, draining.body.paused], [true, false, false]);
  assert.equal((await call("/v1/drain", { method: "POST", body: { drain: false } })).body.draining, false, "cancelled");
  assert.equal((await call("/v1/drain", { method: "POST", body: {} })).body.draining, true, "an empty body drains");
  await agent.syncOnce();
  assert.deepEqual([plane.syncs.at(-1).body.claim, plane.syncs.at(-1).body.machine.drain], [false, true]);
  assert.equal(agent.restartRequested, null, "not while the run is in hand");
  runtime.containerOf(id).exit({ exitCode: 0, oomKilled: false });
  await until(() => agent.restartRequested);
  await loop;
  assert.equal(agent.restartRequested.reason, "drained");
  assert.ok(plane.completes.some((entry) => entry.id === id), "reported before the restart");
  assert.ok(log.names().includes("drain_started") && log.names().includes("restart_requested"));
  assert.equal((await state.readLocalState()).paused, undefined, "a drain is not kept");
  assert.equal(RESTART_EXIT_CODE, 75);
});

test("restart: answered first, then the service loop ends with a running job left to be adopted", async (t) => {
  const runtime = new FakeRuntime({ script: { output: ["long"], hang: true } });
  const { agent, plane, state } = await makeAgent(t, { runtime });
  const { call } = await serve(t, agent, state);
  const id = runId();
  plane.claims.push(claimFor(id));
  await agent.syncOnce();
  await until(() => agent.runs.get(id)?.phase === "running");
  const loop = agent.run();
  const answer = await call("/v1/restart", { method: "POST", body: {} });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.current[0].id, id);
  await loop;
  assert.match(agent.restartRequested.reason, /status server/);
  assert.equal(runtime.containerOf(id).result, null, "the container still runs");
});

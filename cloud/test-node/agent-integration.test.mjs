// M2 end to end (§11): hc-core in workerd (Miniflare) with a local D1 and
// the real migrations, driven by real agents (in this process) with
// FakeRuntime and one movable clock that both sides share: a lease expiring
// after 90 s or a 10-minute grace passes at once.
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../../agent/src/agent.mjs";
import { offsetClock } from "../../agent/src/clock.mjs";
import { enrol } from "../../agent/src/enrol.mjs";
import { FakeRuntime } from "../../agent/src/runtime/fake.mjs";
import { StateDir } from "../../agent/src/state.mjs";
import { startControlPlane } from "./support/control-plane.mjs";

const START = Date.parse("2026-11-02T08:00:00Z");
const IMAGE = "ghcr.io/example/worker@sha256:0123";
const timings = [];

async function until(check, { timeoutMs = 10_000, everyMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

/** A fresh hc-core and D1, a clock at START, and a way to make enrolled agents. */
async function setup(t) {
  const plane = await startControlPlane();
  const clock = offsetClock(START);
  const directory = await mkdtemp(path.join(os.tmpdir(), "hc-m2-"));
  const agents = [];
  t.after(async () => {
    for (const agent of agents) agent.kill();
    timings.push(...plane.timings);
    await plane.close();
    await rm(directory, { recursive: true, force: true });
  });

  /** An enrolled agent called `name`, started (adoption, outbox) but not looping: tests call syncOnce(). */
  async function agent(name, { runtime, config = {}, labels = {}, envFile = null, state = null } = {}) {
    const agentState = state ?? new StateDir(path.join(directory, name));
    if (!await agentState.readCredential()) {
      const joinToken = await plane.joinToken(name, clock.now(), labels);
      await enrol({ state: agentState, server: plane.url, joinToken, runtime: "fake", fetch: plane.fetchAt(clock) });
    }
    if (envFile !== null) await writeFile(agentState.defaultEnvPath, envFile, { mode: 0o600 });
    const stored = await agentState.loadConfig();
    const created = new Agent({
      state: agentState,
      config: { ...stored, allowImages: ["ghcr.io/example/*"], statsIntervalSeconds: 0.05, stopGraceSeconds: 0.2, statusPort: 0, ...config },
      credential: await agentState.readCredential(),
      runtime: runtime ?? new FakeRuntime({ clock }),
      clock,
      fetch: plane.fetchAt(clock),
      log: () => {},
    });
    await created.start();
    agents.push(created);
    return created;
  }

  const job = (id, extra = {}) => plane.createJob({ id, image: IMAGE, schedule: null, resources: { cpus: 1, memoryMiB: 256 }, ...extra }, clock.now());
  return { plane, clock, agent, job };
}

test("two agents racing for one run: exactly one wins, and its result is recorded", async (t) => {
  const { plane, clock, agent, job } = await setup(t);
  await job("ecmwf");
  const runId = await plane.runNow("ecmwf", clock.now());
  const racers = await Promise.all(["a", "b", "c"].map((name) => agent(name)));
  await Promise.all(racers.map((racer) => racer.syncOnce()));
  const winners = racers.filter((racer) => racer.runs.has(runId));
  assert.equal(winners.length, 1);
  await winners[0].idle();
  const row = await plane.run(runId);
  assert.equal(row.state, "succeeded");
  assert.equal(row.machine_id, winners[0].config.machineId);
  const log = await plane.db.prepare("SELECT tail, final FROM run_logs WHERE run_id = ?").bind(runId).first();
  assert.deepEqual(log, { tail: "hello from the fake runtime", final: 1 });
});

test("the preferred machine gets its run; others take it when it drains or goes offline", async (t) => {
  const { plane, clock, agent, job } = await setup(t);
  await job("blend", { placement: { preferMachines: ["mac-mini"], preferWaitSeconds: 300 } });
  const mac = await agent("mac-mini");
  const linux = await agent("linux-box");
  await mac.syncOnce();
  const first = await plane.runNow("blend", clock.now());
  await linux.syncOnce();
  assert.equal(linux.runs.size, 0, "held for the Mac");
  await mac.syncOnce();
  assert.ok(mac.runs.has(first));
  await mac.idle();

  await mac.setDrain(true);
  await mac.syncOnce();
  const second = await plane.runNow("blend", clock.now());
  await linux.syncOnce();
  assert.ok(linux.runs.has(second), "the Mac is draining");
  await linux.idle();

  await mac.setDrain(false);
  await mac.syncOnce();
  mac.kill();
  const third = await plane.runNow("blend", clock.now());
  await linux.syncOnce();
  assert.ok(!linux.runs.has(third), "the Mac synced moments ago");
  clock.advance(151_000);
  await linux.syncOnce();
  assert.ok(linux.runs.has(third), "the Mac is offline");
  await linux.idle();
  assert.deepEqual((await plane.runs("blend")).map((run) => run.state), ["succeeded", "succeeded", "succeeded"]);
});

test("capacity: a machine only claims what fits", async (t) => {
  const { plane, clock, agent, job } = await setup(t);
  await job("big", { resources: { cpus: 1, memoryMiB: 1024 } });
  const runId = await plane.runNow("big", clock.now());
  const small = await agent("small", { config: { caps: { memoryMiB: 512 } } });
  const full = await agent("full", { config: { caps: { maxRuns: 0 } } });
  await small.syncOnce();
  await full.syncOnce();
  assert.equal(small.runs.size + full.runs.size, 0);
  const large = await agent("large", { config: { caps: { memoryMiB: 4096 } } });
  await large.syncOnce();
  assert.ok(large.runs.has(runId));
});

test("an agent killed mid-run: lease expiry → lost → retry per policy; its late completion is recovered after a restart", async (t) => {
  const { plane, clock, agent, job } = await setup(t);
  await job("tides", { policy: { retry: { maxAttempts: 3, onLostRunning: true, lostGraceSeconds: 600 } } });
  const runtime = new FakeRuntime({ clock, script: { output: ["importing tides"], hang: true } });
  const first = await agent("mac-mini", { runtime });
  const runId = await plane.runNow("tides", clock.now());
  await first.syncOnce();
  await until(() => first.runs.get(runId)?.phase === "running");
  await first.syncOnce();
  assert.equal((await plane.run(runId)).state, "running");
  first.kill();

  clock.advance(91_000);
  assert.deepEqual([(await plane.cron(clock.now())).lost, (await plane.cron(clock.now())).retried], [1, 0]);
  clock.advance(600_000);
  assert.equal((await plane.cron(clock.now())).retried, 1);
  const [lost, retry] = await plane.runs("tides");
  assert.deepEqual([lost.state, retry.state, retry.attempt, retry.retry_of, retry.source], ["lost", "due", 2, runId, "retry"]);

  const other = await agent("linux-box");
  await other.syncOnce();
  assert.ok(other.runs.has(retry.id));
  await other.idle();
  assert.equal((await plane.run(retry.id)).state, "succeeded");

  // The Mac's agent restarts: it adopts the container, which then finishes; the lost run is recovered.
  const restarted = await agent("mac-mini", { runtime, state: first.state });
  assert.ok(restarted.runs.has(runId));
  await restarted.syncOnce();
  runtime.containerOf(runId).exit({ exitCode: 0, oomKilled: false });
  await restarted.idle();
  const recovered = await plane.run(runId);
  assert.deepEqual([recovered.state, recovered.recovered], ["succeeded", 1]);
  assert.deepEqual((await plane.runs("tides")).map((run) => [run.state, run.attempt]), [["succeeded", 1], ["succeeded", 2]]);
});

test("with the control plane unreachable the result waits in the outbox, and is sent when it is back", async (t) => {
  const { plane, clock, agent, job } = await setup(t);
  await job("gfs");
  const runtime = new FakeRuntime({ clock, script: { output: ["downloading", { sleepMs: 150 }, "done"], exitCode: 0 } });
  const worker = await agent("box", { runtime });
  const runId = await plane.runNow("gfs", clock.now());
  await worker.syncOnce();
  plane.offline = true;
  await worker.idle();
  assert.deepEqual(await worker.outbox.ids(), [runId]);
  assert.equal((await stat(worker.outbox.pathOf(runId))).mode & 0o777, 0o600);
  await assert.rejects(worker.syncOnce(), (error) => error.kind === "backoff");
  assert.notEqual((await plane.run(runId)).state, "succeeded");

  plane.offline = false;
  await worker.syncOnce();
  await worker.idle();
  assert.deepEqual(await worker.outbox.ids(), []);
  const row = await plane.run(runId);
  assert.deepEqual([row.state, row.recovered], ["succeeded", 0]);
});

test("revoked: the agent gets 401, claims nothing more, and finishes its run into the outbox", async (t) => {
  const { plane, clock, agent, job } = await setup(t);
  await job("slow");
  await job("next");
  const runtime = new FakeRuntime({ clock, script: { output: ["working", { sleepMs: 300 }, "done"], exitCode: 0 } });
  const worker = await agent("box", { runtime });
  const runId = await plane.runNow("slow", clock.now());
  await worker.syncOnce();
  await plane.db.prepare("UPDATE machines SET credential_hash = NULL, credential_next_hash = NULL, revoked_at = ?").bind(clock.now()).run();
  await assert.rejects(worker.syncOnce(), (error) => error.kind === "revoked" && error.status === 401);
  assert.equal((await worker.status()).connection, "revoked");
  const waiting = await plane.runNow("next", clock.now());
  await worker.idle();
  assert.equal(runtime.containers.size, 0, "the run it had finished");
  assert.deepEqual(await worker.outbox.ids(), [runId], "and its result is kept");
  await assert.rejects(worker.syncOnce());
  assert.equal((await plane.run(waiting)).state, "due", "nothing new was claimed");
});

test("a run past runSeconds is stopped, then killed, and recorded as timed out", async (t) => {
  const { plane, clock, agent, job } = await setup(t);
  await job("hang", { timeouts: { runSeconds: 1 } });
  const runtime = new FakeRuntime({ clock, script: { output: ["waiting forever"], hang: true, ignoreStop: true } });
  const worker = await agent("box", { runtime });
  const runId = await plane.runNow("hang", clock.now());
  await worker.syncOnce();
  await worker.idle();
  const row = await plane.run(runId);
  assert.deepEqual([row.state, row.outcome, row.timed_out, row.exit_code, row.error], ["timed-out", "failed", 1, 137, "timed out after 1 s"]);
  assert.ok(row.duration_ms >= 1100, String(row.duration_ms));
});

test("an OOM kill fails the run with an out-of-memory error", async (t) => {
  const { plane, clock, agent, job } = await setup(t);
  await job("oom", { resources: { cpus: 1, memoryMiB: 64 } });
  const runtime = new FakeRuntime({ clock, script: { output: ["allocating", { memoryBytes: 67_000_000, sleepMs: 120 }], oomKilled: true } });
  const worker = await agent("box", { runtime });
  const runId = await plane.runNow("oom", clock.now());
  await worker.syncOnce();
  await worker.idle();
  const row = await plane.run(runId);
  assert.deepEqual([row.state, row.outcome, row.oom_killed, row.exit_code, row.error], ["failed", "failed", 1, 137, "out of memory (limit 64 MiB)"]);
  assert.equal(row.memory_limit_bytes, 64 * 1048576);
  assert.ok(row.peak_memory_bytes >= 67_000_000);
});

test("secrets are redacted in tails and reports, in plain and encoded forms, before they leave the machine", async (t) => {
  const { plane, clock, agent, job } = await setup(t);
  const secret = "fake-s3cr3t-token/value+42";
  await job("leaky", { secretEnv: { API_TOKEN: "local:HC_API_TOKEN" }, report: { format: "json-lines" } });
  const runtime = new FakeRuntime({ clock, script: (spec) => ({
    output: [
      `token=${spec.secretEnv.API_TOKEN}`,
      `as base64 ${Buffer.from(spec.secretEnv.API_TOKEN).toString("base64")}`,
      `in a URL https://x.test/?q=${encodeURIComponent(spec.secretEnv.API_TOKEN)}`,
      { line: JSON.stringify({ event: "import_failed", error: `bad token ${spec.secretEnv.API_TOKEN}` }), sleepMs: 80 },
    ],
    exitCode: 1,
  }) });
  const worker = await agent("box", { runtime, envFile: `HC_API_TOKEN=${secret}\n` });
  const runId = await plane.runNow("leaky", clock.now());
  await worker.syncOnce();
  await until(() => worker.runs.get(runId)?.phase === "running");
  await new Promise((resolve) => setTimeout(resolve, 50));
  await worker.syncOnce();
  await worker.idle();
  assert.equal(runtime.started[0].secretEnv.API_TOKEN, secret, "the container had the value, in its environment");
  assert.ok(!runtime.started[0].args.join(" ").includes(secret));
  const row = await plane.run(runId);
  const log = await plane.db.prepare("SELECT tail FROM run_logs WHERE run_id = ?").bind(runId).first();
  const stored = JSON.stringify({ row, log });
  for (const form of [secret, Buffer.from(secret).toString("base64"), encodeURIComponent(secret)]) {
    assert.ok(!stored.includes(form), `${form} reached the control plane`);
  }
  assert.equal(row.error, "bad token <redacted>");
  assert.deepEqual(JSON.parse(row.reports_json), [{ event: "import_failed", error: "bad token <redacted>" }]);
  assert.match(log.tail, /^token=<redacted>\nas base64 <redacted>\nin a URL https:\/\/x\.test\/\?q=<redacted>/);
});

test("json-lines forecast_complete reports update published tracking in schedule_state", async (t) => {
  const { plane, clock, agent, job } = await setup(t);
  await job("ecmwf", { report: { format: "json-lines", trackEvent: "forecast_complete", trackBy: "model" } });
  const runtime = new FakeRuntime({ clock, script: { output: [
    JSON.stringify({ event: "forecast_complete", model: "ecmwf", run: "2026110200", seconds: 310, peakRssBytes: 4e8 }),
    "noise",
    JSON.stringify({ event: "forecast_complete", model: "ecmwf-wave", run: "2026110200", seconds: 40 }),
  ], exitCode: 0 } });
  const worker = await agent("box", { runtime });
  const runId = await plane.runNow("ecmwf", clock.now());
  await worker.syncOnce();
  await worker.idle();
  const row = await plane.run(runId);
  assert.deepEqual([row.state, row.outcome], ["succeeded", "published"]);
  assert.deepEqual(JSON.parse(row.metrics_json), { seconds: 350, peakRssBytes: 4e8 });
  const state = await plane.db.prepare("SELECT * FROM schedule_state WHERE job_id = 'ecmwf'").first();
  assert.deepEqual([state.last_run_id, state.last_outcome], [runId, "published"]);
  const published = JSON.parse(state.published_json);
  assert.deepEqual(Object.keys(published).sort(), ["ecmwf", "ecmwf-wave"]);
  assert.deepEqual(published.ecmwf, { run: "2026110200", at: published.ecmwf.at, seconds: 310, runId });
});

test("a slot's run is created lazily by the sync just after it, when the cron is late", async (t) => {
  const { plane, clock, agent, job } = await setup(t);
  await job("blend", { schedule: { at: { hours: [8], minutes: [20] } } });
  await plane.cron(clock.now());
  const worker = await agent("box");
  clock.advance(19 * 60_000 + 50_000);
  const idle = await worker.syncOnce();
  assert.ok(idle.nextSyncInMs > 11_900 && idle.nextSyncInMs <= 12_000, `2 s after the 08:20 slot, not ${idle.nextSyncInMs}`);
  assert.deepEqual(idle.upcoming.map((entry) => [entry.jobId, new Date(entry.dueAt).toISOString()]), [["blend", "2026-11-02T08:20:00.000Z"]]);
  clock.advance(12_000);
  await worker.syncOnce();
  const [run] = await plane.runs("blend");
  assert.deepEqual([run.slot_at, run.state === "claimed" || run.state === "running" || run.state === "succeeded"], [Date.parse("2026-11-02T08:20:00Z"), true]);
  assert.ok(worker.runs.has(run.id));
  await worker.idle();
  await plane.cron(clock.now());
  assert.equal((await plane.runs("blend")).length, 1, "the cron after it creates nothing more");
});

test("a cancel from the control plane reaches the agent on its next sync and stops the container", async (t) => {
  const { plane, clock, agent, job } = await setup(t);
  await job("hang");
  const runtime = new FakeRuntime({ clock, script: { output: ["working"], hang: true } });
  const worker = await agent("box", { runtime });
  const runId = await plane.runNow("hang", clock.now());
  await worker.syncOnce();
  await until(() => worker.runs.get(runId)?.phase === "running");
  await plane.db.prepare("UPDATE runs SET state = 'cancelled', finished_at = ?1, lease_expires_at = NULL, updated_at = ?1 WHERE id = ?2")
    .bind(clock.now(), runId).run();
  const answer = await worker.syncOnce();
  assert.deepEqual(answer.cancel, [runId]);
  await worker.idle();
  assert.equal(runtime.containers.size, 0);
  assert.equal((await plane.run(runId)).state, "cancelled");
  const log = await plane.db.prepare("SELECT tail, final FROM run_logs WHERE run_id = ?").bind(runId).first();
  assert.deepEqual(log, { tail: "working", final: 1 });
});

test("credential rotation: the agent stores the new credential, the first use promotes it, the old one stops working", async (t) => {
  const { plane, clock, agent } = await setup(t);
  const worker = await agent("box");
  const old = worker.credential;
  await plane.db.prepare("UPDATE machines SET rotate_requested_at = ?").bind(clock.now()).run();
  await worker.syncOnce();
  const fresh = await worker.state.readCredential();
  assert.notEqual(fresh, old);
  assert.equal(worker.credential, fresh);
  await worker.syncOnce();
  const machine = await plane.db.prepare("SELECT credential_next_hash, rotate_requested_at FROM machines").first();
  assert.deepEqual(machine, { credential_next_hash: null, rotate_requested_at: null });
  const stale = await fetch(`${plane.url}/agent/v1/sync`, {
    method: "POST", headers: { authorization: `Bearer ${old}`, "content-type": "application/json", "x-hc-test-now": String(clock.now()) },
    body: JSON.stringify({ protocol: 1, machine: {}, runs: [], claim: false }),
  });
  assert.equal(stale.status, 401);
});

test("the service loop follows nextSyncInMs: a run due now is claimed on the next sync and reported", async (t) => {
  const { plane, clock, agent, job } = await setup(t);
  await job("quick");
  const worker = await agent("box");
  const loop = worker.run();
  await until(() => worker.lastSyncAt !== null);
  const runId = await plane.runNow("quick", clock.now());
  assert.ok(worker.nextSyncAt - clock.now() <= 30_000 && worker.nextSyncAt - clock.now() > 25_000, "idle: 30 s");
  clock.advance(30_000);
  await until(async () => (await plane.run(runId)).state === "succeeded");
  await worker.stop();
  await loop;
});

test.after(() => {
  // Measured wall time per agent endpoint in local workerd (D1 included), for cloud/README.md.
  const byPath = new Map();
  for (const entry of timings) {
    if (!byPath.has(entry.path)) byPath.set(entry.path, []);
    byPath.get(entry.path).push(entry.ms);
  }
  const summary = Object.fromEntries([...byPath].map(([name, values]) => {
    const sorted = values.sort((a, b) => a - b);
    const pick = (q) => Number(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(2));
    return [name, { requests: sorted.length, p50: pick(0.5), p95: pick(0.95), max: Number(sorted.at(-1).toFixed(2)) }];
  }));
  console.log(JSON.stringify({ event: "agent_api_wall_ms", ...summary }));
});

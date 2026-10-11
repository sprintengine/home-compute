// The agent with a VM (§4.4), against the fake colima and docker on PATH and
// a stand-in control plane: a claim starts the VM and the run waits for it;
// the Mac is held awake (caffeinate) only while a run is active; the VM
// stops after the idle time; three failed starts gate the machine until a
// probe starts it; a failed pre-warm counts; the control plane's `config` is
// honoured unless the machine sets its own; a busy VM offers only what fits.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Agent } from "../src/agent.mjs";
import { Caffeinate, createCaffeinate } from "../src/caffeinate.mjs";
import { ColimaRuntime } from "../src/runtime/colima.mjs";
import { FakeRuntime } from "../src/runtime/fake.mjs";
import { colimaCalls, fakeColimaDir, fakeEnv, startFakeDocker } from "./fake-docker.mjs";
import { claimFor, CONFIG, controlPlane, events, OK_SYNC, runId, tempState, until } from "./support.mjs";

const PROFILE = "home-compute";
const IMAGE = "ghcr.io/sprintengine/worker@sha256:beef";

async function vmAgent(t, { knobs = {}, config = {}, caffeinate = true } = {}) {
  const dir = await fakeColimaDir(t);
  for (const [name, value] of Object.entries(knobs)) await writeFile(path.join(dir, name), `${value}\n`);
  await mkdir(path.join(dir, PROFILE), { recursive: true });
  const fake = await startFakeDocker(t, { colimaDir: dir, profile: PROFILE, socketPath: path.join(dir, PROFILE, "docker.sock") });
  fake.addImage(IMAGE);
  const state = await tempState(t);
  const log = events();
  const runtime = new ColimaRuntime({ profile: PROFILE, colimaHome: dir, env: fakeEnv(), state, log, caps: { cpus: 2, memoryMiB: 3072 }, min: { cpus: 1, memoryMiB: 1024 } });
  const awake = await fakeColimaDir(t);
  const plane = controlPlane();
  const agent = new Agent({
    state, credential: "hca_first", runtime, fetch: plane.fetch, log,
    config: { ...CONFIG, runtime: "colima", allowImages: ["ghcr.io/sprintengine/*"], caps: { cpus: 2, memoryMiB: 3072, maxRuns: 2 }, ...config },
    caffeinate: caffeinate ? new Caffeinate({ env: fakeEnv({ FAKE_CAFFEINATE_DIR: awake }) }) : null,
  });
  await agent.start();
  t.after(() => agent.kill());
  return { agent, plane, runtime, fake, dir, awake, log, state };
}

const lines = async (file) => (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean);

test("a claim starts the VM, the Mac stays awake while the run is active, and the VM stops once idle", async (t) => {
  const { agent, plane, fake, dir, awake, log } = await vmAgent(t, { knobs: { "boot-delay": 0.2 }, config: { colima: { idleStopSeconds: 0.3 } } });
  fake.scripts[IMAGE] = { lines: ["working", { text: "done", delayMs: 300 }], exitCode: 0 };
  const id = runId();
  plane.claims.push(claimFor(id, { image: IMAGE, resources: { cpus: 1, memoryMiB: 512, diskMiB: 100 } }));
  await agent.syncOnce();
  await until(() => agent.runs.get(id)?.phase === "starting-vm");
  assert.equal(agent.runs.get(id).vmWaitMs, 0, "the run waits for the VM");
  await until(() => agent.runs.get(id)?.phase === "running");
  const [holder] = await lines(path.join(awake, "started"));
  assert.match(holder, new RegExp(`^\\d+ -i -w ${process.pid}$`), "caffeinate -i -w <agent pid>");
  await agent.idle();
  assert.deepEqual(await until(async () => (await lines(path.join(awake, "stopped"))).length && lines(path.join(awake, "stopped"))), [holder.split(" ")[0]],
    "released when nothing runs");
  assert.equal((await lines(path.join(awake, "started"))).length, 1, "held once");
  const report = plane.completes.find((entry) => entry.id === id).body;
  assert.equal(report.exitCode, 0);
  assert.ok(report.durations.vmWaitMs >= 200, `vm wait ${report.durations.vmWaitMs}`);
  assert.match((await colimaCalls(dir)).find((call) => call.startsWith("start")), /--cpus 1 --memory 1.75 /, "1 GiB (0.5 rounded up) + 0.75 GiB");

  await agent.syncOnce();
  const health = plane.syncs.at(-1).body.machine.health;
  assert.ok(health.vmBootSeconds >= 0.2, JSON.stringify(health));
  assert.deepEqual(plane.syncs.at(-1).body.machine.vm.state, "running");
  assert.equal((await agent.lifecycleTick()).action, "none", "not idle long enough yet");
  await new Promise((resolve) => setTimeout(resolve, 350));
  const decision = await agent.lifecycleTick();
  assert.equal(decision.action, "stop");
  assert.equal((await colimaCalls(dir)).at(-1), `stop ${PROFILE}`);
  assert.ok(log.names().includes("vm_stop"));
});

test("three failed starts make the VM unhealthy: no claims, no pre-warm; the probe starts it again and claims resume", async (t) => {
  const { agent, plane, dir } = await vmAgent(t, { knobs: { "start-failures": 3 } });
  for (let index = 0; index < 3; index += 1) {
    plane.claims.push(claimFor(runId(), { image: IMAGE }));
    await agent.syncOnce();
    await agent.idle();
  }
  assert.equal(plane.completes.length, 3);
  assert.match(plane.completes[0].body.error, /^the container runtime is not ready: colima could not start the home-compute VM: .*error starting vm/);
  plane.syncPlan.push({ body: { ...OK_SYNC(), upcoming: [{ jobId: "blend", dueAt: Date.now() + 5_000, cpus: 1, memoryMiB: 512 }] } });
  await agent.syncOnce();
  let body = plane.syncs.at(-1).body;
  assert.deepEqual([body.machine.health.vm, body.claim], ["failed", false]);
  assert.match(body.machine.health.lastError, /error starting vm/);
  const starts = (await colimaCalls(dir)).filter((call) => call.startsWith("start")).length;
  const held = await agent.lifecycleTick();
  assert.match(held.reason, /held back/);
  assert.equal((await colimaCalls(dir)).filter((call) => call.startsWith("start")).length, starts, "no pre-warm while unhealthy");

  agent.lastProbeAt = Date.now() - 5 * 60_000;
  await agent.syncOnce();
  body = plane.syncs.at(-1).body;
  assert.deepEqual([body.machine.health.vm, body.claim], [undefined, true], "recovered once a probe started it");
  assert.equal(body.machine.vm.state, "running");
});

test("a failed pre-warm counts toward the three; the next one that starts clears them", async (t) => {
  const { agent, plane, dir } = await vmAgent(t, { knobs: { "start-failures": 1 } });
  plane.syncPlan.push({ body: { ...OK_SYNC(), upcoming: [{ jobId: "blend", dueAt: Date.now() + 20_000, cpus: 1, memoryMiB: 512 }],
    config: { idleStopSeconds: 300, keepWarmSeconds: 600 } } });
  await agent.syncOnce();
  const failed = await agent.lifecycleTick();
  assert.equal(failed.action, "start");
  assert.ok(failed.error);
  assert.equal(agent.readyFailures, 1);
  const started = await agent.lifecycleTick();
  assert.deepEqual([started.action, started.error, agent.readyFailures], ["start", undefined, 0]);
  assert.equal((await colimaCalls(dir)).filter((call) => call.startsWith("start")).length, 2);
  assert.match((await agent.lifecycleTick()).reason, /kept warm for blend/);
});

test("the control plane's idle and keep-warm times are honoured; the machine's own colima settings win", async (t) => {
  const { agent, plane } = await vmAgent(t, { caffeinate: false });
  plane.syncPlan.push({ body: { ...OK_SYNC(), config: { idleStopSeconds: 120, keepWarmSeconds: 60 } } });
  await agent.syncOnce();
  assert.deepEqual(agent.vmConfig(), { idleStopSeconds: 120, keepWarmSeconds: 60 });
  agent.config = { ...agent.config, colima: { idleStopSeconds: 30 } };
  assert.deepEqual(agent.vmConfig(), { idleStopSeconds: 30, keepWarmSeconds: 60 });
  agent.serverConfig = null;
  agent.config = { ...agent.config, colima: {} };
  assert.deepEqual(agent.vmConfig(), { idleStopSeconds: 300, keepWarmSeconds: 600 }, "§4.4's defaults");
});

test("while a VM holds a run it offers only what fits beside it (it cannot be resized until empty)", async (t) => {
  const runtime = new FakeRuntime({ script: { output: ["working"], hang: true } });
  const state = await tempState(t);
  const plane = controlPlane();
  const agent = new Agent({ state, config: { ...CONFIG, caps: { cpus: 4, memoryMiB: 6144, maxRuns: 3 } }, credential: "hca_first", runtime, fetch: plane.fetch, log: events() });
  await agent.start();
  t.after(() => agent.kill());
  const vm = { state: "running", cpus: 2, memoryMiB: 2816, overheadMiB: 768 };
  assert.deepEqual(agent.free({ diskFreeMiB: 1000, vm }), { cpus: 4, memoryMiB: 6144, diskMiB: 1000, runs: 3 }, "empty: it can grow to the cap");
  plane.claims.push(claimFor(runId(), { resources: { cpus: 1, memoryMiB: 1024 } }));
  await agent.syncOnce();
  assert.deepEqual(agent.free({ diskFreeMiB: 1000, vm }), { cpus: 2, memoryMiB: 1024, diskMiB: 1000, runs: 2 });
  assert.deepEqual(agent.free({ diskFreeMiB: 1000, vm: { ...vm, state: "stopped" } }), { cpus: 3, memoryMiB: 5120, diskMiB: 1000, runs: 2 });
  agent.kill();
});

test("caffeinate is for Macs with a real runtime, or when asked for", () => {
  assert.ok(createCaffeinate({ runtime: "colima", caffeinate: "auto" }, { platform: "darwin" }) instanceof Caffeinate);
  assert.equal(createCaffeinate({ runtime: "docker", caffeinate: "auto" }, { platform: "linux" }), null);
  assert.equal(createCaffeinate({ runtime: "fake", caffeinate: "auto" }, { platform: "darwin" }), null);
  assert.equal(createCaffeinate({ runtime: "colima", caffeinate: false }, { platform: "darwin" }), null);
  assert.ok(createCaffeinate({ runtime: "docker", caffeinate: true }, { platform: "linux" }));
  const missing = new Caffeinate({ binary: "/nonexistent/caffeinate", log: () => {} });
  missing.hold();
  missing.release();
});

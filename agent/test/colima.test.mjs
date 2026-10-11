// ColimaRuntime against a fake `colima` on PATH (test/fake-bin/colima, state
// in a directory) and the fake Docker engine answering on the profile's
// socket only while the fake VM is Running: the exact start command, boot
// measurement, resizing only while empty, pre-warm and idle stop through
// tick(), start failures, disk, adoption after a restart, and never the
// owner's profile or docker context.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { JOB_LABEL, RUN_LABEL } from "../../src/core/protocol.mjs";
import { ColimaRuntime, parseColimaList, parseDfAvailable, VmStartError } from "../src/runtime/colima.mjs";
import { colimaCalls, fakeColimaDir, fakeEnv, startFakeDocker } from "./fake-docker.mjs";
import { tempState } from "./support.mjs";

const PROFILE = "home-compute";
const IMAGE = "ghcr.io/sprintengine/worker@sha256:abcd";

async function setup(t, { caps = { cpus: 4, memoryMiB: 6144 }, min, knobs = {} } = {}) {
  const dir = await fakeColimaDir(t);
  for (const [name, value] of Object.entries(knobs)) await writeFile(path.join(dir, name), `${value}\n`);
  await mkdir(path.join(dir, PROFILE), { recursive: true });
  const fake = await startFakeDocker(t, { colimaDir: dir, profile: PROFILE, socketPath: path.join(dir, PROFILE, "docker.sock") });
  const state = await tempState(t);
  const events = [];
  const runtime = new ColimaRuntime({
    profile: PROFILE, colimaHome: dir, env: fakeEnv(), state, caps, min, log: (event, fields) => events.push({ event, ...fields }),
  });
  return { dir, fake, runtime, state, events };
}

const runSpec = (runId, memoryMiB = 1024) => ({
  runId, jobId: "job", image: IMAGE, args: [], env: {}, secretEnv: {}, resources: { cpus: 1, memoryMiB }, network: "bridge",
  labels: { [RUN_LABEL]: runId, [JOB_LABEL]: "job" },
});

test("colima's JSON list and df output are read as the agent needs them", () => {
  const list = '{"name":"default","status":"Running","cpus":2,"memory":3221225472,"disk":42949672960}\n{"name":"home-compute","status":"Stopped","cpus":2,"memory":2147483648,"disk":64424509440}\n';
  assert.deepEqual(parseColimaList(list, "home-compute"), { state: "stopped", cpus: 2, memoryMiB: 2048, diskGiB: 60 });
  assert.deepEqual(parseColimaList(list, "hc-test"), { state: "absent", cpus: null, memoryMiB: null, diskGiB: null });
  assert.equal(parseDfAvailable("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vdb1 10216724 312 9675844 1% /var/lib/docker\n"), 9449);
});

test("a claim starts the VM with the exact flags, never activating its docker context, and the boot is measured", async (t) => {
  const { dir, runtime, events } = await setup(t, { knobs: { "boot-delay": 0.3 } });
  assert.equal((await runtime.facts()).vm.state, "absent");
  const { bootMs } = await runtime.ensureReady({ cpus: 1, memoryMiB: 1024 });
  assert.ok(bootMs >= 300, String(bootMs));
  const calls = await colimaCalls(dir);
  assert.deepEqual(calls.filter((call) => call.startsWith("start")), [
    "start home-compute --runtime docker --vm-type vz --cpus 2 --memory 2 --disk 60 --activate=false --ssh-config=false --mount none",
  ]);
  assert.ok(!calls.some((call) => /\bdefault\b/.test(call)), "the owner's profile is never named");
  const facts = await runtime.facts();
  assert.deepEqual([facts.kind, facts.cpus, facts.memoryMiB], ["colima", 4, 6144], "capacity is the cap, not the VM");
  assert.deepEqual([facts.vm.state, facts.vm.cpus, facts.vm.memoryMiB, facts.vm.profile], ["running", 2, 2048, PROFILE]);
  assert.ok(facts.vm.bootSeconds >= 0.3);
  assert.match(facts.version, /^colima 0\.10\.1-fake, docker 29\.0\.0-fake$/);
  assert.deepEqual((await runtime.ensureReady({ cpus: 1, memoryMiB: 1024 })), { bootMs: 0 }, "already running and big enough");
  assert.equal((await colimaCalls(dir)).filter((call) => call.startsWith("start")).length, 1);
  assert.ok(events.some((event) => event.event === "vm_started" && event.bootSeconds >= 0.3));
  const stored = JSON.parse(await readFile(path.join(runtime.state.dir, "vm.json"), "utf8"));
  assert.ok(stored.bootSeconds >= 0.3, "kept for the next pre-warm, across restarts");
});

test("a VM too small is resized (stop, then start bigger) only while it holds no containers", async (t) => {
  const { dir, fake, runtime } = await setup(t);
  await runtime.ensureReady({ cpus: 1, memoryMiB: 1024 });
  await runtime.ensureReady({ cpus: 1, memoryMiB: 3000 });
  assert.deepEqual((await colimaCalls(dir)).filter((call) => !call.startsWith("list")).slice(-2).map((call) => call.split(" ").slice(0, 10).join(" ")), [
    "stop home-compute",
    "start home-compute --runtime docker --vm-type vz --cpus 2 --memory 3.75",
  ]);
  fake.addImage(IMAGE);
  fake.scripts[IMAGE] = { lines: ["working"], hang: true };
  await runtime.run(runSpec("r_01J0000000000000000000000C", 2048));
  const lifecycle = async () => (await colimaCalls(dir)).filter((call) => /^(start|stop)/.test(call)).length;
  const before = await lifecycle();
  await assert.rejects(runtime.ensureReady({ cpus: 1, memoryMiB: 2048 }), (error) => {
    assert.match(error.message, /has no room for this run beside the 1 running/);
    assert.equal(error.countsAsFailure, false, "not a failed start");
    return true;
  });
  assert.equal(await lifecycle(), before, "no stop or start while a container runs");
  assert.deepEqual(await runtime.ensureReady({ cpus: 1, memoryMiB: 512 }), { bootMs: 0 }, "a small run fits beside it");
});

test("tick: pre-warms bootSeconds + 10 s before the first upcoming slot, keeps warm, stops when idle (pruning first)", async (t) => {
  const { dir, runtime } = await setup(t);
  runtime.bootSeconds = 5;
  const now = Date.now();
  runtime.setContext({ upcoming: [{ jobId: "blend", dueAt: now + 60_000, cpus: 1, memoryMiB: 512 }], config: { idleStopSeconds: 300, keepWarmSeconds: 600 } });
  const waiting = await runtime.tick();
  assert.equal(waiting.action, "none");
  assert.ok(Math.abs(waiting.wakeAt - (now + 60_000 - 15_000)) < 50, "wakes 5 s boot + 10 s before the slot");
  assert.equal((await colimaCalls(dir)).filter((call) => call.startsWith("start")).length, 0);

  runtime.setContext({ upcoming: [{ jobId: "blend", dueAt: Date.now() + 14_000, cpus: 1, memoryMiB: 512 }] });
  const started = await runtime.tick();
  assert.equal(started.action, "start");
  assert.match((await colimaCalls(dir)).filter((call) => call.startsWith("start"))[0], /--cpus 2 --memory 2 /);

  const warm = await runtime.tick();
  assert.match(warm.reason, /kept warm for blend/);
  runtime.setContext({ upcoming: [], config: { idleStopSeconds: 0.05, keepWarmSeconds: 600 } });
  runtime.lastBusyAt = Date.now() - 1000;
  const stopped = await runtime.tick();
  assert.equal(stopped.action, "stop");
  assert.equal((await colimaCalls(dir)).at(-1), "stop home-compute");
  assert.equal((await runtime.status({ fresh: true })).state, "stopped");
  const always = await runtime.tick();
  assert.equal(always.action, "none");

  runtime.setContext({ upcoming: [], config: { idleStopSeconds: 0, keepWarmSeconds: 600 } });
  await runtime.ensureReady({ cpus: 1, memoryMiB: 512 });
  runtime.lastBusyAt = Date.now() - 86_400_000;
  assert.match((await runtime.tick()).reason, /always on/);
});

test("tick never stops a VM with a run in it, and a run in flight counts before its container exists", async (t) => {
  const { fake, runtime } = await setup(t);
  await runtime.ensureReady({ cpus: 1, memoryMiB: 512 });
  runtime.setContext({ upcoming: [], config: { idleStopSeconds: 0.01, keepWarmSeconds: 0 }, busy: true });
  runtime.lastBusyAt = 0;
  assert.equal((await runtime.tick()).action, "none");
  runtime.setContext({ busy: false });
  fake.addImage(IMAGE);
  fake.scripts[IMAGE] = { lines: [], hang: true };
  await runtime.run(runSpec("r_01J0000000000000000000000D"));
  runtime.lastBusyAt = 0;
  assert.equal((await runtime.tick()).action, "none", "a container runs");
  runtime.released("r_01J0000000000000000000000D");
  runtime.lastBusyAt = 0;
  assert.equal((await runtime.tick()).action, "stop");
});

test("a failed start says colima's error, stops the half-started VM, and counts as a start failure", async (t) => {
  const { dir, runtime } = await setup(t, { knobs: { "start-failures": 1 } });
  await assert.rejects(runtime.ensureReady({ cpus: 1, memoryMiB: 512 }), (error) => {
    assert.ok(error instanceof VmStartError);
    assert.equal(error.vmStartFailure, true);
    assert.match(error.message, /colima could not start the home-compute VM: .*error starting vm/);
    return true;
  });
  assert.equal((await colimaCalls(dir)).at(-1), "stop --force home-compute");
  runtime.setContext({ upcoming: [{ jobId: "x", dueAt: Date.now() + 1000 }] });
  assert.equal((await runtime.tick({ mayStart: false })).action, "none", "held back while gated");
  const started = await runtime.tick();
  assert.equal(started.action, "start");
  assert.equal(started.error, undefined);
});

test("disk: measured in the VM while it runs, estimated from the last measurement while stopped, never more than the host has", async (t) => {
  const { runtime } = await setup(t, { knobs: { "df-available-kb": 5_242_880 } });
  await runtime.ensureReady({ cpus: 1, memoryMiB: 512 });
  assert.equal((await runtime.facts()).diskFreeMiB, 5120);
  await runtime.stop();
  assert.equal((await runtime.status({ fresh: true })).state, "stopped");
  const stopped = await runtime.facts();
  assert.equal(stopped.diskFreeMiB, 5120, "60 GiB less what was used at the last measurement");
  assert.deepEqual([stopped.vm.cpus, stopped.vm.memoryMiB], [null, null]);
});

test("after a restart: a stopped VM is started only when run records expect containers in it", async (t) => {
  const { dir, fake, runtime } = await setup(t);
  await runtime.ensureReady({ cpus: 1, memoryMiB: 512 });
  fake.addImage(IMAGE);
  fake.scripts[IMAGE] = { lines: ["done"], exitCode: 0 };
  await runtime.run(runSpec("r_01J0000000000000000000000E"));
  await runtime.stop();
  const restarted = new ColimaRuntime({ profile: PROFILE, colimaHome: dir, env: fakeEnv(), caps: { cpus: 2, memoryMiB: 4096 } });
  assert.deepEqual(await restarted.adopt({ expected: 0 }), []);
  assert.equal((await restarted.status({ fresh: true })).state, "stopped");
  const [handle] = await restarted.adopt({ expected: 1 });
  assert.equal(handle.runId, "r_01J0000000000000000000000E");
  assert.deepEqual(await handle.wait(), { exitCode: 0, oomKilled: false });
});

// A run's supervision against FakeRuntime: phases and their durations,
// stats, the timeout (stop, then kill), cancels, OOM, the machine's policy,
// local secrets, and the outbox written before the container is removed.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { systemClock } from "../src/clock.mjs";
import { Outbox } from "../src/outbox.mjs";
import { FakeRuntime } from "../src/runtime/fake.mjs";
import { RunSupervisor } from "../src/supervisor.mjs";
import { claimFor, CONFIG, events, runId, tempState, until } from "./support.mjs";

async function supervise(t, { script, runtime: options = {}, spec = {}, config = {}, env = new Map() } = {}) {
  const state = await tempState(t);
  const outbox = new Outbox(state);
  const runtime = new FakeRuntime({ script, ...options });
  const phases = [];
  const log = events();
  const id = runId();
  const supervisor = new RunSupervisor({
    claim: claimFor(id, spec), runtime, state, outbox, clock: systemClock, config: { ...CONFIG, ...config }, env, log,
    events: { phase: (run) => phases.push(run.phase) },
  });
  const record = await supervisor.start();
  return { record, supervisor, runtime, outbox, state, phases, id, log };
}

test("a run goes claimed → starting-vm → pulling → running → reporting, timed by the monotonic clock", async (t) => {
  const { record, phases, runtime, outbox, state, id } = await supervise(t, {
    script: { output: [{ line: "hello", memoryBytes: 300e6, cpuPct: 50 }, { sleepMs: 1000 }, { line: "bye", cpuPct: 90 }], exitCode: 0 },
    runtime: { vm: "stopped", bootMs: 60, pullMs: 40 },
  });
  assert.deepEqual(phases, ["starting-vm", "pulling", "running", "reporting"]);
  assert.ok(record.durations.vmWaitMs >= 55 && record.durations.vmWaitMs < 1000, `vm ${record.durations.vmWaitMs}`);
  assert.ok(record.durations.pullMs >= 35 && record.durations.pullMs < 1000, `pull ${record.durations.pullMs}`);
  assert.ok(record.durations.durationMs >= 900, `duration ${record.durations.durationMs}`);
  assert.deepEqual([record.exitCode, record.oomKilled, record.timedOut, record.cancelled, record.error], [0, false, false, false, null]);
  assert.equal(record.stats.peakMemoryBytes, 300e6);
  assert.ok(record.stats.samples >= 2 && record.stats.peakCpuPct >= 50);
  assert.equal(record.image.digest, "sha256:abc");
  assert.equal(record.logTail.text, "hello\nbye");
  assert.deepEqual(await outbox.get(id), record, "in the outbox before anything else");
  assert.equal(runtime.containers.size, 0, "removed once the result was safe");
  assert.equal((await state.readRunRecords()).size, 0);
  assert.ok((await readFile(state.logPath(id))).length > 0, "a gzipped local copy");
});

test("a Docker host with the image cached goes straight to running", async (t) => {
  const { phases, record } = await supervise(t, { runtime: { images: ["ghcr.io/example/worker@sha256:abc"] } });
  assert.deepEqual(phases, ["running", "reporting"]);
  assert.deepEqual([record.durations.vmWaitMs, record.durations.pullMs], [0, 0]);
});

test("runSeconds is enforced from container start: stop, then kill after the grace", async (t) => {
  const { record, log } = await supervise(t, {
    script: { output: ["working", "ERROR: still waiting on upstream"], hang: true, ignoreStop: true },
    spec: { runSeconds: 1 },
    config: { stopGraceSeconds: 0.2 },
  });
  assert.deepEqual([record.timedOut, record.exitCode, record.cancelled], [true, 137, false]);
  assert.equal(record.error, "ERROR: still waiting on upstream", "the last error line comes before the timeout (§4.6)");
  assert.ok(record.durations.durationMs >= 1150 && record.durations.durationMs < 3000, `duration ${record.durations.durationMs}`);
  assert.ok(log.names().includes("run_timed_out"));
  const quiet = await supervise(t, { script: { output: ["working"], hang: true }, spec: { runSeconds: 1 } });
  assert.deepEqual([quiet.record.timedOut, quiet.record.exitCode, quiet.record.error], [true, 143, "timed out after 1 s"]);
});

test("an OOM kill fails the run with the memory limit in its error", async (t) => {
  const { record } = await supervise(t, { script: { output: [{ memoryBytes: 64 * 1048576 }, { sleepMs: 60 }], oomKilled: true },
    spec: { resources: { cpus: 1, memoryMiB: 64 } } });
  assert.deepEqual([record.exitCode, record.oomKilled, record.error], [137, true, "out of memory (limit 64 MiB)"]);
});

test("a cancel stops the container and settles the run as cancelled", async (t) => {
  const state = await tempState(t);
  const runtime = new FakeRuntime({ script: { output: ["working"], hang: true } });
  const supervisor = new RunSupervisor({ claim: claimFor(runId()), runtime, state, outbox: new Outbox(state), clock: systemClock, config: CONFIG });
  const done = supervisor.start();
  await until(() => supervisor.phase === "running");
  supervisor.cancel();
  const record = await done;
  assert.deepEqual([record.cancelled, record.exitCode, record.error, record.failed], [true, 143, null, false]);
});

test("the machine's policy refuses an image before anything runs", async (t) => {
  const { record, runtime } = await supervise(t, { spec: { image: "ghcr.io/evil/miner:latest" }, config: { allowImages: ["ghcr.io/example/*"] } });
  assert.equal(record.failed, true);
  assert.match(record.error, /^refused by this machine's policy: .*allowImages/);
  assert.equal(runtime.started.length, 0);
  assert.equal(record.exitCode, null);
});

test("local secrets come from the env file, reach the container's environment only, and never the disk", async (t) => {
  const secret = "fake-s3cr3t-token-value";
  const state = await tempState(t);
  const runtime = new FakeRuntime({ script: (spec) => ({ output: [`token is ${spec.secretEnv.API_TOKEN}`], hang: true }) });
  const id = runId();
  const supervisor = new RunSupervisor({
    claim: claimFor(id, { localEnv: [{ name: "API_TOKEN", from: "HC_API_TOKEN" }], args: ["--fast"] }),
    runtime, state, outbox: new Outbox(state), clock: systemClock, config: CONFIG, env: new Map([["HC_API_TOKEN", secret]]),
  });
  const done = supervisor.start();
  await until(() => supervisor.phase === "running");
  assert.deepEqual(runtime.started[0].secretEnv, { API_TOKEN: secret });
  assert.deepEqual(runtime.started[0].args, ["--fast"]);
  const onDisk = await readFile(state.runRecordPath(id), "utf8");
  assert.ok(!onDisk.includes(secret), "the run record names secrets, never their values");
  supervisor.cancel();
  const record = await done;
  assert.equal(record.logTail.text, "token is <redacted>");
  assert.ok(!JSON.stringify(await new Outbox(state).get(id)).includes(secret));
  const missing = await supervise(t, { spec: { localEnv: [{ name: "API_TOKEN", from: "NOT_SET" }] } });
  assert.match(missing.record.error, /local secret NOT_SET is not set/);
  assert.equal(missing.record.failed, true);
});

test("a runtime that will not start, or an image that will not pull, fails the run with why", async (t) => {
  const notReady = await supervise(t, { runtime: { failReady: 1 } });
  assert.match(notReady.record.error, /^the container runtime is not ready: the fake VM failed to start/);
  const noPull = await supervise(t, { runtime: { failPull: "manifest unknown" } });
  assert.equal(noPull.record.error, "pull failed: manifest unknown");
  const slowPull = await supervise(t, { runtime: { pullMs: 5_000 }, config: { pullTimeoutSeconds: 0.1 } });
  assert.match(slowPull.record.error, /^pull timed out/);
});

test("a completion record is cut to fit 256 KB, newest output kept", async (t) => {
  const wide = "界".repeat(120);
  const { record } = await supervise(t, { script: { output: Array.from({ length: 600 }, (_, index) => `${index} ${wide}`), exitCode: 0 } });
  assert.ok(Buffer.byteLength(JSON.stringify(record)) <= 256 * 1024 - 2048);
  assert.match(record.logTail.text, /599 界+$/);
  assert.equal(record.logTail.truncated, true);
});

test("the machine's policy refuses privileges, mounts, devices and the host's network, and runs nothing with an empty allowImages", async (t) => {
  const asks = [
    [{ privileged: true }, /privileged mode/], [{ volumes: ["/:/host"] }, /volumes/], [{ mounts: [{ source: "/var/run/docker.sock" }] }, /mounts/],
    [{ devices: ["/dev/kvm"] }, /devices/], [{ capAdd: ["SYS_ADMIN"] }, /added capabilities/], [{ pid: "host" }, /PID namespace/],
    [{ network: "host" }, /network host is not allowed/], [{ network: "container:db" }, /not allowed/],
  ];
  for (const [extra, reason] of asks) {
    const { record, runtime } = await supervise(t, { spec: extra });
    assert.match(record.error, reason, JSON.stringify(extra));
    assert.equal(runtime.started.length, 0);
  }
  const { record } = await supervise(t, { config: { allowImages: [] } });
  assert.match(record.error, /allowImages is empty, so it runs no image/);
  const local = await supervise(t, { spec: { image: "wingfoil-forecast:local" }, config: { allowImages: ["*"] } });
  assert.match(local.record.error, /only with allowLocalImages/);
  const allowed = await supervise(t, { spec: { image: "wingfoil-forecast:local" }, config: { allowImages: ["wingfoil-forecast:*"], allowLocalImages: true } });
  assert.equal(allowed.record.error, null);
});

test("a registry secret is used for the pull only: redacted, never in the run record or the outbox", async (t) => {
  const password = "ghp_fakeRegistryToken0000000000000000000";
  const state = await tempState(t);
  const runtime = new FakeRuntime({ script: (spec) => ({ output: [`pulled with ${password}`], hang: true }) });
  const id = runId();
  const supervisor = new RunSupervisor({
    claim: claimFor(id, { registryAuth: { server: "ghcr.io", username: "bot", password } }), runtime, state, outbox: new Outbox(state), clock: systemClock, config: CONFIG,
  });
  const done = supervisor.start();
  await until(() => supervisor.phase === "running");
  assert.deepEqual(runtime.auths, [{ server: "ghcr.io", username: "bot", password }]);
  const onDisk = await readFile(state.runRecordPath(id), "utf8");
  assert.ok(!onDisk.includes(password));
  assert.equal(JSON.parse(onDisk).claim.spec.registryServer, "ghcr.io");
  supervisor.cancel();
  const record = await done;
  assert.equal(record.logTail.text, "pulled with <redacted>");
  assert.ok(!JSON.stringify(record).includes(password));
});

test("a run needing more disk than is free fails before anything is pulled; a cached image's digest comes from the runtime", async (t) => {
  const { record, runtime } = await supervise(t, { spec: { resources: { cpus: 1, memoryMiB: 256, diskMiB: 60_000 } }, runtime: { diskFreeMiB: 4096 } });
  assert.equal(record.error, "not enough disk: the run needs 60000 MiB and 4096 MiB are free");
  assert.deepEqual([runtime.pulls.length, runtime.started.length], [0, 0]);
  const state = await tempState(t);
  const cached = new FakeRuntime({ images: ["ghcr.io/example/worker:production"] });
  cached.imageDigest = async () => "sha256:0f0f";
  const released = [];
  cached.released = (id) => released.push(id);
  const id = runId();
  const supervisor = new RunSupervisor({ claim: claimFor(id, { image: "ghcr.io/example/worker:production" }), runtime: cached, state, outbox: new Outbox(state), clock: systemClock, config: CONFIG });
  const done = await supervisor.start();
  assert.equal(done.image.digest, "sha256:0f0f", "what a tag resolved to here is what ran");
  assert.deepEqual(released, [id], "the runtime hears the run is over");
});


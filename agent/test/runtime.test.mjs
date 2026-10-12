// FakeRuntime keeps to the ContainerRuntime interface of §4.3 and follows
// its scripts: lines, delays, memory samples, exit codes, OOM, hangs, slow
// stops, VM boots and failures, pulls, and adoption.
import assert from "node:assert/strict";
import test from "node:test";
import { RUN_LABEL } from "../../src/core/protocol.mjs";
import { FakeRuntime } from "../src/runtime/fake.mjs";
import { ColimaRuntime } from "../src/runtime/colima.mjs";
import { DockerCliRuntime } from "../src/runtime/docker-cli.mjs";
import { assertRuntime, createRuntime } from "../src/runtime/runtime.mjs";

const spec = (extra = {}) => ({
  runId: "r_1", jobId: "job", image: "img", args: [], env: {}, secretEnv: {}, resources: { cpus: 1, memoryMiB: 64 },
  labels: { [RUN_LABEL]: "r_1", "dev.homecompute.job": "job" }, ...extra,
});

async function collect(handle) {
  const lines = [];
  for await (const line of handle.logs) lines.push(line);
  return lines;
}

test("it implements the runtime interface; the configuration picks fake, docker or colima", () => {
  assertRuntime(new FakeRuntime());
  assert.throws(() => assertRuntime({ run() {} }), /lacks ensureReady/);
  assert.ok(createRuntime({ runtime: "fake" }) instanceof FakeRuntime);
  assert.ok(assertRuntime(createRuntime({ runtime: "docker" })) instanceof DockerCliRuntime);
  const colima = assertRuntime(createRuntime({ runtime: "colima", caps: { cpus: 2, memoryMiB: 3072 }, colima: { profile: "hc-x", minCpus: 1 } }));
  assert.ok(colima instanceof ColimaRuntime);
  assert.deepEqual([colima.profile, colima.caps, colima.min.cpus, colima.min.memoryMiB], ["hc-x", { cpus: 2, memoryMiB: 3072 }, 1, 2048]);
  assert.throws(() => createRuntime({ runtime: "podman" }), /Unknown runtime podman/);
});

test("a script prints its lines with delays, reports memory, and exits with its code", async () => {
  const runtime = new FakeRuntime({ scripts: { job: { output: ["one", { line: "two", delayMs: 30, memoryBytes: 300e6, cpuPct: 80 }], exitCode: 3 } } });
  const handle = await runtime.run(spec());
  const started = Date.now();
  assert.deepEqual(await collect(handle), ["one", "two"]);
  assert.ok(Date.now() - started >= 25);
  assert.deepEqual(await handle.wait(), { exitCode: 3, oomKilled: false });
  assert.deepEqual(await handle.stats(), { memoryBytes: 300e6, cpuPct: 80, cpuSeconds: 0, memoryLimitBytes: 64 * 1048576 });
  assert.equal(handle.runId, "r_1");
  assert.deepEqual(runtime.started[0].image, "img");
});

test("an OOM kill exits 137 with oomKilled; a hang runs until stopped; a slow stop is killed after the grace", async () => {
  const runtime = new FakeRuntime({ scripts: {
    oom: { output: [{ memoryBytes: 64 * 1048576 }], oomKilled: true },
    hang: { output: ["working"], hang: true },
    stubborn: { output: [], hang: true, ignoreStop: true },
  } });
  assert.deepEqual(await (await runtime.run(spec({ jobId: "oom" }))).wait(), { exitCode: 137, oomKilled: true });
  const hang = await runtime.run(spec({ jobId: "hang" }));
  const outcome = await Promise.race([hang.wait(), new Promise((resolve) => setTimeout(() => resolve("still running"), 50))]);
  assert.equal(outcome, "still running");
  await hang.stop(10);
  assert.deepEqual(await hang.wait(), { exitCode: 143, oomKilled: false });
  const stubborn = await runtime.run(spec({ jobId: "stubborn" }));
  const stopping = Date.now();
  await stubborn.stop(0.1);
  assert.deepEqual(await stubborn.wait(), { exitCode: 137, oomKilled: false });
  assert.ok(Date.now() - stopping >= 90, "killed only after the grace");
});

test("a VM boots once, can fail to start, and idles; pulls give digests; containers can be adopted", async () => {
  const runtime = new FakeRuntime({ vm: "stopped", bootMs: 20, failReady: 1, pullMs: 10, images: ["cached"] });
  assert.deepEqual((await runtime.facts()).vm, { kind: "fake-vm", state: "stopped" });
  await assert.rejects(runtime.ensureReady({ cpus: 1, memoryMiB: 64 }), /failed to start/);
  assert.deepEqual(await runtime.ensureReady({ cpus: 1, memoryMiB: 64 }), { bootMs: 20 });
  assert.deepEqual(await runtime.ensureReady({ cpus: 1, memoryMiB: 64 }), { bootMs: 0 });
  assert.equal(await runtime.hasImage("cached"), true);
  assert.equal(await runtime.hasImage("ghcr.io/x@sha256:abc"), false);
  assert.equal((await runtime.pull("ghcr.io/x@sha256:abc")).digest, "sha256:abc");
  assert.match((await runtime.pull("ghcr.io/x:latest")).digest, /^sha256:[0-9a-f]{64}$/);
  const handle = await runtime.run(spec({ jobId: "x", labels: { [RUN_LABEL]: "r_9" } }));
  await handle.wait();
  const [adopted] = await runtime.adopt();
  assert.equal(adopted.runId, "r_9");
  assert.deepEqual(await collect(adopted), ["hello from the fake runtime"], "the whole log is replayed");
  await adopted.remove();
  assert.deepEqual(await runtime.adopt(), []);
  await runtime.stop();
  assert.equal((await runtime.facts()).vm.state, "stopped");
});

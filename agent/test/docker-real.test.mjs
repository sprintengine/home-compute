// The agent against a real Docker (§11 M3), with the fixture image of
// test/fixture: json-lines reports, a fake secret that must come out
// redacted, carriage-return progress, stderr, ~320 MiB held (peak ≥ 300 MB),
// an OOM kill at 64 MiB, a sleep past runSeconds, a non-zero exit, adoption
// after a restart, the digest that ran, and a pull only when the digest is
// missing. Skipped where no test Docker is reachable (test/real-docker.mjs
// says which Docker counts); CI's ubuntu-latest runs them.
import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../src/agent.mjs";
import { systemClock } from "../src/clock.mjs";
import { Outbox } from "../src/outbox.mjs";
import { DockerCliRuntime } from "../src/runtime/docker-cli.mjs";
import { RunSupervisor } from "../src/supervisor.mjs";
import { buildFixture, docker, dockerEnv, realDocker, removeContainers } from "./real-docker.mjs";
import { claimFor, CONFIG, controlPlane, events, runId, tempState, until } from "./support.mjs";

const { host, skip } = await realDocker();
const JOB = "itest";
const SECRET = "hc-fake-s3cr3t-9f2b7c";
const CONFIG_HERE = {
  ...CONFIG, runtime: "docker", allowImages: ["hc-agent-fixture:*", "docker.io/library/hello-world@*"], allowLocalImages: true,
  statsIntervalSeconds: 1, stopGraceSeconds: 2, pullTimeoutSeconds: 300,
};
let fixture = null;

async function setup(t) {
  fixture ??= await buildFixture(host);
  t.after(() => removeContainers(host, JOB));
  const state = await tempState(t);
  const runtime = new DockerCliRuntime({ host, env: dockerEnv(host), state });
  return { state, runtime };
}

async function supervise(t, spec, config = {}) {
  const { state, runtime } = await setup(t);
  const id = runId();
  const phases = [];
  const supervisor = new RunSupervisor({
    claim: claimFor(id, { image: fixture, runSeconds: 120, ...spec }, { jobId: JOB }), runtime, state, outbox: new Outbox(state),
    clock: systemClock, config: { ...CONFIG_HERE, ...config }, log: () => {}, events: { phase: (run) => phases.push(run.phase) },
  });
  const record = await supervisor.start();
  return { record, runtime, phases, supervisor, id };
}

test("output is captured redacted, reports parsed, progress resolved, the digest recorded and the container removed", { skip, timeout: 600_000 }, async (t) => {
  const { record, runtime, supervisor } = await supervise(t, { args: ["report"], secretEnv: { HC_FAKE_SECRET: SECRET } });
  assert.equal(record.exitCode, 0, JSON.stringify(record));
  assert.equal(record.error, null);
  const tail = record.logTail.text.split("\n");
  assert.ok(tail.includes("using token <redacted>"), record.logTail.text);
  assert.ok(tail.includes("download 100%"), "a line rewritten with \\r shows its last state");
  assert.ok(!tail.some((line) => line.includes("download 10%")));
  assert.ok(tail.includes("a note on stderr"));
  assert.ok(!tail.some((line) => /^\d{4}-\d{2}-\d{2}T/.test(line)), "no Docker timestamps");
  assert.ok(!JSON.stringify(record).includes(SECRET), "the secret appears nowhere in the result");
  assert.deepEqual(record.reports, [{ event: "forecast_complete", model: "fixture", run: "2026101100", frames: 3, peakRssBytes: 1234567 }]);
  assert.match(record.image.digest, /^sha256:[0-9a-f]{64}$/, "a local image's id is what ran");
  assert.equal(record.image.ref, "hc-agent-fixture:test");
  assert.equal(await runtime.engine.inspectContainer(supervisor.handle.id), null, "removed after the outbox write");
});

test("peak memory is usage − inactive_file: holding ~320 MiB shows at least 300 MB", { skip, timeout: 600_000 }, async (t) => {
  const { record } = await supervise(t, { args: ["alloc", "320", "7"], resources: { cpus: 1, memoryMiB: 512, diskMiB: 100 } });
  assert.equal(record.exitCode, 0, record.error ?? "");
  assert.ok(record.stats.peakMemoryBytes >= 300e6, `peak ${record.stats.peakMemoryBytes}`);
  assert.equal(record.stats.memoryLimitBytes, 512 * 1048576);
  assert.ok(record.stats.samples >= 3, `samples ${record.stats.samples}`);
  assert.ok(record.stats.cpuSeconds > 0 && record.stats.peakCpuPct > 0, JSON.stringify(record.stats));
  assert.equal(record.reports[0].peakRssBytes, 320 * 1048576, "the workload's own peak travels in its report");
});

test("over --memory 64m the kernel kills it: oomKilled, failed with \"out of memory\"", { skip, timeout: 600_000 }, async (t) => {
  const { record } = await supervise(t, { args: ["oom"], resources: { cpus: 1, memoryMiB: 64, diskMiB: 100 } });
  assert.equal(record.oomKilled, true, JSON.stringify(record));
  assert.equal(record.error, "out of memory (limit 64 MiB)");
});

test("past runSeconds it is stopped (SIGTERM through --init) and timed out", { skip, timeout: 600_000 }, async (t) => {
  const { record } = await supervise(t, { args: ["sleep", "600"], runSeconds: 2 });
  assert.deepEqual([record.timedOut, record.exitCode, record.error], [true, 143, "timed out after 2 s"]);
  assert.ok(record.durations.durationMs >= 2000 && record.durations.durationMs < 20_000, String(record.durations.durationMs));
});

test("a non-zero exit fails with the last error line", { skip, timeout: 600_000 }, async (t) => {
  const { record } = await supervise(t, { args: ["fail", "3"] });
  assert.deepEqual([record.exitCode, record.oomKilled, record.error], [3, false, "ERROR: failing on purpose"]);
});

test("after a restart the agent adopts its running container, replays its log redacted, and reports its exit", { skip, timeout: 600_000 }, async (t) => {
  const { state } = await setup(t);
  const plane = controlPlane();
  const id = runId();
  const make = async () => {
    const agent = new Agent({
      state, config: CONFIG_HERE, credential: "hca_first", runtime: new DockerCliRuntime({ host, env: dockerEnv(host), state }), fetch: plane.fetch, log: events(),
    });
    await agent.start();
    t.after(() => agent.kill());
    return agent;
  };
  const first = await make();
  plane.claims.push(claimFor(id, { image: fixture, args: ["slow", "6"], secretEnv: { HC_FAKE_SECRET: SECRET }, runSeconds: 120 }, { jobId: JOB }));
  await first.syncOnce();
  await until(() => first.runs.get(id)?.capture?.linesTotal >= 1, { timeoutMs: 60_000 });
  first.kill();

  const second = await make();
  assert.ok(second.runs.get(id), "adopted");
  await until(() => plane.completes.some((entry) => entry.id === id), { timeoutMs: 60_000 });
  const report = plane.completes.find((entry) => entry.id === id).body;
  assert.equal(report.exitCode, 0, JSON.stringify(report));
  assert.deepEqual(report.logTail.text.split("\n"), [0, 1, 2, 3, 4, 5].map((index) => `tick ${index} <redacted>`),
    "the whole log, replayed once, with the delivered secret read back from the container to redact it");
  await second.idle();
});

test("a pinned image is pulled only when its digest is missing, and the digest is recorded", { skip, timeout: 600_000 }, async (t) => {
  await setup(t);
  await docker(host, ["pull", "-q", "hello-world:latest"]);
  const { stdout } = await docker(host, ["image", "inspect", "--format", "{{json .RepoDigests}}", "hello-world:latest"]);
  const digest = JSON.parse(stdout).map((entry) => entry.split("@")[1]).find(Boolean);
  assert.match(digest, /^sha256:/);
  const pinned = `docker.io/library/hello-world@${digest}`;
  await docker(host, ["image", "rm", "-f", "hello-world:latest", pinned], { allowFailure: true });
  const first = await supervise(t, { image: pinned, args: [] });
  assert.ok(first.phases.includes("pulling"), first.phases.join(","));
  assert.equal(first.record.exitCode, 0, first.record.error ?? "");
  assert.equal(first.record.image.digest, digest);
  assert.ok(first.record.logTail.text.includes("Hello from Docker!"));
  const second = await supervise(t, { image: pinned, args: [] });
  assert.ok(!second.phases.includes("pulling"), "already here: no pull");
  assert.equal(second.record.image.digest, digest);
  assert.equal(await first.runtime.selfTest(), "Hello from Docker!", "doctor's check works against it too");
});

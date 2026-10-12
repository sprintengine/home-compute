// hc-core in Miniflare driven by a real agent on a real Docker (§11 M3): a
// job whose local secret the fixture image prints must be stored
// `<redacted>` server-side, with its report, peak memory, digest and
// outcome. Skipped without a test Docker (agent/test/real-docker.mjs).
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../../agent/src/agent.mjs";
import { offsetClock } from "../../agent/src/clock.mjs";
import { enrol } from "../../agent/src/enrol.mjs";
import { DockerCliRuntime } from "../../agent/src/runtime/docker-cli.mjs";
import { StateDir } from "../../agent/src/state.mjs";
import { buildFixture, dockerEnv, realDocker, removeContainers } from "../../agent/test/real-docker.mjs";
import { startControlPlane } from "./support/control-plane.mjs";

const { host, skip } = await realDocker();
const SECRET = "hc-e2e-s3cr3t-4d1e";

test("a run on real Docker: the secret it prints is <redacted> in hc-core, with its report, peak memory and digest", { skip, timeout: 600_000 }, async (t) => {
  const image = await buildFixture(host);
  const plane = await startControlPlane();
  const directory = await mkdtemp(path.join(os.tmpdir(), "hc-m3-"));
  t.after(async () => {
    await removeContainers(host, "fixture");
    await plane.close();
    await rm(directory, { recursive: true, force: true });
  });
  const clock = offsetClock(Date.now());
  const state = new StateDir(path.join(directory, "agent"));
  const joinToken = await plane.joinToken("docker-box", clock.now());
  await enrol({ state, server: plane.url, joinToken, runtime: "docker", fetch: plane.fetchAt(clock), env: dockerEnv(host),
    settings: { allowImages: ["hc-agent-fixture:*"], allowLocalImages: true, docker: { host } } });
  await writeFile(state.defaultEnvPath, `FIXTURE_SECRET=${SECRET}\n`, { mode: 0o600 });
  await plane.createJob({
    id: "fixture", image, schedule: null, args: ["report"], secretEnv: { HC_FAKE_SECRET: "local:FIXTURE_SECRET" },
    resources: { cpus: 1, memoryMiB: 256 }, report: { format: "json-lines", trackEvent: "forecast_complete", trackBy: "model" },
  }, clock.now());
  const config = { ...(await state.loadConfig()), statsIntervalSeconds: 1, statusPort: 0 };
  const agent = new Agent({
    state, config, credential: await state.readCredential(), runtime: new DockerCliRuntime({ host, env: dockerEnv(host), state }),
    clock, fetch: plane.fetchAt(clock), log: () => {},
  });
  await agent.start();
  t.after(() => agent.kill());
  const runId = await plane.runNow("fixture", clock.now());
  await agent.syncOnce();
  assert.ok(agent.runs.has(runId), "claimed");
  await agent.idle();
  await agent.syncOnce();

  const row = await plane.run(runId);
  assert.equal(row.state, "succeeded", JSON.stringify(row));
  assert.equal(row.outcome, "published");
  assert.match(row.image_digest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(row.peak_memory_bytes === null || row.peak_memory_bytes > 0);
  assert.deepEqual(JSON.parse(row.metrics_json), { frames: 3, peakRssBytes: 1234567 });
  const log = await plane.db.prepare("SELECT tail, final FROM run_logs WHERE run_id = ?").bind(runId).first();
  assert.equal(log.final, 1);
  assert.match(log.tail, /^using token <redacted>$/m);
  assert.match(log.tail, /^download 100%$/m);
  const stored = JSON.stringify(await plane.db.prepare("SELECT * FROM runs WHERE id = ?").bind(runId).first()) + log.tail;
  assert.ok(!stored.includes(SECRET), "the secret's value is nowhere in hc-core");
});

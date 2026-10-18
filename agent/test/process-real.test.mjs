// A real registry image, unpacked with no Docker daemon and run through the
// process runtime. Skips when the registry cannot be reached unless
// HC_REQUIRE_PROCESS_E2E=1, which CI can set the way it requires Docker.
import assert from "node:assert/strict";
import test from "node:test";
import { RUN_LABEL, JOB_LABEL } from "../../src/core/protocol.mjs";
import { ProcessRuntime } from "../src/runtime/process-runtime.mjs";
import { tempState } from "./support.mjs";

const IMAGE = "docker.io/library/busybox:1.36.1";
const required = process.env.HC_REQUIRE_PROCESS_E2E === "1";

test("busybox echo runs end to end through the process runtime", { timeout: 180_000 }, async (t) => {
  const state = await tempState(t);
  const runtime = new ProcessRuntime({ state, sandbox: "auto" });
  const runId = "r_01J00000000000000000000BB1";
  let pulled;
  let facts;
  try {
    await runtime.ensureReady();
    pulled = await runtime.pull(IMAGE, { timeoutMs: 120_000 });
    facts = await runtime.facts();
  } catch (error) {
    if (required) throw error;
    t.skip(`process runtime end to end did not run: ${error.message}`);
    return;
  }
  assert.match(pulled.digest, /^sha256:[a-f0-9]{64}$/);
    const handle = await runtime.run({
      runId, jobId: "echo", image: IMAGE, entrypoint: null,
      args: ["sh", "-c", "echo home-compute-$HC_FROM; cat /proc/sys/kernel/hostname"],
      env: { HC_FROM: "agent" }, secretEnv: {}, resources: { cpus: 1, memoryMiB: 128 }, network: "none",
      labels: { [RUN_LABEL]: runId, [JOB_LABEL]: "echo" },
    });
    const lines = [];
    for await (const line of handle.logs) if (line.trim()) lines.push(line.trim());
    const result = await handle.wait();
    await handle.remove();
    assert.equal(result.exitCode, 0, lines.join("\n"));
    assert.equal(lines[0], "home-compute-agent");
    if (facts.sandbox === "bwrap" || facts.sandbox === "userns") assert.equal(lines[1], "home-compute");
    else assert.ok(lines[1], "the job printed a hostname");
    // A second run uses the unpacked image and does not need the registry.
    const againId = "r_01J00000000000000000000BB2";
    const again = await runtime.run({
      runId: againId, jobId: "echo", image: IMAGE, entrypoint: null, args: ["echo", "again"],
      env: {}, secretEnv: {}, resources: { cpus: 1, memoryMiB: 64 }, network: "none",
      labels: { [RUN_LABEL]: againId, [JOB_LABEL]: "echo" },
    });
    const more = [];
    for await (const line of again.logs) if (line.trim()) more.push(line.trim());
    assert.equal((await again.wait()).exitCode, 0);
    assert.deepEqual(more, ["again"]);
    await again.remove();
});

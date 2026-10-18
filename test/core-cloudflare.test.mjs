import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ABSOLUTE_MAX_RUN_SECONDS, CLOUDFLARE_MACHINE_ID, CLOUDFLARE_RUNTIME, containerCommand, deployedInstanceTypes, estimateContainerCost,
  exitCodeFromError, imageDigest, imageRepository, imagesMatch, INSTANCE_TYPES, interpretExit, localSecretNames, normaliseGuard, parseProbe,
  probeCommand, selectInstanceType, startIsTransient, targetsCloudflare, waitCommand, watchDecision, wrappedEntrypoint,
} from "../src/core/cloudflare.mjs";
import { normaliseJob } from "../src/core/job.mjs";
import { CLOUDFLARE_INSTANCE_TYPES } from "../dashboard/lib.js";

test("the virtual machine id fits the dashboard route and the instance list matches the dashboard", () => {
  assert.match(CLOUDFLARE_MACHINE_ID, /^m_[0-9A-Za-z]{26}$/);
  assert.deepEqual(CLOUDFLARE_INSTANCE_TYPES, Object.keys(INSTANCE_TYPES));
});

test("a run goes to the smallest deployed size its memory and disk fit, whatever CPU it asks for", () => {
  // Wingfoil's jobs ask for one CPU and 512 MiB or 1 GiB: CPU-light, they run on basic.
  assert.equal(selectInstanceType({ cpus: 1, memoryMiB: 1024, diskMiB: 4096 }).name, "basic");
  assert.equal(selectInstanceType({ cpus: 1, memoryMiB: 512, diskMiB: 2048 }, ["lite", "basic"]).name, "basic");
  assert.equal(selectInstanceType({ cpus: 0.25, memoryMiB: 256, diskMiB: 2048 }, ["lite", "basic"]).name, "lite");
  assert.equal(selectInstanceType({ cpus: 1, memoryMiB: 3072, diskMiB: 4096 }, ["basic", "standard-1"]).name, "standard-1");
  const basic = selectInstanceType({ memoryMiB: 1024, diskMiB: 4096 });
  assert.equal(basic.binding, "HC_CONTAINER_BASIC");
  assert.equal(basic.memoryMiB, 1024);
  // Nothing deployed fits: fail closed, never reach for a size that is not there.
  assert.match(selectInstanceType({ memoryMiB: 2048, diskMiB: 2048 }).error, /no deployed instance type holds 2048 MiB/);
  assert.match(selectInstanceType({ memoryMiB: 1024, diskMiB: 12288 }).error, /12288 MiB disk/);
  // A named size must be deployed and must hold the job.
  assert.equal(selectInstanceType({ instanceType: "basic", memoryMiB: 512, diskMiB: 1024 }).name, "basic");
  assert.match(selectInstanceType({ instanceType: "standard-1", memoryMiB: 512, diskMiB: 1024 }).error, /not deployed/);
  assert.match(selectInstanceType({ instanceType: "lite", memoryMiB: 512, diskMiB: 1024 }, ["lite"]).error, /do not fit lite/);
  assert.match(selectInstanceType({ instanceType: "standard-9" }).error, /unknown/);
});

test("the deployed sizes are the container bindings hc-core has", () => {
  assert.deepEqual(deployedInstanceTypes({ HC_CONTAINER_BASIC: {}, OTHER: {} }), ["basic"]);
  assert.deepEqual(deployedInstanceTypes({ HC_CONTAINER_STANDARD_1: {}, HC_CONTAINER_LITE: {} }), ["lite", "standard-1"]);
  assert.deepEqual(deployedInstanceTypes({}), []);
});

test("a job targets Cloudflare only through the reserved runtime label", () => {
  assert.equal(targetsCloudflare({ placement: { requireLabels: { runtime: CLOUDFLARE_RUNTIME } } }), true);
  assert.equal(targetsCloudflare({ placement: { requireLabels: { runtime: "docker" } } }), false);
  assert.equal(targetsCloudflare({}), false);
});

test("a tag runs the deployed version of its repository; a pinned digest must be the deployed one", () => {
  const digest = "ab".repeat(32);
  const deployed = `registry.cloudflare.com/acct/wingfoil-forecast@sha256:${digest}`;
  assert.equal(imageRepository(deployed), "wingfoil-forecast");
  assert.equal(imageRepository("ghcr.io/sprintengine/wingfoil-forecast:production"), "wingfoil-forecast");
  assert.equal(imageRepository("localhost:5000/team/job"), "job");
  assert.equal(imagesMatch("ghcr.io/sprintengine/wingfoil-forecast:production", deployed), true);
  assert.equal(imagesMatch("ghcr.io/sprintengine/wingfoil-forecast", deployed), true);
  assert.equal(imagesMatch(`ghcr.io/sprintengine/wingfoil-forecast@sha256:${digest.toUpperCase()}`, deployed), true);
  assert.equal(imagesMatch(`ghcr.io/sprintengine/wingfoil-forecast@sha256:${"cd".repeat(32)}`, deployed), false);
  assert.equal(imagesMatch("ghcr.io/sprintengine/other:production", deployed), false);
  assert.equal(imagesMatch(deployed, ""), false);
  assert.equal(imageDigest(deployed), `sha256:${digest}`);
  assert.deepEqual(containerCommand({ entrypoint: ["python"], args: ["-m", "job"] }, ["--once"]), ["python", "-m", "job", "--once"]);
  assert.equal(containerCommand({ entrypoint: null, args: [] }), null);
  assert.deepEqual(localSecretNames({ secretEnv: { A: "local:A", B: "vault:b" } }), ["A"]);
});

test("a clean exit is never out of memory, even with the cgroup peak at the limit", () => {
  assert.deepEqual(normaliseGuard({}), { maxConcurrent: 1, maxRunSeconds: 1200 });
  assert.equal(ABSOLUTE_MAX_RUN_SECONDS, 1200);
  assert.throws(() => normaliseGuard({ maxConcurrent: 0 }), /maxConcurrent/);
  assert.throws(() => normaliseGuard({ maxRunSeconds: 1201 }), /maxRunSeconds/);
  assert.equal(interpretExit({ exitCode: 0 }).failed, false);
  // Page cache counts towards memory.peak: a job that downloads files reaches the limit and exits 0.
  assert.equal(interpretExit({ exitCode: 0, peakMemoryBytes: 1024, memoryLimitBytes: 1024 }).oomKilled, false);
  assert.equal(interpretExit({ exitCode: 1, peakMemoryBytes: 1024, memoryLimitBytes: 1024 }).oomKilled, true);
  assert.equal(interpretExit({ exitCode: 1, peakMemoryBytes: 512, memoryLimitBytes: 1024 }).oomKilled, false);
  assert.equal(interpretExit({ exitCode: 137 }).oomKilled, true);
  assert.equal(interpretExit({ exitCode: 137, stopReason: "timeout" }).oomKilled, false);
  assert.equal(interpretExit({ exitCode: null, stopReason: "timeout" }).timedOut, true);
  assert.equal(interpretExit({}).failed, true);
  assert.equal(exitCodeFromError(new Error("Container exited, exit code: 0")), 0);
  assert.equal(exitCodeFromError(new Error("no instance")), null);
  assert.equal(startIsTransient(new Error("there is no container instance that can be provided to this durable object")), true);
  assert.equal(startIsTransient(new Error("you are requesting too many containers per second")), true);
  assert.equal(startIsTransient(new Error("image not found")), false);
});

test("the watch decision: renew while running, settle on exit or deadline, stop what ended elsewhere", () => {
  const now = 1_000_000;
  assert.equal(watchDecision({ state: "running", deadlineAt: now + 1 }, now).action, "renew");
  assert.deepEqual(watchDecision({ state: "running", deadlineAt: now + 1, exitCode: 0 }, now), { action: "settle", settle: true, stopReason: null });
  assert.equal(watchDecision({ state: "running", deadlineAt: now + 1, exitCode: 2 }, now).action, "settle");
  assert.equal(watchDecision({ state: "running", deadlineAt: now }, now).stopReason, "timeout");
  // An exit that lands at the deadline is the job's own result, not a timeout.
  assert.equal(watchDecision({ state: "running", deadlineAt: now, exitCode: 0 }, now).stopReason, null);
  assert.deepEqual(watchDecision({ state: "lost", deadlineAt: now + 1 }, now), { action: "stop", stopReason: "lost", settle: false });
  assert.equal(watchDecision({ state: "cancelled", deadlineAt: now + 1, exitCode: 0 }, now).stopReason, "cancel");
  assert.equal(watchDecision({ state: "timed-out", deadlineAt: now + 1 }, now).settle, false);
});

test("the wrapper and probe, run in a real shell, give back the exit code, the output and the reports", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "hc-wrapper-")), "hc");
  const job = ["sh", "-c", "echo start; echo '{\"event\": \"forecast_complete\", \"model\": \"harmonie\"}'; echo 'boom' >&2; exit 3"];
  const [command, ...args] = wrappedEntrypoint(job, 1, dir);
  const wrapper = spawnSync(command, args, { encoding: "utf8" });
  // Output still reaches the container's own stdout (Workers Logs), and the hold ends after a second.
  assert.match(wrapper.stdout, /start\n.*forecast_complete.*\nboom/s);
  const [waitBinary, ...waitArgs] = waitCommand(dir);
  assert.equal(spawnSync(waitBinary, waitArgs, { timeout: 5000 }).status, 0);
  const [probeBinary, ...probeArgs] = probeCommand("n0nce", dir);
  const probe = parseProbe(execFileSync(probeBinary, probeArgs, { encoding: "utf8" }), "n0nce");
  assert.equal(probe.exitCode, 3);
  assert.equal(probe.linesTotal, 3);
  assert.ok(probe.bytesTotal > 20);
  assert.deepEqual(probe.reportLines, ['{"event": "forecast_complete", "model": "harmonie"}']);
  assert.deepEqual(probe.tailLines, ["start", '{"event": "forecast_complete", "model": "harmonie"}', "boom"]);
});

test("a probe of a job still going has no exit code, and the job's output cannot forge a section", () => {
  const text = ["@@abc exit", "@@abc memory", "52428800", "@@abc cpu", "usage_usec 2500000", "@@abc size", "  12", " 2",
    "@@abc reports", "@@abc tail", "@@xyz exit", "0", ""].join("\n");
  const probe = parseProbe(text, "abc");
  assert.equal(probe.exitCode, null);
  assert.equal(probe.peakMemoryBytes, 52428800);
  assert.equal(probe.cpuMicroseconds, 2500000);
  assert.equal(probe.bytesTotal, 12);
  assert.equal(probe.linesTotal, 2);
  assert.deepEqual(probe.tailLines, ["@@xyz exit", "0"]);
});

test("a 20 minute basic run's list-price upper bound", () => {
  const cost = estimateContainerCost({ basic: 1200 });
  assert.equal(cost.containerSeconds, 1200);
  assert.ok(Math.abs(cost.estimatedUsd - 0.009336) < 1e-9, cost.estimatedUsd);
  assert.equal(cost.beforeIncludedAllotment, true);
  assert.equal(estimateContainerCost({ basic: 0 }).estimatedUsd, 0);
});

test("instanceType is stored only when a job sets it", () => {
  const plain = normaliseJob({ id: "plain", image: "ghcr.io/org/job:1" });
  assert.deepEqual(plain.resources, { cpus: 1, memoryMiB: 2048, diskMiB: 2048 });
  assert.equal("instanceType" in plain.resources, false);
  const typed = normaliseJob({ ...plain, resources: { ...plain.resources, instanceType: "basic" } });
  assert.equal(typed.resources.instanceType, "basic");
  assert.deepEqual(normaliseJob(typed), typed);
  assert.throws(() => normaliseJob({ ...plain, resources: { instanceType: "huge" } }), /instanceType/);
});

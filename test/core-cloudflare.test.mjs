import assert from "node:assert/strict";
import test from "node:test";
import {
  ABSOLUTE_MAX_RUN_SECONDS, CLOUDFLARE_MACHINE_ID, CLOUDFLARE_RUNTIME, containerCommand, containerWatch, estimateContainerCost,
  exitCodeFromError, imageDigest, imagesMatch, INSTANCE_TYPES, interpretExit, localSecretNames, normaliseGuard, parseCgroup,
  selectInstanceType, targetsCloudflare,
} from "../src/core/cloudflare.mjs";
import { normaliseJob } from "../src/core/job.mjs";
import { CLOUDFLARE_INSTANCE_TYPES } from "../dashboard/lib.js";

test("the virtual machine id fits the dashboard route and the instance list matches the dashboard", () => {
  assert.match(CLOUDFLARE_MACHINE_ID, /^m_[0-9A-Za-z]{26}$/);
  assert.deepEqual(CLOUDFLARE_INSTANCE_TYPES, Object.keys(INSTANCE_TYPES));
});

test("instance type defaults to basic and refuses a job that does not fit", () => {
  const basic = selectInstanceType({ instanceType: "basic", cpus: 0.25, memoryMiB: 1024, diskMiB: 4096 });
  assert.equal(basic.ok, true);
  assert.equal(basic.name, "basic");
  assert.equal(basic.binding, "HC_CONTAINER_BASIC");
  assert.equal(basic.memoryMiB, 1024);
  assert.equal(selectInstanceType({ cpus: 0.25, memoryMiB: 1024, diskMiB: 4096 }).name, "basic");
  assert.match(selectInstanceType({ cpus: 1, memoryMiB: 2048, diskMiB: 2048 }).error, /exceeds the basic instance/);
  assert.match(selectInstanceType({ instanceType: "lite", cpus: 1 / 16, memoryMiB: 256, diskMiB: 2048 }).name ?? "", /^lite$/);
  assert.match(selectInstanceType({ instanceType: "lite", cpus: 0.25, memoryMiB: 256, diskMiB: 2048 }).error, /lite/);
  assert.match(selectInstanceType({ instanceType: "standard-9", cpus: 0.25, memoryMiB: 256, diskMiB: 256 }).error, /unknown/);
  assert.match(selectInstanceType({ instanceType: "basic", cpus: 0.25, memoryMiB: 2048, diskMiB: 4096 }).error, /memoryMiB/);
  assert.match(selectInstanceType({ instanceType: "basic", cpus: 0.25, memoryMiB: 1024, diskMiB: 8192 }).error, /diskMiB/);
});

test("a job targets Cloudflare only through the reserved runtime label", () => {
  assert.equal(targetsCloudflare({ placement: { requireLabels: { runtime: CLOUDFLARE_RUNTIME } } }), true);
  assert.equal(targetsCloudflare({ placement: { requireLabels: { runtime: "docker" } } }), false);
  assert.equal(targetsCloudflare({}), false);
});

test("image identity is the digest, and the command is one entrypoint", () => {
  const digest = "ab".repeat(32);
  const deployed = `registry.cloudflare.com/acct/job@sha256:${digest}`;
  assert.equal(imagesMatch(deployed, deployed), true);
  assert.equal(imagesMatch(`ghcr.io/org/job@sha256:${digest.toUpperCase()}`, deployed), true);
  assert.equal(imagesMatch(`ghcr.io/org/job@sha256:${"cd".repeat(32)}`, deployed), false);
  assert.equal(imagesMatch("ghcr.io/org/job:latest", deployed), false);
  assert.equal(imagesMatch(deployed, ""), false);
  assert.equal(imageDigest(deployed), `sha256:${digest}`);
  assert.deepEqual(containerCommand({ entrypoint: ["python"], args: ["-m", "job"] }, ["--once"]), ["python", "-m", "job", "--once"]);
  assert.equal(containerCommand({ entrypoint: null, args: [] }), null);
  assert.deepEqual(localSecretNames({ secretEnv: { A: "local:A", B: "vault:b" } }), ["A"]);
});

test("guards, exits and the watch decision", () => {
  assert.deepEqual(normaliseGuard({}), { maxConcurrent: 1, maxRunSeconds: 1200 });
  assert.equal(ABSOLUTE_MAX_RUN_SECONDS, 1200);
  assert.throws(() => normaliseGuard({ maxConcurrent: 0 }), /maxConcurrent/);
  assert.throws(() => normaliseGuard({ maxRunSeconds: 1201 }), /maxRunSeconds/);
  assert.equal(interpretExit({ exitCode: 0 }).failed, false);
  assert.equal(interpretExit({ exitCode: 137 }).oomKilled, true);
  assert.equal(interpretExit({ exitCode: 137, stopReason: "timeout" }).oomKilled, false);
  assert.equal(interpretExit({ exitCode: 137, stopReason: "timeout" }).timedOut, true);
  assert.equal(interpretExit({ exitCode: 0, peakMemoryBytes: 1024, memoryLimitBytes: 1024 }).oomKilled, true);
  assert.equal(interpretExit({}).failed, true);
  assert.equal(exitCodeFromError(new Error("Container exited, exit code: 0")), 0);
  assert.equal(exitCodeFromError(new Error("no instance")), null);
  const now = 1_000_000;
  assert.equal(containerWatch({ state: "running", deadlineAt: now + 1 }, now).action, "renew");
  assert.equal(containerWatch({ state: "running", deadlineAt: now }, now).stopReason, "timeout");
  assert.deepEqual(containerWatch({ state: "lost", deadlineAt: now + 1 }, now), { action: "destroy", stopReason: "lost", complete: false });
  assert.equal(containerWatch({ state: "cancelled", deadlineAt: now + 1 }, now).stopReason, "cancel");
  assert.equal(containerWatch({ state: "succeeded", deadlineAt: now + 1 }, now).complete, false);
});

test("cgroup text and a 20 minute basic run's list-price upper bound", () => {
  assert.deepEqual(parseCgroup("memory.peak 1048576\nusage_usec 2500000\n"), { peakMemoryBytes: 1048576, cpuMicroseconds: 2500000 });
  assert.deepEqual(parseCgroup(""), {});
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

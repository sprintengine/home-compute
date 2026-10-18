// The Cloudflare Containers executor: claiming, guardrails, secrets, and the
// same run rows a machine produces. The container class is not started here;
// a fake starter stands in for the Durable Object.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLOUDFLARE_MACHINE_ID } from "../../src/core/cloudflare.mjs";
import { dispatchCloudflare, getContainers, recordContainerStop } from "../src/containers.mjs";
import { call, createJob, cron, enrolMachine, mockCertificates, resetDatabase, rows, syncAs } from "./helpers.mjs";

const DIGEST = "ab".repeat(32);
const IMAGE = `registry.cloudflare.com/acct/job@sha256:${DIGEST}`;
const GHCR = `ghcr.io/example/job@sha256:${DIGEST}`;
const NOW = Date.parse("2026-10-18T12:00:00Z");

let certificates;
beforeEach(async () => {
  await resetDatabase();
  certificates = mockCertificates();
});
afterEach(() => certificates.mockRestore());

function cloudJob(overrides = {}) {
  return {
    image: IMAGE,
    schedule: null,
    placement: { requireLabels: { runtime: "cloudflare-container" } },
    resources: { instanceType: "basic", cpus: 0.25, memoryMiB: 1024, diskMiB: 4096 },
    timeouts: { runSeconds: 600 },
    ...overrides,
  };
}

async function due(id, overrides = {}) {
  await createJob(id, cloudJob(overrides), { now: NOW });
  const response = await call(`/v1/jobs/${id}/run`, { method: "POST", body: {}, now: NOW });
  expect(response.status).toBe(202);
  return response.body.runId;
}

function starter() {
  const started = [];
  return { started, starter: { async start(spec) { started.push(spec); } } };
}

async function stateOf(runId) {
  const [row] = await rows("SELECT state, error, exit_code, oom_killed, timed_out, machine_id, metrics_json, started_at, memory_limit_bytes FROM runs WHERE id = ?", runId);
  return { ...row, metrics: row.metrics_json ? JSON.parse(row.metrics_json) : null };
}

describe("Cloudflare Containers executor", () => {
  it("does nothing, and creates no machine, until a job targets it", async () => {
    await createJob("local", {}, { now: NOW });
    expect(await dispatchCloudflare(env, NOW)).toEqual({ jobs: 0 });
    expect(await rows("SELECT id FROM machines")).toEqual([]);
  });

  it("starts a fitting job on the virtual machine and keeps vault secrets out of D1", async () => {
    const secret = await call("/v1/secrets/r2-key", { method: "PUT", body: { value: "s3-secret-value" }, now: NOW });
    expect(secret.status).toBe(201);
    const runId = await due("trial", {
      image: GHCR,
      env: { JOB: "trial" },
      secretEnv: { AWS_SECRET_ACCESS_KEY: "vault:r2-key" },
      args: ["--once"],
    });
    const fake = starter();
    const summary = await dispatchCloudflare(env, NOW, { ...fake, image: IMAGE });
    expect(summary.started).toBe(1);
    expect(fake.started).toHaveLength(1);
    expect(fake.started[0]).toMatchObject({
      runId, instanceType: "basic", enableInternet: true, entrypoint: ["--once"],
      env: { JOB: "trial", AWS_SECRET_ACCESS_KEY: "s3-secret-value" },
    });
    expect(fake.started[0].deadlineAt).toBe(NOW + 600_000 + 300_000);
    const run = await stateOf(runId);
    expect(run.state).toBe("running");
    expect(run.machine_id).toBe(CLOUDFLARE_MACHINE_ID);
    expect(run.memory_limit_bytes).toBe(1024 * 1048576);
    expect(run.metrics).toMatchObject({ instanceType: "basic", vcpu: 0.25, memoryMiB: 1024, diskMiB: 4096 });
    expect(JSON.stringify(await rows("SELECT metrics_json, error, parameters_json FROM runs"))).not.toContain("s3-secret-value");
    const [machine] = await rows("SELECT name, labels_json, credential_hash FROM machines");
    expect(machine.name).toBe("cloudflare");
    expect(JSON.parse(machine.labels_json).runtime).toBe("cloudflare-container");
    expect(machine.credential_hash).toMatch(/^[0-9a-f]{64}$/);
    const settled = await recordContainerStop(env.DB, runId, { exitCode: 0, peakMemoryBytes: 1000 }, NOW + 10_000);
    expect(settled.state).toBe("succeeded");
    const done = await stateOf(runId);
    expect(done.exit_code).toBe(0);
    expect(done.metrics.containerSeconds).toBe(10);
    expect(done.metrics.instanceType).toBe("basic");
  });

  it("leaves a second job due when the concurrency guard is full", async () => {
    const first = await due("one");
    const second = await due("two");
    const fake = starter();
    await dispatchCloudflare(env, NOW, { ...fake, image: IMAGE });
    expect(fake.started.map((spec) => spec.runId)).toEqual([first]);
    expect((await stateOf(second)).state).toBe("due");
  });

  it("fails closed when resources, duration or a local secret do not fit", async () => {
    const oversized = await due("big", { resources: { cpus: 1, memoryMiB: 2048, diskMiB: 2048 } });
    const tooLong = await due("long", { timeouts: { runSeconds: 1300 } });
    const local = await due("local-secret", { secretEnv: { TOKEN: "local:TOKEN" } });
    const fake = starter();
    await dispatchCloudflare(env, NOW, { ...fake, image: IMAGE });
    expect(fake.started).toEqual([]);
    expect((await stateOf(oversized)).error).toMatch(/exceeds the basic instance/);
    expect((await stateOf(tooLong)).error).toMatch(/1200/);
    expect((await stateOf(local)).error).toMatch(/local:/);
  });

  it("fails a mismatched image and an undeployed instance type without starting", async () => {
    const mismatch = await due("mismatch");
    const fake = starter();
    await dispatchCloudflare(env, NOW, { ...fake, image: `registry.cloudflare.com/acct/other@sha256:${"cd".repeat(32)}` });
    expect(fake.started).toEqual([]);
    expect((await stateOf(mismatch)).error).toMatch(/does not match/);
    const undeployed = await due("std", { resources: { instanceType: "standard-1", cpus: 0.5, memoryMiB: 4096, diskMiB: 8192 } });
    const summary = await dispatchCloudflare(env, NOW, { image: IMAGE });
    expect(summary.failed).toBeGreaterThanOrEqual(1);
    expect((await stateOf(undeployed)).error).toMatch(/not deployed/);
  });

  it("leaves a run due when its vault secret is missing or not for this executor", async () => {
    const missing = await due("needs", { secretEnv: { TOKEN: "vault:r2-key" } });
    const fake = starter();
    await dispatchCloudflare(env, NOW, { ...fake, image: IMAGE });
    expect(fake.started).toEqual([]);
    expect((await stateOf(missing)).state).toBe("due");
    await call("/v1/secrets/r2-key", { method: "PUT", body: { value: "s3-secret-value", allowedLabels: { site: "home" } }, now: NOW });
    await dispatchCloudflare(env, NOW, { ...fake, image: IMAGE });
    expect((await stateOf(missing)).state).toBe("due");
    const snapshot = await call("/v1/snapshot");
    expect(snapshot.body.jobs.find((job) => job.id === "needs").waiting).toMatch(/allowed labels|not set|cloudflare/);
  });

  it("does not give the run to an agent, and refuses the reserved label on enrolment", async () => {
    const runId = await due("trial");
    const machine = await enrolMachine("box", { now: NOW });
    const sync = await syncAs(machine, NOW);
    expect(sync.body.claims ?? []).toEqual([]);
    expect((await stateOf(runId)).state).toBe("due");
    const token = await call("/v1/join-tokens", { method: "POST", body: { name: "sneak", labels: { runtime: "cloudflare-container" } }, now: NOW });
    expect(token.status).toBe(400);
    expect(token.body.error).toMatch(/reserved/);
  });

  it("skips a paused schedule, still runs a manual one, and stops when the executor is drained or revoked", async () => {
    const runId = await due("trial");
    await env.DB.prepare("UPDATE runs SET source = 'schedule' WHERE id = ?").bind(runId).run();
    await call("/v1/jobs/trial/pause", { method: "POST", now: NOW });
    const fake = starter();
    await dispatchCloudflare(env, NOW, { ...fake, image: IMAGE });
    expect(fake.started).toEqual([]);
    expect((await stateOf(runId)).state).toBe("due");
    const manual = await due("hand");
    await call("/v1/jobs/hand/pause", { method: "POST", now: NOW });
    await dispatchCloudflare(env, NOW, { ...fake, image: IMAGE });
    expect(fake.started.map((spec) => spec.runId)).toEqual([manual]);
    await env.DB.prepare("UPDATE machines SET drain = 1 WHERE id = ?").bind(CLOUDFLARE_MACHINE_ID).run();
    const third = await due("later");
    const drained = await dispatchCloudflare(env, NOW, { ...fake, image: IMAGE });
    expect(drained.drained).toBe(true);
    expect((await stateOf(third)).state).toBe("due");
    await env.DB.prepare("UPDATE machines SET drain = 0, revoked_at = ? WHERE id = ?").bind(NOW, CLOUDFLARE_MACHINE_ID).run();
    const revoked = await dispatchCloudflare(env, NOW + 1000, { ...fake, image: IMAGE });
    expect(revoked.revoked).toBe(true);
    expect((await stateOf(third)).state).toBe("due");
    const [row] = await rows("SELECT revoked_at FROM machines WHERE id = ?", CLOUDFLARE_MACHINE_ID);
    expect(row.revoked_at).toBe(NOW);
  });

  it("times out and loses container runs with the same rules as a machine, and reports container-seconds", async () => {
    const runId = await due("trial");
    const fake = starter();
    await dispatchCloudflare(env, NOW, { ...fake, image: IMAGE });
    await env.DB.prepare("UPDATE runs SET started_at = ? WHERE id = ?").bind(NOW - 1_000_000, runId).run();
    const summary = await cron(NOW);
    expect(summary.timedOut).toBe(1);
    const timed = await stateOf(runId);
    expect(timed.state).toBe("timed-out");
    expect(timed.metrics.containerSeconds).toBeGreaterThan(0);
    const usage = await getContainers({ db: env.DB, now: NOW });
    expect(usage.status).toBe(200);
    const body = await usage.json();
    expect(body.containerSeconds).toBe(timed.metrics.containerSeconds);
    expect(body.beforeIncludedAllotment).toBe(true);
    expect(body.byInstanceType.basic).toBe(body.containerSeconds);
    const again = await due("retry-me");
    await dispatchCloudflare(env, NOW, { ...fake, image: IMAGE });
    await env.DB.prepare("UPDATE runs SET lease_expires_at = ? WHERE id = ?").bind(NOW - 1, again).run();
    await cron(NOW + 60_000);
    expect((await stateOf(again)).state).toBe("lost");
    expect(await rows("SELECT id FROM runs WHERE job_id = 'retry-me' AND state = 'due'")).toEqual([]);
    const ignored = await recordContainerStop(env.DB, again, { exitCode: 137, stopReason: "lost" }, NOW + 60_000);
    expect(ignored.ignored).toBe(true);
    expect((await stateOf(again)).state).toBe("lost");
  });

  it("accepts an instance type on the job and the concurrency guard in settings", async () => {
    await due("trial");
    const cleared = await call("/v1/jobs/trial/resources", { method: "PATCH", body: { instanceType: null }, now: NOW });
    expect(cleared.status).toBe(200);
    expect(cleared.body.resources.instanceType).toBeUndefined();
    const set = await call("/v1/jobs/trial/resources", { method: "PATCH", body: { instanceType: "basic", cpus: 0.25, memoryMiB: 1024, diskMiB: 4096 }, now: NOW });
    expect(set.body.resources.instanceType).toBe("basic");
    expect((await call("/v1/settings", { method: "PATCH", body: { cloudflare: { maxConcurrent: 0 } }, now: NOW })).status).toBe(400);
    expect((await call("/v1/settings", { method: "PATCH", body: { cloudflare: { maxRunSeconds: 600 } }, now: NOW })).body.cloudflare).toEqual({ maxConcurrent: 1, maxRunSeconds: 600 });
    await dispatchCloudflare(env, NOW, { ...starter(), image: IMAGE });
    const refused = await call(`/v1/machines/${CLOUDFLARE_MACHINE_ID}`, { method: "PATCH", body: { name: "renamed" }, now: NOW });
    expect(refused.status).toBe(400);
    const drained = await call(`/v1/machines/${CLOUDFLARE_MACHINE_ID}`, { method: "PATCH", body: { drain: true }, now: NOW });
    expect(drained.status).toBe(200);
    expect(drained.body.drain).toBe(true);
  });
});

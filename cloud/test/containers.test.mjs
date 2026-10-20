// The Cloudflare Containers executor: claiming, sizing, image matching,
// guardrails, secrets, and the same run rows, logs and reports a machine
// produces. The container class is not started here; a fake starter stands
// in for the Durable Object, and a probe (what the object reads from the
// container) is built by hand.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLOUDFLARE_MACHINE_ID } from "../../src/core/cloudflare.mjs";
import { dispatchCloudflare, getContainers, recordContainerStop, runningTail } from "../src/containers.mjs";
import { call, createJob, cron, enrolMachine, mockCertificates, resetDatabase, rows, syncAs } from "./helpers.mjs";

const DIGEST = "ab".repeat(32);
const IMAGE = `registry.cloudflare.com/acct/wingfoil-forecast@sha256:${DIGEST}`;
const TAGGED = "ghcr.io/sprintengine/wingfoil-forecast:production";
const NOW = Date.parse("2026-10-18T12:00:00Z");

let certificates;
beforeEach(async () => {
  await resetDatabase();
  certificates = mockCertificates();
});
afterEach(() => certificates.mockRestore());

function cloudJob(overrides = {}) {
  return {
    image: TAGGED,
    entrypoint: ["python", "/app/force5/ingest/worker.py"],
    schedule: null,
    placement: { requireLabels: { runtime: "cloudflare-container" } },
    resources: { cpus: 1, memoryMiB: 1024, diskMiB: 4096 },
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

function starter(answer = async () => ({ digest: `sha256:${DIGEST}` })) {
  const started = [];
  return { started, starter: { async start(spec) { started.push(spec); return answer(spec); } } };
}

function probe({ exitCode = null, lines = [], peakMemoryBytes = null } = {}) {
  return {
    exitCode,
    peakMemoryBytes,
    cpuMicroseconds: 2_000_000,
    bytesTotal: lines.join("\n").length,
    linesTotal: lines.length,
    reportLines: lines.filter((line) => line.trim().startsWith("{")),
    tailLines: lines,
  };
}

async function stateOf(runId) {
  const [row] = await rows(`SELECT state, outcome, error, exit_code, oom_killed, timed_out, machine_id, metrics_json, started_at,
    memory_limit_bytes, image_ref, image_digest, reports_json FROM runs WHERE id = ?`, runId);
  return { ...row, metrics: row.metrics_json ? JSON.parse(row.metrics_json) : null };
}

async function logOf(runId) {
  const [row] = await rows("SELECT tail, final, lines_total FROM run_logs WHERE run_id = ?", runId);
  return row ?? null;
}

describe("Cloudflare Containers executor", () => {
  it("does nothing, and creates no machine, until a job targets it", async () => {
    await createJob("local", {}, { now: NOW });
    expect(await dispatchCloudflare(env, NOW)).toEqual({ jobs: 0 });
    expect(await rows("SELECT id FROM machines")).toEqual([]);
  });

  it("starts a one-CPU job on basic, runs the deployed version of its tag, and keeps vault secrets out of D1", async () => {
    const secret = await call("/v1/secrets/r2-key", { method: "PUT", body: { value: "s3-secret-value" }, now: NOW });
    expect(secret.status).toBe(201);
    const runId = await due("harmonie", {
      env: { AWS_REGION: "auto" },
      secretEnv: { AWS_SECRET_ACCESS_KEY: "vault:r2-key" },
      args: ["--models", "harmonie"],
      report: { format: "json-lines", trackEvent: "forecast_complete", trackBy: "model" },
    });
    const fake = starter();
    const summary = await dispatchCloudflare(env, NOW, { ...fake, image: IMAGE });
    expect(summary.started).toBe(1);
    expect(fake.started[0]).toMatchObject({
      runId, jobId: "harmonie", instanceType: "basic", binding: "HC_CONTAINER_BASIC", enableInternet: true,
      command: ["python", "/app/force5/ingest/worker.py", "--models", "harmonie"],
      env: { AWS_REGION: "auto", AWS_SECRET_ACCESS_KEY: "s3-secret-value" },
      secretValues: ["s3-secret-value"],
    });
    // The object settles at the run's own deadline; the cron's grace after it is only the backstop.
    expect(fake.started[0].deadlineAt).toBe(NOW + 600_000);
    const run = await stateOf(runId);
    expect(run).toMatchObject({ state: "running", machine_id: CLOUDFLARE_MACHINE_ID, memory_limit_bytes: 1024 * 1048576 });
    expect(run.image_ref).toBe(TAGGED);
    expect(run.image_digest).toBe(`sha256:${DIGEST}`);
    expect(run.metrics).toMatchObject({ instanceType: "basic", vcpu: 0.25, memoryMiB: 1024, diskMiB: 4096 });
    expect(JSON.stringify(await rows("SELECT metrics_json, error, parameters_json FROM runs"))).not.toContain("s3-secret-value");
    const [machine] = await rows("SELECT name, labels_json, credential_hash, facts_json FROM machines");
    expect(machine.name).toBe("cloudflare");
    expect(JSON.parse(machine.labels_json).runtime).toBe("cloudflare-container");
    expect(machine.credential_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(machine.facts_json)).toMatchObject({ image: IMAGE, imageDigest: `sha256:${DIGEST}`, instanceTypes: ["basic"] });

    // The running tail the object keeps current, redacted of the run's secrets.
    const running = probe({ lines: ["fetching", "key=s3-secret-value"] });
    await runningTail(env.DB, runId, running, ["s3-secret-value"], NOW + 5_000, { lines: 200, bytes: 32 * 1024 }).run();
    expect((await logOf(runId)).tail).toBe("fetching\nkey=<redacted>");

    const finished = probe({
      exitCode: 0,
      peakMemoryBytes: 1024 * 1048576,
      lines: ["fetching", '{"event": "forecast_complete", "model": "harmonie", "run": "2026101806"}', "done s3-secret-value"],
    });
    const settled = await recordContainerStop(env.DB, runId, { exitCode: 0, probe: finished, secretValues: ["s3-secret-value"],
      peakMemoryBytes: finished.peakMemoryBytes, cpuSeconds: 2 }, NOW + 10_000);
    expect(settled.state).toBe("succeeded");
    const done = await stateOf(runId);
    // Peak at the limit with a clean exit is page cache, not an OOM.
    expect(done).toMatchObject({ exit_code: 0, oom_killed: 0, outcome: "published" });
    expect(done.metrics).toMatchObject({ containerSeconds: 10, instanceType: "basic" });
    expect(JSON.parse(done.reports_json)[0]).toMatchObject({ event: "forecast_complete", model: "harmonie" });
    const log = await logOf(runId);
    expect(log.final).toBe(1);
    expect(log.tail).toContain("done <redacted>");
    expect(log.tail).not.toContain("s3-secret-value");
    const [state] = await rows("SELECT published_json FROM schedule_state WHERE job_id = 'harmonie'");
    expect(state.published_json).toContain("2026101806");
  });

  it("takes the error from the job's output when it fails", async () => {
    const runId = await due("icon");
    await dispatchCloudflare(env, NOW, { ...starter(), image: IMAGE });
    const failing = probe({ exitCode: 1, lines: ["Traceback (most recent call last):", '  File "worker.py", line 3', "ValueError: no GRIB"] });
    await recordContainerStop(env.DB, runId, { exitCode: 1, probe: failing, secretValues: [] }, NOW + 5_000);
    const run = await stateOf(runId);
    expect(run).toMatchObject({ state: "failed", exit_code: 1, oom_killed: 0 });
    expect(run.error).toBe("ValueError: no GRIB");
  });

  it("leaves a second job due when the concurrency guard is full", async () => {
    const first = await due("one");
    const second = await due("two");
    const fake = starter();
    await dispatchCloudflare(env, NOW, { ...fake, image: IMAGE });
    expect(fake.started.map((spec) => spec.runId)).toEqual([first]);
    expect((await stateOf(second)).state).toBe("due");
  });

  it("puts a run back to due when no instance is free yet, and starts it the next minute", async () => {
    const runId = await due("busy");
    let full = true;
    const fake = starter(async () => {
      if (full) throw new Error("there is no container instance that can be provided to this durable object");
      return {};
    });
    const first = await dispatchCloudflare(env, NOW, { ...fake, image: IMAGE });
    expect(first).toMatchObject({ started: 0, failed: 0, leftDue: 1 });
    expect(await stateOf(runId)).toMatchObject({ state: "due", machine_id: null, started_at: null });
    full = false;
    const second = await dispatchCloudflare(env, NOW + 60_000, { ...fake, image: IMAGE });
    expect(second.started).toBe(1);
    expect((await stateOf(runId)).state).toBe("running");
  });

  it("fails closed, with the reason, when a job cannot run on Cloudflare", async () => {
    const big = await due("big", { resources: { cpus: 1, memoryMiB: 2048, diskMiB: 2048 } });
    const disk = await due("disk", { resources: { cpus: 1, memoryMiB: 512, diskMiB: 12288 } });
    const tooLong = await due("long", { timeouts: { runSeconds: 1300 } });
    const local = await due("local-secret", { secretEnv: { TOKEN: "local:TOKEN" } });
    const bare = await due("bare", { entrypoint: null });
    const named = await due("std", { resources: { instanceType: "standard-1", cpus: 0.5, memoryMiB: 4096, diskMiB: 8192 } });
    const fake = starter();
    await call("/v1/settings", { method: "PATCH", body: { cloudflare: { maxConcurrent: 10 } }, now: NOW });
    await dispatchCloudflare(env, NOW, { ...fake, image: IMAGE });
    expect(fake.started).toEqual([]);
    expect((await stateOf(big)).error).toMatch(/no deployed instance type holds 2048 MiB memory/);
    expect((await stateOf(disk)).error).toMatch(/12288 MiB disk/);
    expect((await stateOf(tooLong)).error).toMatch(/1200/);
    expect((await stateOf(local)).error).toMatch(/local:/);
    expect((await stateOf(bare)).error).toMatch(/needs an entrypoint/);
    expect((await stateOf(named)).error).toMatch(/standard-1 is not deployed/);
  });

  it("fails a job whose image is not the one deployed, or when none is", async () => {
    const other = await due("other", { image: "ghcr.io/sprintengine/other:production" });
    const pinned = await due("pinned", { image: `ghcr.io/sprintengine/wingfoil-forecast@sha256:${"cd".repeat(32)}` });
    await call("/v1/settings", { method: "PATCH", body: { cloudflare: { maxConcurrent: 5 } }, now: NOW });
    const fake = starter();
    await dispatchCloudflare(env, NOW, { ...fake, image: IMAGE });
    expect(fake.started).toEqual([]);
    expect((await stateOf(other)).error).toMatch(/is not the image deployed on Cloudflare/);
    expect((await stateOf(pinned)).error).toMatch(/is not the image deployed on Cloudflare/);
    const none = await due("none");
    await dispatchCloudflare(env, NOW, { ...fake, image: "" });
    expect((await stateOf(none)).error).toMatch(/set-container-image\.sh/);
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

  it("receives secrets allowed to a pool once settings give the executor that label", async () => {
    await call("/v1/secrets/r2-key", { method: "PUT", body: { value: "s3-secret-value", allowedLabels: { pool: "wingfoil" } }, now: NOW });
    const runId = await due("pooled", { secretEnv: { AWS_SECRET_ACCESS_KEY: "vault:r2-key" } });
    const fake = starter();
    await dispatchCloudflare(env, NOW, { ...fake, image: IMAGE });
    expect(fake.started).toEqual([]);
    expect((await stateOf(runId)).state).toBe("due");
    expect((await call("/v1/settings", { method: "PATCH", body: { cloudflare: { labels: { pool: "wingfoil" } } }, now: NOW })).status).toBe(200);
    expect((await call("/v1/settings", { method: "PATCH", body: { cloudflare: { labels: { site: "home" } } }, now: NOW })).status).toBe(400);
    await dispatchCloudflare(env, NOW + 60_000, { ...fake, image: IMAGE });
    expect(fake.started.map((spec) => spec.runId)).toEqual([runId]);
    expect(fake.started[0].env.AWS_SECRET_ACCESS_KEY).toBe("s3-secret-value");
    const [machine] = await rows("SELECT labels_json FROM machines WHERE id = ?", CLOUDFLARE_MACHINE_ID);
    expect(JSON.parse(machine.labels_json)).toMatchObject({ pool: "wingfoil", runtime: "cloudflare-container", site: "cloudflare" });
  });

  it("runs a job pinned to the ghcr digest the deployed image was copied from", async () => {
    const index = `ghcr.io/sprintengine/wingfoil-forecast@sha256:${"ef".repeat(32)}`;
    const runId = await due("pinned-source", { image: index });
    const fake = starter();
    await dispatchCloudflare(env, NOW, { ...fake, image: IMAGE, source: index });
    expect(fake.started.map((spec) => spec.runId)).toEqual([runId]);
    const [machine] = await rows("SELECT facts_json FROM machines WHERE id = ?", CLOUDFLARE_MACHINE_ID);
    expect(JSON.parse(machine.facts_json).imageSource).toBe(index);
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
  });

  it("does not renew a lease from the cron: a container that stops answering is lost, and a stuck claim does not block the job", async () => {
    const runId = await due("quiet");
    await dispatchCloudflare(env, NOW, { ...starter(), image: IMAGE });
    // No object renewed it (the container went): three minutes on, the run is lost like a machine's.
    await cron(NOW + 4 * 60_000);
    expect((await stateOf(runId)).state).toBe("lost");
    // A claim the cron never got past (it died between claim and start) runs out too.
    const stuck = await due("stuck");
    await env.DB.prepare(`UPDATE runs SET state = 'claimed', machine_id = ?1, lease_expires_at = ?2, claimed_at = ?3 WHERE id = ?4`)
      .bind(CLOUDFLARE_MACHINE_ID, NOW + 180_000, NOW, stuck).run();
    await cron(NOW + 4 * 60_000);
    expect((await stateOf(stuck)).state).toBe("lost");
    const ignored = await recordContainerStop(env.DB, runId, { exitCode: 137, stopReason: "lost" }, NOW + 5 * 60_000);
    expect(ignored.ignored).toBe(true);
  });

  it("asks each running run's object to check, and a just-cancelled run's too, so its container goes at once", async () => {
    const going = await due("going");
    await dispatchCloudflare(env, NOW, { ...starter(), image: IMAGE });
    const cancelled = await due("cancel-me");
    await env.DB.prepare(`UPDATE runs SET state = 'cancelled', machine_id = ?1, metrics_json = '{"instanceType":"basic"}', updated_at = ?2
      WHERE id = ?3`).bind(CLOUDFLARE_MACHINE_ID, NOW, cancelled).run();
    const old = await due("old");
    await env.DB.prepare(`UPDATE runs SET state = 'cancelled', machine_id = ?1, metrics_json = '{"instanceType":"basic"}', updated_at = ?2
      WHERE id = ?3`).bind(CLOUDFLARE_MACHINE_ID, NOW - 3_600_000, old).run();
    const ticked = [];
    const namespace = { getByName: (name) => ({ tick: async () => { ticked.push(name); return { running: true }; } }) };
    await dispatchCloudflare({ ...env, HC_CONTAINER_BASIC: namespace }, NOW + 60_000, { ...starter(), image: IMAGE });
    expect(ticked.sort()).toEqual([going, cancelled].sort());
  });

  it("times out with the same backstop as a machine, and reports container-seconds", async () => {
    const runId = await due("trial");
    await dispatchCloudflare(env, NOW, { ...starter(), image: IMAGE });
    await env.DB.prepare("UPDATE runs SET started_at = ?, lease_expires_at = ? WHERE id = ?").bind(NOW - 1_000_000, NOW + 600_000, runId).run();
    const summary = await cron(NOW);
    expect(summary.timedOut).toBe(1);
    const timed = await stateOf(runId);
    expect(timed.state).toBe("timed-out");
    expect(timed.metrics.containerSeconds).toBeGreaterThan(0);
    const usage = await getContainers({ db: env.DB, now: NOW });
    const body = await usage.json();
    expect(body.containerSeconds).toBe(timed.metrics.containerSeconds);
    expect(body.byInstanceType.basic).toBe(body.containerSeconds);
  });

  it("settles a run at its deadline as timed out, with what it printed", async () => {
    const runId = await due("slow");
    await dispatchCloudflare(env, NOW, { ...starter(), image: IMAGE });
    await recordContainerStop(env.DB, runId, { stopReason: "timeout", probe: probe({ lines: ["still going"] }), secretValues: [] }, NOW + 600_000);
    const run = await stateOf(runId);
    expect(run).toMatchObject({ state: "timed-out", timed_out: 1, oom_killed: 0 });
    expect((await logOf(runId)).tail).toBe("still going");
  });

  it("asks hc-core to dispatch at once after Run now, Cancel and Retry", async () => {
    await createJob("now", cloudJob(), { now: NOW });
    const calls = [];
    const waited = [];
    const environment = { ...env, HC_CORE: { dispatch: async () => { calls.push("dispatch"); return {}; } } };
    const ctx = { waitUntil: (promise) => waited.push(promise), passThroughOnException() {} };
    const run = await call("/v1/jobs/now/run", { method: "POST", body: {}, now: NOW, environment, ctx });
    expect(run.status).toBe(202);
    await Promise.all(waited);
    expect(calls).toEqual(["dispatch"]);
    const cancel = await call(`/v1/runs/${run.body.runId}/cancel`, { method: "POST", now: NOW, environment, ctx });
    expect(cancel.status).toBe(202);
    await Promise.all(waited);
    expect(calls).toHaveLength(2);
    // A binding that throws at once does not fail the request it follows.
    const broken = { ...env, HC_CORE: { dispatch() { throw new TypeError("no such entrypoint"); } } };
    const again = await call("/v1/jobs/now/run", { method: "POST", body: {}, now: NOW + 1, environment: broken, ctx });
    expect(again.status).toBe(202);
    await call(`/v1/runs/${run.body.runId}/retry`, { method: "POST", body: {}, now: NOW + 2, environment: broken, ctx }).then((response) => expect(response.status).toBeLessThan(500));
    await Promise.all(waited);
    // A refused request does not nudge.
    expect((await call("/v1/jobs/missing/run", { method: "POST", body: {}, now: NOW, environment, ctx })).status).toBe(404);
    expect(calls).toHaveLength(2);
  });

  it("accepts an instance type on the job and the concurrency guard in settings", async () => {
    await due("trial");
    const cleared = await call("/v1/jobs/trial/resources", { method: "PATCH", body: { instanceType: null }, now: NOW });
    expect(cleared.status).toBe(200);
    expect(cleared.body.resources.instanceType).toBeUndefined();
    const set = await call("/v1/jobs/trial/resources", { method: "PATCH", body: { instanceType: "basic", cpus: 0.25, memoryMiB: 1024, diskMiB: 4096 }, now: NOW });
    expect(set.body.resources.instanceType).toBe("basic");
    expect((await call("/v1/settings", { method: "PATCH", body: { cloudflare: { maxConcurrent: 0 } }, now: NOW })).status).toBe(400);
    expect((await call("/v1/settings", { method: "PATCH", body: { cloudflare: { maxRunSeconds: 600 } }, now: NOW })).body.cloudflare).toEqual({ maxConcurrent: 1, maxRunSeconds: 600, labels: {} });
    await dispatchCloudflare(env, NOW, { ...starter(), image: IMAGE });
    const refused = await call(`/v1/machines/${CLOUDFLARE_MACHINE_ID}`, { method: "PATCH", body: { name: "renamed" }, now: NOW });
    expect(refused.status).toBe(400);
    const drained = await call(`/v1/machines/${CLOUDFLARE_MACHINE_ID}`, { method: "PATCH", body: { drain: true }, now: NOW });
    expect(drained.status).toBe(200);
    expect(drained.body.drain).toBe(true);
  });
});

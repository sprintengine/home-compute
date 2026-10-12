// hc-web's machine endpoints, run cancel/retry, and what the snapshot shows
// of machines and runs once agents enrol.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { call, createJob, enrolMachine, mockCertificates, resetDatabase, rows, syncAs } from "./helpers.mjs";

const DAY0 = Math.floor(Date.now() / 86_400_000) * 86_400_000 - 86_400_000;
const at = (hours, minutes = 0, seconds = 0) => DAY0 + ((hours * 60 + minutes) * 60 + seconds) * 1000;
const OPERATOR = "op@example.com";
let certificates;

beforeEach(async () => {
  await resetDatabase();
  certificates = mockCertificates();
  await call("/v1/settings", { method: "PATCH", body: { roles: { [OPERATOR]: "operator", "viewer@example.com": "viewer" } } });
});
afterEach(() => certificates.mockRestore());

describe("machines", () => {
  it("lists machines with their status, VM, current runs and no credentials", async () => {
    const machine = await enrolMachine("mac-mini", { labels: { site: "home" }, facts: { os: "darwin", arch: "arm64", runtime: "colima" } });
    await createJob("ecmwf", { schedule: null }, { now: at(7) });
    const run = (await call("/v1/jobs/ecmwf/run", { method: "POST", body: {}, now: at(8) })).body.runId;
    const now = Date.now();
    await syncAs(machine, now, { machine: { drain: false, vm: { kind: "colima", state: "running", cpus: 2, memoryMiB: 2048 },
      free: { cpus: 2, memoryMiB: 4096, diskMiB: 30_000, runs: 2 }, health: { docker: "ok" } } });
    const list = await call("/v1/machines", { identity: "viewer@example.com" });
    expect(list.status).toBe(200);
    const [view] = list.body.machines;
    expect(view).toMatchObject({
      id: machine.machineId, name: "mac-mini", status: "online", labels: { arch: "arm64", os: "darwin", runtime: "colima", site: "home" },
      vm: { kind: "colima", state: "running", cpus: 2, memoryMiB: 2048 }, free: { cpus: 2, memoryMiB: 4096, runs: 2 },
      agentVersion: "0.2.0", drain: false, localDrain: false, currentRuns: [{ id: run, job: "ecmwf", phase: "claimed" }],
    });
    expect(JSON.stringify(list.body)).not.toMatch(/hca_|credential_hash/);
    expect((await call(`/v1/machines/${machine.machineId}`)).body.name).toBe("mac-mini");
    expect((await call("/v1/machines/m_00000000000000000000000000")).status).toBe(404);
  });

  it("lets an operator drain, but only an admin rename, relabel, cap or revoke; every change is audited", async () => {
    const machine = await enrolMachine("box");
    const path = `/v1/machines/${machine.machineId}`;
    expect((await call(path, { method: "PATCH", body: { drain: true }, identity: OPERATOR })).body).toMatchObject({ drain: true, changed: ["drain"] });
    expect((await call(path, { method: "PATCH", body: { labels: { gpu: "no" } }, identity: OPERATOR })).status).toBe(403);
    expect((await call(path, { method: "DELETE", identity: OPERATOR })).status).toBe(403);
    expect((await call(path, { method: "PATCH", body: { drain: false }, identity: "viewer@example.com" })).status).toBe(403);
    const edited = await call(path, { method: "PATCH", body: { name: "linux-box", labels: { gpu: "no" }, capacity: { memoryMiB: 4096, maxRuns: 1 }, capabilities: ["provisioner"] } });
    expect(edited.body).toMatchObject({ name: "linux-box", labels: { gpu: "no" }, capacity: { memoryMiB: 4096, maxRuns: 1 }, capabilities: ["provisioner"] });
    expect((await call(path, { method: "PATCH", body: { capacity: { memoryMiB: -1 } } })).status).toBe(400);
    expect((await call(path, { method: "PATCH", body: { colour: "red" } })).status).toBe(400);
    await enrolMachine("other");
    expect((await call(path, { method: "PATCH", body: { name: "other" } })).status).toBe(409);
    // A revoked machine's name can be taken.
    const gone = await enrolMachine("old-box");
    await call(`/v1/machines/${gone.machineId}`, { method: "DELETE" });
    expect((await call(path, { method: "PATCH", body: { name: "old-box" } })).body.name).toBe("old-box");
    await call(path, { method: "PATCH", body: { name: "linux-box" } });
    const revoked = await call(path, { method: "DELETE" });
    expect(revoked.body).toMatchObject({ revoked: true, changed: true });
    expect((await call(path, { method: "DELETE" })).body.changed).toBe(false);
    expect((await call(path, { method: "PATCH", body: { drain: true } })).status).toBe(409);
    expect((await call("/v1/machines")).body.machines.map((entry) => entry.name)).toEqual(["other"]);
    expect((await call("/v1/machines?all=1")).body.machines.find((entry) => entry.id === machine.machineId).status).toBe("revoked");
    const actions = (await rows("SELECT action FROM audit_log ORDER BY id")).map((row) => row.action);
    expect(actions.filter((action) => action.startsWith("machine."))).toEqual([
      "machine.join-token", "machine.enrol", "machine.drain", "machine.update", "machine.join-token", "machine.enrol",
      "machine.join-token", "machine.enrol", "machine.revoke", "machine.update", "machine.update", "machine.revoke",
    ]);
  });

  it("moves the changes cursor when a machine is drained", async () => {
    const machine = await enrolMachine("box");
    const before = (await call("/v1/changes")).body.cursor;
    await call(`/v1/machines/${machine.machineId}`, { method: "PATCH", body: { drain: true } });
    expect((await call(`/v1/changes?since=${before}`)).status).toBe(200);
  });
});

describe("runs: cancel and retry", () => {
  it("cancels waiting runs, refuses finished ones, and retries a finished run as a new attempt", async () => {
    await createJob("ecmwf", { schedule: null, placement: { preferMachines: ["mac-mini"] } }, { now: at(7) });
    const runId = (await call("/v1/jobs/ecmwf/run", { method: "POST", body: { extraParameters: ["--fast"] }, now: at(8) })).body.runId;
    expect((await call(`/v1/runs/${runId}/retry`, { method: "POST", body: {} })).status).toBe(409);
    expect((await call(`/v1/runs/${runId}/cancel`, { method: "POST", identity: "viewer@example.com" })).status).toBe(403);
    const cancelled = await call(`/v1/runs/${runId}/cancel`, { method: "POST", identity: OPERATOR });
    expect(cancelled.body).toMatchObject({ event: "run_cancelled", previousState: "due", machine: null });
    expect((await call(`/v1/runs/${runId}/cancel`, { method: "POST" })).status).toBe(409);
    const retried = await call(`/v1/runs/${runId}/retry`, { method: "POST", body: {}, now: at(9) });
    expect(retried.body).toMatchObject({ event: "run_retried", retryOf: runId, attempt: 2 });
    const [row] = await rows("SELECT * FROM runs WHERE id = ?", retried.body.runId);
    expect(row).toMatchObject({ state: "due", source: "retry", attempt: 2, retry_of: runId, due_at: at(9), preferred_until: at(9, 5),
      parameters_json: '["--fast"]' });
    expect((await call(`/v1/runs/${runId}/retry`, { method: "POST", body: {} })).status).toBe(409);
    const audit = (await rows("SELECT action FROM audit_log WHERE action LIKE 'run.%' ORDER BY id")).map((entry) => entry.action);
    expect(audit).toEqual(["run.cancel", "run.retry"]);
  });
});

describe("snapshot", () => {
  it("shows machines, active runs with why they wait, the latest runs and each job's last reports", async () => {
    await createJob("blend", { schedule: null, placement: { requireLabels: { arch: "amd64" } } }, { now: at(7) });
    await createJob("ecmwf", { schedule: null, report: { format: "json-lines", trackEvent: "forecast_complete", trackBy: "model" } }, { now: at(7) });
    const now = Date.now();
    const blend = (await call("/v1/jobs/blend/run", { method: "POST", body: {}, now: now - 120_000 })).body.runId;
    const ecmwf = (await call("/v1/jobs/ecmwf/run", { method: "POST", body: {}, now: now - 120_000 })).body.runId;
    const machine = await enrolMachine("mac-mini", { facts: { os: "darwin", arch: "arm64" } });
    const { claims } = (await syncAs(machine, now - 60_000)).body;
    expect(claims.map((claim) => claim.run.id)).toEqual([ecmwf]);
    await syncAs(machine, now - 50_000, { runs: [{ id: ecmwf, phase: "running" }] });
    const completed = await syncAs(machine, now - 40_000, { runs: [{ id: ecmwf, phase: "reporting" }] });
    expect(completed.status).toBe(200);
    const { handleCore } = await import("../src/hc-core.mjs");
    const { env } = await import("cloudflare:workers");
    await handleCore(new Request(`https://core.example.com/agent/v1/runs/${ecmwf}/complete`, {
      method: "POST",
      headers: { authorization: `Bearer ${machine.credential}`, "content-type": "application/json" },
      body: JSON.stringify({ protocol: 1, exitCode: 0, reports: [{ event: "forecast_complete", model: "ecmwf", run: "2026101100" }] }),
    }), env, { now: now - 30_000 });

    const snapshot = (await call("/v1/snapshot")).body;
    expect(snapshot.machines).toHaveLength(1);
    expect(snapshot.machines[0]).toMatchObject({ name: "mac-mini", status: "online", currentRuns: [] });
    expect(snapshot.nodes[0]).toMatchObject({ name: "mac-mini", Connection: "CONNECTED", Info: { NodeID: "mac-mini" } });
    expect(snapshot.activeRuns.map((run) => [run.id, run.phase, run.waiting])).toEqual([[blend, "due", "waiting 2 min: no machine has labels arch=amd64"]]);
    const jobs = Object.fromEntries(snapshot.jobs.map((job) => [job.id, job]));
    expect(jobs.blend.waiting).toBe("waiting 2 min: no machine has labels arch=amd64");
    expect(jobs.ecmwf).toMatchObject({ lastOutcome: "published", lastReports: [{ event: "forecast_complete", model: "ecmwf", run: "2026101100" }] });
    expect(jobs.ecmwf.published.ecmwf.run).toBe("2026101100");
    expect(jobs.ecmwf.recentRuns[0]).toMatchObject({ id: ecmwf, machine: machine.machineId, machineName: "mac-mini", state: "Completed" });
    expect(snapshot.recentRuns.map((run) => run.id)).toEqual([ecmwf, blend]);
  });
});

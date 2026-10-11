// What hc-web adds for the hosted dashboard (M4): editing a job's placement,
// resources and image on their own; a machine's last day of runs and VM
// uptime; and the snapshot's next slots, duration sparklines, lost runs and
// agents behind the version machines should run.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleCore } from "../src/hc-core.mjs";
import { vmTimeline } from "../src/sync.mjs";
import { call, createJob, enrolMachine, mockCertificates, resetDatabase, rows, syncAs } from "./helpers.mjs";

const OPERATOR = "op@example.com";
const VIEWER = "viewer@example.com";
let certificates;

beforeEach(async () => {
  await resetDatabase();
  certificates = mockCertificates();
  await call("/v1/settings", { method: "PATCH", body: { roles: { [OPERATOR]: "operator", [VIEWER]: "viewer" } } });
});
afterEach(() => certificates.mockRestore());

async function complete(machine, runId, now, body) {
  return handleCore(new Request(`https://core.example.com/agent/v1/runs/${runId}/complete`, {
    method: "POST",
    headers: { authorization: `Bearer ${machine.credential}`, "content-type": "application/json" },
    body: JSON.stringify({ protocol: 1, ...body }),
  }), env, { now });
}

/** A manual run of `job`, claimed by `machine`, run and finished with `body`, from `start` for `seconds`. */
async function runOn(machine, job, start, seconds, body = { exitCode: 0 }) {
  const runId = (await call(`/v1/jobs/${job}/run`, { method: "POST", body: {}, now: start })).body.runId;
  const { claims } = (await syncAs(machine, start + 1000)).body;
  expect(claims.map((claim) => claim.run.id)).toContain(runId);
  await syncAs(machine, start + 2000, { claim: false, runs: [{ id: runId, phase: "running" }] });
  const response = await complete(machine, runId, start + 2000 + seconds * 1000, { durationMs: seconds * 1000, ...body });
  expect(response.status).toBe(200);
  return runId;
}

describe("job parts: placement, resources, image", () => {
  it("saves each part through the job's own validation, audits it and moves the revision", async () => {
    await createJob("ecmwf");
    const placement = await call("/v1/jobs/ecmwf/placement", {
      method: "PATCH", identity: OPERATOR, body: { requireLabels: { arch: "arm64" }, preferMachines: ["mac-mini"], preferWaitSeconds: 600 },
    });
    expect(placement.status).toBe(200);
    expect(placement.body).toMatchObject({
      revision: 2, changed: ["placement"], placement: { requireLabels: { arch: "arm64" }, preferMachines: ["mac-mini"], preferWaitSeconds: 600 },
    });
    expect(placement.headers.get("etag")).toBe('"2"');
    // A field given as null is removed; the others stay.
    const cleared = await call("/v1/jobs/ecmwf/placement", { method: "PATCH", identity: OPERATOR, body: { preferMachines: null } });
    expect(cleared.body.placement).toEqual({ requireLabels: { arch: "arm64" }, preferWaitSeconds: 600 });

    const resources = await call("/v1/jobs/ecmwf/resources", { method: "PATCH", identity: OPERATOR, body: { memoryMiB: 768 } });
    expect(resources.body.resources).toMatchObject({ memoryMiB: 768, cpus: 1 });
    expect((await call("/v1/jobs/ecmwf/resources", { method: "PATCH", body: { memoryMiB: 1 } })).status).toBe(400);
    expect((await call("/v1/jobs/ecmwf/resources", { method: "PATCH", body: { gpus: 1 } })).body.error).toMatch(/Unknown resources field gpus/);
    expect((await call("/v1/jobs/ecmwf/resources", { method: "PATCH", body: {} })).status).toBe(400);
    // Unchanged: no new revision.
    expect((await call("/v1/jobs/ecmwf/resources", { method: "PATCH", body: { memoryMiB: 768 } })).body).toMatchObject({ revision: 4, changed: [] });

    const image = "ghcr.io/example/worker@sha256:abcd";
    expect((await call("/v1/jobs/ecmwf/image", { method: "PATCH", identity: OPERATOR, body: { image } })).status).toBe(403);
    expect((await call("/v1/jobs/ecmwf/image", { method: "PATCH", body: { image: "has space" } })).status).toBe(400);
    expect((await call("/v1/jobs/ecmwf/image", { method: "PATCH", body: { image }, headers: { "if-match": '"1"' } })).status).toBe(412);
    const pinned = await call("/v1/jobs/ecmwf/image", { method: "PATCH", body: { image }, headers: { "if-match": '"4"' } });
    expect(pinned.body).toMatchObject({ image, revision: 5 });
    expect((await call("/v1/jobs/ecmwf/placement", { method: "PATCH", identity: VIEWER, body: { preferWaitSeconds: 1 } })).status).toBe(403);
    expect((await call("/v1/jobs/ghost/resources", { method: "PATCH", body: { cpus: 1 } })).status).toBe(404);

    const audit = await rows("SELECT actor, action FROM audit_log WHERE action LIKE 'job.%' AND action != 'job.create' ORDER BY id");
    expect(audit).toEqual([
      { actor: OPERATOR, action: "job.placement" }, { actor: OPERATOR, action: "job.placement" },
      { actor: OPERATOR, action: "job.resources" }, { actor: "owner@example.com", action: "job.image" },
    ]);
    const job = (await call("/v1/jobs/ecmwf")).body;
    expect([job.image, job.resources.memoryMiB, job.placement.preferWaitSeconds]).toEqual([image, 768, 600]);
  });

  it("needs the CSRF token like every other change", async () => {
    await createJob("ecmwf");
    const refused = await call("/v1/jobs/ecmwf/resources", { method: "PATCH", body: { memoryMiB: 512 }, headers: { "x-hc-csrf": undefined } });
    expect(refused.body).toEqual({ error: "csrf_check_failed", reason: "csrf_token" });
  });
});

describe("machines for the dashboard", () => {
  it("records when the VM changed state and when it ran over the last day", () => {
    const hour = 3_600_000;
    let facts = { os: "darwin" };
    const step = (state, now) => { facts = { ...facts, vm: { state }, ...vmTimeline(facts, { state }, now) }; };
    step("stopped", 0);
    expect(facts).toMatchObject({ vmSince: 0, vmHistory: [] });
    step("running", hour);
    step("running", 2 * hour);
    expect(facts).toMatchObject({ vmSince: hour, vmHistory: [{ from: hour, to: null }] });
    step("stopped", 3 * hour);
    step("running", 30 * hour);
    expect(facts.vmHistory).toEqual([{ from: 30 * hour, to: null }], "a span over a day old is dropped");
    expect(vmTimeline({}, null, 5)).toEqual({}, "a Docker host has no VM");
  });

  it("lists a machine's last day of runs and its VM spans, newest first", async () => {
    const machine = await enrolMachine("mac-mini");
    await createJob("blend", { schedule: null });
    const now = Date.now();
    await syncAs(machine, now - 3 * 3_600_000, { claim: false, machine: { drain: false, vm: { kind: "colima", state: "stopped" }, free: { cpus: 2, memoryMiB: 2048, diskMiB: 9000, runs: 2 }, health: { docker: "ok" } } });
    const vmRunning = { drain: false, vm: { kind: "colima", state: "running", cpus: 2, memoryMiB: 2048 }, free: { cpus: 2, memoryMiB: 2048, diskMiB: 9000, runs: 2 }, health: { docker: "ok" } };
    await syncAs(machine, now - 2 * 3_600_000, { claim: false, machine: vmRunning });
    const first = await runOn(machine, "blend", now - 2 * 3_600_000 + 5000, 40);
    const second = await runOn(machine, "blend", now - 3_600_000, 20, { exitCode: 1 });
    const timeline = await call(`/v1/machines/${machine.machineId}/runs`, { identity: VIEWER });
    expect(timeline.status).toBe(200);
    expect(timeline.body.runs.map((run) => [run.id, run.phase, run.machineName])).toEqual([[second, "failed", "mac-mini"], [first, "succeeded", "mac-mini"]]);
    const later = await call(`/v1/machines/${machine.machineId}/runs?since=${now - 90 * 60_000}`);
    expect(later.body.runs.map((run) => run.id)).toEqual([second]);
    expect((await call(`/v1/machines/${machine.machineId}/runs?since=nope`)).status).toBe(400);

    const view = (await call(`/v1/machines/${machine.machineId}`)).body;
    expect(view.vmSince).toBe(new Date(now - 2 * 3_600_000).toISOString());
    expect(view.vmHistory).toEqual([{ from: new Date(now - 2 * 3_600_000).toISOString(), to: null }]);
    expect(view.facts.vmHistory).toBeUndefined();
  });

  it("marks agents older than the desired version (the setting, else the newest enrolled)", async () => {
    const old = await enrolMachine("old-box");
    const fresh = await enrolMachine("new-box");
    const now = Date.now();
    await syncAs(old, now, { agentVersion: "0.2.0" });
    await syncAs(fresh, now, { agentVersion: "0.10.0" });
    let machines = (await call("/v1/snapshot")).body.machines;
    expect(machines.map((machine) => [machine.name, machine.updateAvailable ?? false])).toEqual([["new-box", false], ["old-box", true]]);
    expect(machines[1].desiredAgentVersion).toBe("0.10.0");
    await call("/v1/settings", { method: "PATCH", body: { desiredAgentVersion: "0.11.0" } });
    machines = (await call("/v1/machines")).body.machines;
    expect(machines.map((machine) => machine.updateAvailable ?? false)).toEqual([true, true]);
  });
});

describe("snapshot for the overview", () => {
  it("lists the next six slots across jobs with the machine expected to take each", async () => {
    const machine = await enrolMachine("mac-mini", { facts: { os: "darwin", arch: "arm64" } });
    await syncAs(machine, Date.now(), { claim: false });
    await createJob("blend", { schedule: { at: { minutes: [5] } }, placement: { preferMachines: ["mac-mini"] } });
    await createJob("gfs", { schedule: { at: { hours: [3, 9, 15, 21], minutes: [40] } }, placement: { requireLabels: { arch: "amd64" } } });
    await createJob("tides", { schedule: { every: "6h" }, secretEnv: { KEY: "vault:tides-key" } });
    await createJob("off", { enabled: false, schedule: { at: { minutes: [0] } } });
    const snapshot = (await call("/v1/snapshot")).body;
    expect(snapshot.upcoming).toHaveLength(6);
    const times = snapshot.upcoming.map((slot) => Date.parse(slot.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(snapshot.upcoming.every((slot) => Date.parse(slot.at) > Date.now() - 1000)).toBe(true);
    expect(snapshot.upcoming.some((slot) => slot.job === "off")).toBe(false);
    const byJob = Object.fromEntries(snapshot.upcoming.map((slot) => [slot.job, slot]));
    expect(byJob.blend).toMatchObject({ machine: "mac-mini" });
    expect(snapshot.upcoming.filter((slot) => slot.job === "blend").length).toBeGreaterThanOrEqual(4);
    if (byJob.gfs) expect(byJob.gfs).toMatchObject({ machine: null, note: "no machine has labels arch=amd64" });
    const blend = snapshot.jobs.find((job) => job.id === "blend");
    expect(blend.placement).toEqual({ preferMachines: ["mac-mini"] });
    expect(snapshot.controller.features).toEqual(expect.arrayContaining(["changes", "settings", "job-parts", "machine-runs"]));

    await call("/v1/pause-all", { method: "POST" });
    expect((await call("/v1/snapshot")).body.upcoming).toEqual([]);
  });

  it("gives each job its recent durations for a sparkline, and lists runs lost in the last day", async () => {
    const machine = await enrolMachine("box");
    await createJob("blend", { schedule: null });
    const start = Date.now() - 4 * 3_600_000;
    const runs = [];
    for (let index = 0; index < 7; index += 1) {
      runs.push(await runOn(machine, "blend", start + index * 600_000, 30 + index, index === 3 ? { exitCode: 2 } : { exitCode: 0 }));
    }
    const lostId = (await call("/v1/jobs/blend/run", { method: "POST", body: {}, now: start + 3 * 3_600_000 })).body.runId;
    await env.DB.prepare("UPDATE runs SET state = 'lost', machine_id = ?, claimed_at = ?, updated_at = ? WHERE id = ?")
      .bind(machine.machineId, start + 3 * 3_600_000, start + 3 * 3_600_000 + 100_000, lostId).run();
    const snapshot = (await call("/v1/snapshot")).body;
    const blend = snapshot.jobs.find((job) => job.id === "blend");
    expect(blend.recentRuns).toHaveLength(5);
    expect(blend.durations.map((entry) => entry.id)).toEqual(runs);
    expect(blend.durations.map((entry) => entry.seconds)).toEqual([30, 31, 32, 33, 34, 35, 36]);
    expect(blend.durations[3].outcome).toBe("failed");
    expect(snapshot.lostRuns.map((run) => [run.id, run.phase, run.machineName])).toEqual([[lostId, "lost", "box"]]);
  });
});

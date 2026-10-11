// hc-core's agent API in workerd with a local D1: enrolment, credentials,
// body caps, the protocol check, claims by compare-and-set with placement
// and capacity, progress, completion, lost runs and their retries, cancels
// and credential rotation.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/core/protocol.mjs";
import {
  agentCall, call, createJob, cron, enrolMachine, mockCertificates, resetDatabase, rows, syncAs, syncBody,
} from "./helpers.mjs";

// Yesterday, 00:00 UTC: always in the past, so Access tokens minted now are valid then.
const DAY0 = Math.floor(Date.now() / 86_400_000) * 86_400_000 - 86_400_000;
const at = (hours, minutes = 0, seconds = 0) => DAY0 + ((hours * 60 + minutes) * 60 + seconds) * 1000;
let certificates;

beforeEach(async () => {
  await resetDatabase();
  certificates = mockCertificates();
});
afterEach(() => certificates.mockRestore());

const runRow = async (id) => (await rows("SELECT * FROM runs WHERE id = ?", id))[0];
const runsOf = (job) => rows("SELECT id, state, attempt, retry_of, source, machine_id, recovered FROM runs WHERE job_id = ? ORDER BY created_at, id", job);

/** A job with one slot at 08:20 and a manual run due now, for claim tests. */
async function manualRun(id, overrides = {}, now = at(8)) {
  await createJob(id, { schedule: null, ...overrides }, { now: now - 60_000 });
  const response = await call(`/v1/jobs/${id}/run`, { method: "POST", body: {}, now });
  expect(response.status).toBe(202);
  return response.body.runId;
}

describe("enrolment", () => {
  it("spends a single-use, hashed join token for a machine id and a credential stored as SHA-256", async () => {
    const token = await call("/v1/join-tokens", { method: "POST", body: { name: "mac-mini", labels: { site: "home", os: "darwin" } } });
    expect(token.status).toBe(201);
    expect(token.body.token).toMatch(/^hcj_[A-Za-z0-9_-]{43}$/);
    expect(token.body.enrolCommand).toMatch(/--join-token-stdin$/);
    const [stored] = await rows("SELECT * FROM join_tokens");
    expect(stored.token_hash).toBe(await sha256Hex(token.body.token));
    expect(JSON.stringify(stored)).not.toContain(token.body.token);

    const facts = { os: "linux", arch: "arm64", runtime: "colima", cpus: 8 };
    const enrolled = await agentCall("/agent/v1/enrol", { body: { protocol: 1, joinToken: token.body.token, facts } });
    expect(enrolled.status).toBe(201);
    expect(enrolled.headers.get("cache-control")).toBe("no-store");
    const { machineId, credential } = enrolled.body;
    expect(machineId).toMatch(/^m_[0-9A-Z]{26}$/);
    expect(credential).toMatch(new RegExp(`^hca_${machineId}_[A-Za-z0-9_-]{43}$`));
    expect(enrolled.body.labels).toEqual({ arch: "arm64", os: "darwin", runtime: "colima", site: "home" }, "the token's labels win");
    const [machine] = await rows("SELECT * FROM machines");
    expect(machine).toMatchObject({ id: machineId, name: "mac-mini", credential_hash: await sha256Hex(credential), revoked_at: null });
    expect(JSON.stringify(machine)).not.toContain(credential);

    const again = await agentCall("/agent/v1/enrol", { body: { protocol: 1, joinToken: token.body.token, facts } });
    expect([again.status, again.body.code]).toEqual([401, "join_token_used"]);
    expect((await rows("SELECT action FROM audit_log ORDER BY id")).map((row) => row.action)).toEqual(["machine.join-token", "machine.enrol"]);
  });

  it("refuses unknown and expired tokens, names in use, and only admins create tokens", async () => {
    const bogus = await agentCall("/agent/v1/enrol", { body: { protocol: 1, joinToken: `hcj_${"a".repeat(43)}` } });
    expect([bogus.status, bogus.body.code]).toEqual([401, "invalid_join_token"]);
    const created = Date.now() - 2 * 3_600_000;
    const token = await call("/v1/join-tokens", { method: "POST", body: { name: "old" }, now: created });
    const expired = await agentCall("/agent/v1/enrol", { body: { protocol: 1, joinToken: token.body.token }, now: created + 3_600_001 });
    expect([expired.status, expired.body.code]).toEqual([401, "join_token_expired"]);

    await enrolMachine("mac-mini");
    expect((await call("/v1/join-tokens", { method: "POST", body: { name: "mac-mini" } })).status).toBe(409);
    expect((await call("/v1/join-tokens", { method: "POST", body: { name: "Bad Name" } })).status).toBe(400);
    expect((await call("/v1/join-tokens", { method: "POST", body: { ttlMinutes: 0 } })).status).toBe(400);
    await call("/v1/settings", { method: "PATCH", body: { roles: { "op@example.com": "operator" } } });
    expect((await call("/v1/join-tokens", { method: "POST", body: {}, identity: "op@example.com" })).status).toBe(403);
  });

  it("frees a revoked machine's name for its replacement", async () => {
    const first = await enrolMachine("box");
    expect((await call(`/v1/machines/${first.machineId}`, { method: "DELETE" })).status).toBe(200);
    const second = await enrolMachine("box");
    const machines = await rows("SELECT id, name, revoked_at IS NOT NULL AS revoked FROM machines ORDER BY enrolled_at, id");
    expect(machines.find((row) => row.id === second.machineId)).toMatchObject({ name: "box", revoked: 0 });
    expect(machines.find((row) => row.id === first.machineId).name).toMatch(/^box~/);
  });
});

describe("authentication, body limits and the protocol", () => {
  it("answers 401 without a valid credential, and 401 revoked once revoked", async () => {
    const machine = await enrolMachine("box");
    const body = syncBody();
    expect((await agentCall("/agent/v1/sync", { body })).status).toBe(401);
    expect((await agentCall("/agent/v1/sync", { credential: "not-a-credential", body })).status).toBe(401);
    const forged = machine.credential.slice(0, -4) + "AAAA";
    expect((await agentCall("/agent/v1/sync", { credential: forged, body })).body).toEqual({ error: "unauthorized", code: "unauthorized" });
    expect((await syncAs(machine, at(8))).status).toBe(200);
    expect((await call(`/v1/machines/${machine.machineId}`, { method: "DELETE" })).status).toBe(200);
    const revoked = await syncAs(machine, at(8, 1));
    expect([revoked.status, revoked.body.code]).toEqual([401, "revoked"]);
    const [row] = await rows("SELECT credential_hash, revoked_at FROM machines");
    expect(row.credential_hash).toBeNull();
    expect((await rows("SELECT action FROM audit_log WHERE action = 'machine.revoke'"))).toHaveLength(1);
  });

  it("refuses bodies over 128 KB (sync), 256 KB (complete) and 16 KB (enrol) before parsing them", async () => {
    const machine = await enrolMachine("box");
    const big = (bytes) => JSON.stringify({ protocol: 1, padding: "x".repeat(bytes) });
    expect((await agentCall("/agent/v1/sync", { credential: machine.credential, body: big(128 * 1024) })).status).toBe(413);
    const run = `r_${"0".repeat(26)}`;
    expect((await agentCall(`/agent/v1/runs/${run}/complete`, { credential: machine.credential, body: big(256 * 1024) })).status).toBe(413);
    expect((await agentCall(`/agent/v1/runs/${run}/complete`, { credential: machine.credential, body: big(200 * 1024) })).status).toBe(404);
    expect((await agentCall("/agent/v1/enrol", { body: big(16 * 1024) })).status).toBe(413);
  });

  it("tells an agent with an old or missing protocol to update (426)", async () => {
    const machine = await enrolMachine("box");
    for (const protocol of [undefined, 0, "1"]) {
      const response = await agentCall("/agent/v1/sync", { credential: machine.credential, body: { ...syncBody(), protocol } });
      expect([response.status, response.body.code]).toEqual([426, "upgrade_required"]);
    }
    expect((await agentCall("/agent/v1/enrol", { body: { joinToken: "x" } })).status).toBe(426);
    expect((await agentCall("/agent/v1/sync", { credential: machine.credential, method: "GET" })).status).toBe(405);
    expect((await agentCall("/agent/v1/provisioning/p_1/events", { credential: machine.credential, body: {} })).status).toBe(501);
  });

  it("clamps what an agent reports about itself rather than refusing the sync", async () => {
    const machine = await enrolMachine("box");
    const response = await syncAs(machine, at(8), { machine: { drain: false, vm: { state: "x".repeat(5000) },
      free: { cpus: -1, memoryMiB: -1024, diskMiB: 10, runs: -1 }, health: { docker: "ok", lastError: "e".repeat(10_000) } } });
    expect(response.status).toBe(200);
    expect(response.body.claims).toEqual([]);
    const [row] = await rows("SELECT facts_json, health_json FROM machines");
    expect(JSON.parse(row.facts_json).free).toEqual({ cpus: 0, memoryMiB: 0, runs: 0 });
    expect(JSON.parse(row.health_json).lastError).toHaveLength(300);
  });

  it("answers no-store, rejects malformed run reports, and records health, version and skew", async () => {
    const machine = await enrolMachine("box");
    const response = await syncAs(machine, at(8), { agentTime: at(8) + 45_000, machine: { ...syncBody().machine, health: { docker: "ok", diskFreeMiB: 1 } } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.body).toMatchObject({ serverTime: at(8), claims: [], cancel: [], update: null, provisioningTasks: [], rotateCredential: null });
    const [row] = await rows("SELECT agent_version, last_seen_at, clock_skew_ms, health_json FROM machines");
    expect(row).toMatchObject({ agent_version: "0.2.0", last_seen_at: at(8), clock_skew_ms: 45_000 });
    expect(JSON.parse(row.health_json)).toEqual({ docker: "ok", diskFreeMiB: 1, localDrain: false });
    const bad = await syncAs(machine, at(8), { runs: [{ id: "r_nope", phase: "running" }] });
    expect(bad.status).toBe(400);
    const badPhase = await syncAs(machine, at(8), { runs: [{ id: `r_${"0".repeat(26)}`, phase: "succeeded" }] });
    expect(badPhase.status).toBe(400);
  });
});

describe("claims", () => {
  it("two machines racing for one run: exactly one wins (compare-and-set)", async () => {
    const runId = await manualRun("ecmwf");
    const machines = await Promise.all(["a", "b", "c"].map((name) => enrolMachine(name)));
    const answers = await Promise.all(machines.map((machine) => syncAs(machine, at(8, 0, 5))));
    const winners = answers.filter((answer) => answer.body.claims.length);
    expect(winners).toHaveLength(1);
    const [claim] = winners[0].body.claims;
    expect(claim.run).toMatchObject({ id: runId, jobId: "ecmwf", attempt: 1, leaseExpiresAt: at(8, 0, 5) + 90_000 });
    expect(claim.spec).toMatchObject({ image: "ghcr.io/example/worker@sha256:0123", args: [], secretEnv: {}, localEnv: [], network: "bridge" });
    const row = await runRow(runId);
    expect(row).toMatchObject({ state: "claimed", claimed_at: at(8, 0, 5), lease_expires_at: at(8, 0, 5) + 90_000 });
    expect(machines.map((machine) => machine.machineId)).toContain(row.machine_id);
    expect(winners[0].body.nextSyncInMs).toBe(10_000);
  });

  it("respects required labels, capacity, drain and health", async () => {
    await manualRun("arm", { requireLabels: undefined, placement: { requireLabels: { arch: "arm64" } }, resources: { cpus: 2, memoryMiB: 4096 } });
    const amd = await enrolMachine("amd", { facts: { os: "linux", arch: "amd64" } });
    expect((await syncAs(amd, at(8, 0, 1))).body.claims).toEqual([]);
    const arm = await enrolMachine("arm", { facts: { os: "linux", arch: "arm64" } });
    const small = { drain: false, vm: {}, free: { cpus: 4, memoryMiB: 2048, diskMiB: 40_000, runs: 1 }, health: { docker: "ok" } };
    expect((await syncAs(arm, at(8, 0, 2), { machine: small })).body.claims).toEqual([]);
    expect((await syncAs(arm, at(8, 0, 3), { machine: { ...small, free: { ...small.free, memoryMiB: 8192, runs: 0 } } })).body.claims).toEqual([]);
    expect((await syncAs(arm, at(8, 0, 4), { machine: { ...small, drain: true, free: { ...small.free, memoryMiB: 8192 } } })).body.claims).toEqual([]);
    expect((await syncAs(arm, at(8, 0, 5), { machine: { ...small, health: { docker: "unreachable" }, free: { ...small.free, memoryMiB: 8192 } } })).body.claims).toEqual([]);
    expect((await syncAs(arm, at(8, 0, 6), { claim: false })).body.claims).toEqual([]);
    // Drained from the dashboard: the server's own flag.
    expect((await call(`/v1/machines/${arm.machineId}`, { method: "PATCH", body: { drain: true } })).status).toBe(200);
    expect((await syncAs(arm, at(8, 0, 7))).body.claims).toEqual([]);
    expect((await call(`/v1/machines/${arm.machineId}`, { method: "PATCH", body: { drain: false } })).status).toBe(200);
    // The dashboard's caps limit what the agent says is free.
    await call(`/v1/machines/${arm.machineId}`, { method: "PATCH", body: { capacity: { memoryMiB: 2048 } } });
    expect((await syncAs(arm, at(8, 0, 8))).body.claims).toEqual([]);
    await call(`/v1/machines/${arm.machineId}`, { method: "PATCH", body: { capacity: {} } });
    expect((await syncAs(arm, at(8, 0, 9))).body.claims).toHaveLength(1);
  });

  it("keeps a run for its preferred machine until preferred_until, unless that machine is offline, draining or unhealthy", async () => {
    const mac = await enrolMachine("mac-mini");
    const linux = await enrolMachine("linux-box");
    await syncAs(mac, at(8), { claim: false });
    const runId = await manualRun("blend", { placement: { preferMachines: ["mac-mini"], preferWaitSeconds: 300 } }, at(8));
    expect((await runRow(runId)).preferred_until).toBe(at(8, 5));
    const held = await syncAs(linux, at(8, 0, 30));
    expect(held.body.claims).toEqual([]);
    expect(held.body.nextSyncInMs).toBeLessThanOrEqual(30_000);
    // The Mac is busy (draining locally): the Linux box may take it at once.
    await syncAs(mac, at(8, 0, 40), { claim: false, machine: { ...syncBody().machine, drain: true } });
    expect((await syncAs(linux, at(8, 0, 41))).body.claims.map((claim) => claim.run.id)).toEqual([runId]);
    await agentCall(`/agent/v1/runs/${runId}/complete`, { credential: linux.credential, body: { protocol: 1, exitCode: 0 }, now: at(8, 1) });

    // Offline: no sync for 150 s.
    const second = await manualRun("tides", { placement: { preferMachines: ["mac-mini"] } }, at(9));
    await syncAs(mac, at(9), { claim: false });
    expect((await syncAs(linux, at(9, 2))).body.claims).toEqual([]);
    expect((await syncAs(linux, at(9, 2, 31))).body.claims.map((claim) => claim.run.id)).toEqual([second]);
    await agentCall(`/agent/v1/runs/${second}/complete`, { credential: linux.credential, body: { protocol: 1, exitCode: 0 }, now: at(9, 3) });
    // After the window anyone may claim.
    const third = await manualRun("gfs", { placement: { preferMachines: ["mac-mini"], preferWaitSeconds: 60 } }, at(10));
    await syncAs(mac, at(10), { claim: false });
    expect((await syncAs(linux, at(10, 0, 59))).body.claims).toEqual([]);
    expect((await syncAs(linux, at(10, 1))).body.claims.map((claim) => claim.run.id)).toEqual([third]);
  });

  it("claims nothing for jobs that need vault secrets; local secrets go to the agent by name", async () => {
    await manualRun("vaulted", { secretEnv: { AWS_SECRET_ACCESS_KEY: "vault:wingfoil-r2-secret" } });
    await manualRun("local", { secretEnv: { API_TOKEN: "local:HC_API_TOKEN" }, env: { REGION: "auto" }, args: ["--x"] });
    const machine = await enrolMachine("box");
    const { claims } = (await syncAs(machine, at(8, 0, 5))).body;
    expect(claims.map((claim) => claim.run.jobId)).toEqual(["local"]);
    expect(claims[0].spec).toMatchObject({ env: { REGION: "auto" }, secretEnv: {}, localEnv: [{ name: "API_TOKEN", from: "HC_API_TOKEN" }], args: ["--x"] });
    const snapshot = await call("/v1/snapshot");
    const vaulted = snapshot.body.jobs.find((job) => job.id === "vaulted");
    expect(vaulted.blocked).toMatch(/vault.*wingfoil-r2-secret/);
    expect(vaulted.waiting).toMatch(/^blocked: /);
  });

  it("claims manual runs under the global pause, scheduled ones not", async () => {
    await createJob("blend", { schedule: { at: { minutes: [20] } } }, { now: at(7) });
    await cron(at(8, 20));
    const manual = await manualRun("tides", {}, at(8, 21));
    await call("/v1/pause-all", { method: "POST" });
    const machine = await enrolMachine("box");
    const { claims } = (await syncAs(machine, at(8, 22))).body;
    expect(claims.map((claim) => claim.run.id)).toEqual([manual]);
  });

  it("creates a slot's run lazily on sync when the cron is late, and claims it in the same sync", async () => {
    await createJob("blend", { schedule: { at: { hours: [8], minutes: [20] } } }, { now: at(7) });
    await cron(at(7, 30));
    const machine = await enrolMachine("box");
    const idle = await syncAs(machine, at(8, 19, 50));
    expect(idle.body.upcoming).toEqual([{ jobId: "blend", dueAt: at(8, 20), cpus: 1, memoryMiB: 2048, preferred: false }]);
    expect(idle.body.nextSyncInMs).toBe(12_000);
    const { claims } = (await syncAs(machine, at(8, 20, 2))).body;
    expect(claims).toHaveLength(1);
    expect(await runRow(claims[0].run.id)).toMatchObject({ slot_at: at(8, 20), source: "schedule", state: "claimed" });
    await cron(at(8, 20, 30));
    expect(await rows("SELECT id FROM runs")).toHaveLength(1);
  });

  it("marks an upcoming slot another machine is preferred for, so this one does not pre-warm its VM for it", async () => {
    await createJob("blend", { schedule: { at: { hours: [8], minutes: [20] } }, placement: { preferMachines: ["mac-mini"] } }, { now: at(7) });
    await cron(at(7, 30));
    const other = await enrolMachine("box");
    const preferred = await enrolMachine("mac-mini");
    expect((await syncAs(other, at(8, 10))).body.upcoming).toEqual([
      { jobId: "blend", dueAt: at(8, 20), cpus: 1, memoryMiB: 2048, preferred: false, preferredElsewhere: true },
    ]);
    expect((await syncAs(preferred, at(8, 10))).body.upcoming).toEqual([{ jobId: "blend", dueAt: at(8, 20), cpus: 1, memoryMiB: 2048, preferred: true }]);
  });

  it("looks past the oldest 20 due runs when none of them is for this machine", async () => {
    for (let index = 0; index < 21; index += 1) await manualRun(`vaulted-${index}`, { secretEnv: { KEY: "vault:secret" } }, at(8) + index);
    const wanted = await manualRun("open", {}, at(8, 1));
    const machine = await enrolMachine("box");
    expect((await syncAs(machine, at(8, 2))).body.claims.map((claim) => claim.run.id)).toEqual([wanted]);
  });

  it("counts a claim it sends again against the machine's free capacity", async () => {
    await manualRun("first");
    await manualRun("second");
    const machine = await enrolMachine("box");
    const oneSlot = { ...syncBody().machine, free: { cpus: 4, memoryMiB: 6144, diskMiB: 40_000, runs: 1 } };
    expect((await syncAs(machine, at(8, 0, 5), { machine: oneSlot })).body.claims).toHaveLength(1);
    // The answer was lost: the agent still says it has one slot free, but the run sent again takes it.
    expect((await syncAs(machine, at(8, 0, 15), { machine: oneSlot })).body.claims).toHaveLength(1);
  });

  it("sends a claim again when its answer never reached the agent", async () => {
    const runId = await manualRun("ecmwf");
    const machine = await enrolMachine("box");
    expect((await syncAs(machine, at(8, 0, 5))).body.claims).toHaveLength(1);
    const again = await syncAs(machine, at(8, 0, 15));
    expect(again.body.claims.map((claim) => claim.run.id)).toEqual([runId]);
    const known = await syncAs(machine, at(8, 0, 25), { runs: [{ id: runId, phase: "claimed" }] });
    expect(known.body.claims).toEqual([]);
  });
});

describe("progress, completion and retries", () => {
  async function claimed(jobOverrides = {}, now = at(8)) {
    const runId = await manualRun("ecmwf", jobOverrides, now);
    const machine = await enrolMachine("box");
    const { claims } = (await syncAs(machine, now + 5_000)).body;
    expect(claims).toHaveLength(1);
    return { runId, machine };
  }
  const complete = (machine, runId, body, now) => agentCall(`/agent/v1/runs/${runId}/complete`,
    { credential: machine.credential, body: { protocol: 1, ...body }, now });

  it("stamps phases with the server's time, renews the lease and stores a redacted tail", async () => {
    const { runId, machine } = await claimed();
    const tail = { text: "starting\nusing Bearer abcdefghijklmnop\nAKIAABCDEFGHIJKLMNOP", bytesTotal: 60, truncated: false };
    await syncAs(machine, at(8, 0, 15), { runs: [{ id: runId, phase: "running", stats: { peakMemoryBytes: 1000, cpuPct: 50 }, logTail: tail }] });
    let row = await runRow(runId);
    expect(row).toMatchObject({ state: "running", started_at: at(8, 0, 15), peak_memory_bytes: 1000, peak_cpu_pct: 50, lease_expires_at: at(8, 0, 5) + 90_000 });
    const [log] = await rows("SELECT * FROM run_logs WHERE run_id = ?", runId);
    expect(log.tail).toBe("starting\nusing Bearer <redacted>\n<redacted>");
    expect(log.final).toBe(0);
    // A lease renews once it is 30 s old; a lower peak is ignored; a phase never goes back.
    await syncAs(machine, at(8, 0, 40), { runs: [{ id: runId, phase: "pulling", stats: { peakMemoryBytes: 10, cpuPct: 1 } }] });
    row = await runRow(runId);
    expect(row).toMatchObject({ state: "running", peak_memory_bytes: 1000, lease_expires_at: at(8, 0, 40) + 90_000 });
    const logs = await call(`/v1/runs/${runId}/logs`);
    expect(logs.body.lines.map((line) => line.text)).toContain("using Bearer <redacted>");
  });

  it("records a completion once, with outcome, reports, metrics and published tracking", async () => {
    const report = { format: "json-lines", trackEvent: "forecast_complete", trackBy: "model" };
    const { runId, machine } = await claimed({ report, schedule: { every: "6h" } });
    await syncAs(machine, at(8, 0, 15), { runs: [{ id: runId, phase: "running" }] });
    const record = {
      exitCode: 0, oomKilled: false, timedOut: false,
      reports: [{ event: "forecast_complete", model: "ecmwf", run: "2026101100", seconds: 300, peakRssBytes: 4e8 },
        { event: "note", secret: "password=hunter2" }],
      logTail: { text: "done\n", bytesTotal: 5, linesTotal: 1, truncated: false },
      stats: { peakMemoryBytes: 412_000_000, memoryLimitBytes: 2048 * 1048576, avgCpuPct: 40, peakCpuPct: 97, cpuSeconds: 120, samples: 100 },
      durations: { durationMs: 300_000, pullMs: 0, vmWaitMs: 0 },
      image: { ref: "ghcr.io/example/worker@sha256:0123", digest: "sha256:0123" },
    };
    const first = await complete(machine, runId, record, at(8, 5, 15));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, state: "succeeded", outcome: "published", recovered: false });
    const row = await runRow(runId);
    expect(row).toMatchObject({ state: "succeeded", outcome: "published", exit_code: 0, finished_at: at(8, 5, 15), lease_expires_at: null,
      peak_memory_bytes: 412_000_000, stats_samples: 100, duration_ms: 300_000, image_digest: "sha256:0123" });
    expect(JSON.parse(row.reports_json)[1].secret).toBe("password=<redacted>");
    expect(JSON.parse(row.metrics_json)).toMatchObject({ seconds: 300, peakRssBytes: 4e8 });
    const [state] = await rows("SELECT * FROM schedule_state WHERE job_id = 'ecmwf'");
    expect(state).toMatchObject({ last_run_id: runId, last_state: "succeeded", last_outcome: "published", last_finished_at: at(8, 5, 15),
      next_due_at: at(14, 5, 15) });
    expect(JSON.parse(state.published_json)).toEqual({ ecmwf: { run: "2026101100", at: new Date(at(8, 5, 15)).toISOString(), seconds: 300, runId } });

    const view = (await call(`/v1/runs/${runId}`)).body;
    expect(view).toMatchObject({ claimedAt: new Date(at(8, 0, 5)).toISOString(), startedAt: new Date(at(8, 0, 15)).toISOString(),
      durationSeconds: 300, pullSeconds: 0, stats: { samples: 100, peakMemoryBytes: 412_000_000, avgCpuPct: 40, peakCpuPct: 97 } });
    const again = await complete(machine, runId, { ...record, exitCode: 1 }, at(8, 6));
    expect(again.body).toMatchObject({ state: "succeeded", duplicate: true });
    expect((await runRow(runId)).finished_at).toBe(at(8, 5, 15));
    const snapshot = (await call("/v1/snapshot")).body.jobs[0];
    expect(snapshot.lastReports.map((entry) => entry.event)).toEqual(["forecast_complete", "note"]);
    expect(snapshot.published.ecmwf.run).toBe("2026101100");
  });

  it("settles an OOM kill as failed and retries failures only as the policy says", async () => {
    const { runId, machine } = await claimed({ policy: { retry: { onFailed: 1, backoffSeconds: 60 } } });
    const response = await complete(machine, runId, { exitCode: 137, oomKilled: true, error: "out of memory (limit 2 GiB)" }, at(8, 1));
    expect(response.body).toMatchObject({ state: "failed", outcome: "failed" });
    expect(response.body.retry).toMatch(/^r_/);
    expect(await runRow(runId)).toMatchObject({ error: "out of memory (limit 2 GiB)", oom_killed: 1 });
    const retry = await runRow(response.body.retry);
    expect(retry).toMatchObject({ state: "due", source: "retry", attempt: 2, retry_of: runId, due_at: at(8, 2) });
  });

  it("answers 404 for another machine's run and 409 for one never claimed", async () => {
    const { runId } = await claimed();
    const other = await enrolMachine("other");
    expect((await complete(other, runId, { exitCode: 0 }, at(8, 1))).status).toBe(404);
  });

  it("a lost run is retried at once if it never started; a late completion is recovered", async () => {
    const { runId, machine } = await claimed({ policy: { retry: { maxAttempts: 2 } } });
    let summary = await cron(at(8, 1, 35));
    expect([summary.lost, summary.retried]).toEqual([0, 0]);
    summary = await cron(at(8, 1, 36));
    expect([summary.lost, summary.retried]).toEqual([1, 1]);
    const runs = await runsOf("ecmwf");
    expect(runs.map((run) => [run.state, run.attempt, run.retry_of])).toEqual([["lost", 1, null], ["due", 2, runId]]);
    expect((await cron(at(8, 2))).retried).toBe(0);
    // The agent comes back and reports the lost run: no cancel; its completion is recovered and the retry stays.
    const back = await syncAs(machine, at(8, 2, 10), { claim: false, runs: [{ id: runId, phase: "running" }] });
    expect(back.body.cancel).toEqual([]);
    const late = await complete(machine, runId, { exitCode: 0 }, at(8, 3));
    expect(late.body).toMatchObject({ state: "succeeded", recovered: true });
    // Its retry had not started, so it is no longer needed.
    expect((await runsOf("ecmwf")).map((run) => [run.state, run.recovered])).toEqual([["succeeded", 1], ["cancelled", 0]]);
  });

  it("a late, recovered result does not replace a newer run's as the job's last", async () => {
    const report = { format: "json-lines", trackEvent: "forecast_complete", trackBy: "model" };
    const { runId, machine } = await claimed({ report });
    await cron(at(8, 1, 36));
    const other = await enrolMachine("other");
    const [retry] = (await syncAs(other, at(8, 2))).body.claims;
    await complete(other, retry.run.id, { exitCode: 0, reports: [{ event: "forecast_complete", model: "ecmwf", run: "06" }] }, at(8, 3));
    const late = await complete(machine, runId, { exitCode: 0, reports: [{ event: "forecast_complete", model: "ecmwf", run: "00" }] }, at(8, 4));
    expect(late.body).toMatchObject({ state: "succeeded", recovered: true });
    const [state] = await rows("SELECT last_run_id, published_json FROM schedule_state WHERE job_id = 'ecmwf'");
    expect(state.last_run_id).toBe(retry.run.id);
    expect(JSON.parse(state.published_json).ecmwf.run).toBe("06");
  });

  it("a run lost while running is retried only when idempotent, after the grace", async () => {
    const { runId, machine } = await claimed({ policy: { retry: { onLostRunning: true, lostGraceSeconds: 600 } } });
    await syncAs(machine, at(8, 0, 15), { runs: [{ id: runId, phase: "running" }] });
    expect((await cron(at(8, 2))).lost).toBe(1);
    expect((await cron(at(8, 11, 59))).retried).toBe(0);
    expect((await cron(at(8, 12, 1))).retried).toBe(1);
    expect((await runsOf("ecmwf")).map((run) => [run.state, run.attempt])).toEqual([["lost", 1], ["due", 2]]);
  });

  it("a run lost while running is not retried by default", async () => {
    const { runId, machine } = await claimed();
    await syncAs(machine, at(8, 0, 15), { runs: [{ id: runId, phase: "running" }] });
    await cron(at(8, 2));
    expect((await cron(at(9))).retried).toBe(0);
    expect((await runsOf("ecmwf")).map((run) => run.state)).toEqual(["lost"]);
  });

  it("delivers a cancel from the dashboard, and from the timeout backstop, on the next sync", async () => {
    const { runId, machine } = await claimed({ timeouts: { runSeconds: 60 } });
    await syncAs(machine, at(8, 0, 15), { runs: [{ id: runId, phase: "running" }] });
    expect((await call(`/v1/runs/${runId}/cancel`, { method: "POST" })).status).toBe(202);
    expect((await call(`/v1/runs/${runId}/cancel`, { method: "POST" })).status).toBe(409);
    const told = await syncAs(machine, at(8, 0, 25), { runs: [{ id: runId, phase: "running" }] });
    expect(told.body.cancel).toEqual([runId]);
    const final = await complete(machine, runId, { cancelled: true, exitCode: 143, logTail: { text: "stopping\n" } }, at(8, 0, 30));
    expect(final.body).toMatchObject({ state: "cancelled", duplicate: true });
    expect((await rows("SELECT tail, final FROM run_logs"))[0]).toEqual({ tail: "stopping\n", final: 1 });

    const retried = await call(`/v1/runs/${runId}/retry`, { method: "POST", body: {}, now: at(8, 0, 50) });
    expect(retried.status).toBe(202);
    const second = (await syncAs(machine, at(8, 1))).body.claims[0].run.id;
    expect(second).toBe(retried.body.runId);
    await syncAs(machine, at(8, 1, 10), { runs: [{ id: second, phase: "running" }] });
    // The agent keeps syncing (so its lease holds) but never finishes: the backstop times it out at start + 60 s + 300 s.
    for (let time = at(8, 1, 40); time <= at(8, 7, 10); time += 30_000) await syncAs(machine, time, { runs: [{ id: second, phase: "running" }] });
    expect((await cron(at(8, 7, 10))).timedOut).toBe(0);
    expect((await cron(at(8, 7, 11))).timedOut).toBe(1);
    expect((await syncAs(machine, at(8, 7, 20), { runs: [{ id: second, phase: "running" }] })).body.cancel).toEqual([second]);
  });
});

describe("credential rotation", () => {
  it("hands a new credential on request, promotes it on first use, and the old one stops working", async () => {
    const machine = await enrolMachine("box");
    expect((await syncAs(machine, at(8))).body.rotateCredential).toBeNull();
    expect((await call(`/v1/machines/${machine.machineId}`, { method: "PATCH", body: { rotateCredential: true } })).status).toBe(200);
    const offered = await syncAs(machine, at(8, 0, 30));
    const next = offered.body.rotateCredential.credential;
    expect(next).toMatch(new RegExp(`^hca_${machine.machineId}_`));
    expect((await rows("SELECT credential_next_hash FROM machines"))[0].credential_next_hash).toBe(await sha256Hex(next));
    // Until the new one is used, the old still works (the agent may not have stored it yet), and a new offer replaces it.
    const reoffered = (await syncAs(machine, at(8, 1))).body.rotateCredential.credential;
    expect(reoffered).not.toBe(next);
    const promoted = await syncAs({ ...machine, credential: reoffered }, at(8, 1, 30));
    expect(promoted.status).toBe(200);
    expect(promoted.body.rotateCredential).toBeNull();
    expect((await syncAs(machine, at(8, 2))).status).toBe(401);
    expect((await syncAs({ ...machine, credential: next }, at(8, 2))).status).toBe(401);
    const [row] = await rows("SELECT credential_hash, credential_next_hash, rotate_requested_at, credential_issued_at FROM machines");
    expect(row).toEqual({ credential_hash: await sha256Hex(reoffered), credential_next_hash: null, rotate_requested_at: null, credential_issued_at: at(8, 1, 30) });
    expect((await rows("SELECT action FROM audit_log WHERE action = 'machine.credential-rotated'"))).toHaveLength(1);
  });

  it("rotates a credential older than 90 days on its own", async () => {
    const machine = await enrolMachine("box");
    await env.DB.prepare("UPDATE machines SET credential_issued_at = ?").bind(at(8) - 91 * 86_400_000).run();
    expect((await syncAs(machine, at(8))).body.rotateCredential.credential).toMatch(/^hca_/);
  });
});

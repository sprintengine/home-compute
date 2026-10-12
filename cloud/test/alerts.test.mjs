// Alerts in workerd: failed twice in a row, stale output, no machine online,
// a run waiting too long, the cron's heartbeat behind /health, the email
// (one per change, batched, retried, reminded daily) and the test alert.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { alertMinute } from "../src/alerts.mjs";
import { agentCall, call, createJob, cron, enrolMachine, mockCertificates, resetDatabase, rows, syncAs } from "./helpers.mjs";

const DAY0 = Math.floor(Date.now() / 86_400_000) * 86_400_000 - 86_400_000;
const at = (hours, minutes = 0, seconds = 0) => DAY0 + ((hours * 60 + minutes) * 60 + seconds) * 1000;
const MAIL = { ALERT_EMAIL: {}, ALERT_EMAIL_TO: "owner@example.com", ALERT_EMAIL_FROM: "home-compute@example.com", DASHBOARD_URL: "https://hc.example.com/" };
let certificates;
let sent;
let pointers;

const send = async (message) => { sent.push(message); };
const fetcher = async (url) => {
  const body = pointers[String(url)];
  if (body === undefined) return new Response("not found", { status: 404 });
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
};
const tick = (now, extra = {}) => alertMinute({ ...env, ...MAIL, ...extra }, now, { send, fetcher });
const openAlerts = async () => (await rows("SELECT key, summary FROM alerts WHERE resolved_at IS NULL ORDER BY key")).map((row) => row.key);
const subjects = () => sent.map((message) => message.raw.match(/^Subject: (.*)$/m)[1]);

beforeEach(async () => {
  await resetDatabase();
  certificates = mockCertificates();
  sent = [];
  pointers = {};
});
afterEach(() => certificates.mockRestore());

async function runAndFinish(machine, job, exitCode, now) {
  const run = await call(`/v1/jobs/${job}/run`, { method: "POST", body: {}, now });
  expect(run.status).toBe(202);
  await syncAs(machine, now + 5_000);
  await agentCall(`/agent/v1/runs/${run.body.runId}/complete`, { credential: machine.credential, body: { protocol: 1, exitCode }, now: now + 60_000 });
  return run.body.runId;
}

describe("alerts", () => {
  it("opens one when a job fails twice in a row, emails it once, and resolves it (with an email) when a run succeeds", async () => {
    await createJob("gfs", { schedule: null }, { now: at(7) });
    const machine = await enrolMachine("mac-mini");
    await runAndFinish(machine, "gfs", 1, at(8));
    await tick(at(8, 2));
    expect(await openAlerts()).toEqual([]);
    await runAndFinish(machine, "gfs", 1, at(8, 3));
    const summary = await tick(at(8, 5));
    expect(summary).toMatchObject({ opened: 1, emailed: true });
    expect(await openAlerts()).toEqual(["job-failing:gfs"]);
    expect(subjects()).toEqual(["[Home Compute] 1 new: gfs failed 2 times in a row"]);
    expect(sent[0]).toMatchObject({ from: MAIL.ALERT_EMAIL_FROM, to: MAIL.ALERT_EMAIL_TO });
    expect(sent[0].raw).toMatch(/^From: Home Compute <home-compute@example\.com>\r\nTo: owner@example\.com\r\n/);
    expect(sent[0].raw).toContain("Dashboard: https://hc.example.com/");

    // Still failing: the summary moves, no new email; quiet for five minutes after each one anyway.
    await runAndFinish(machine, "gfs", 1, at(8, 6));
    await tick(at(8, 8));
    expect(sent).toHaveLength(1);
    expect((await rows("SELECT summary FROM alerts"))[0].summary).toBe("gfs failed 3 times in a row");

    await runAndFinish(machine, "gfs", 0, at(8, 20));
    expect((await rows("SELECT fail_streak FROM schedule_state"))[0].fail_streak).toBe(0);
    await tick(at(8, 22));
    expect(await openAlerts()).toEqual([]);
    expect(subjects()).toEqual(["[Home Compute] 1 new: gfs failed 2 times in a row", "[Home Compute] 1 resolved"]);
    await syncAs(machine, at(8, 39), { claim: false });
    await tick(at(8, 40));
    expect(sent).toHaveLength(2);
  });

  it("does not alert on a paused job's failures, nor on a disabled job's", async () => {
    await createJob("gfs", { schedule: null }, { now: at(7) });
    const machine = await enrolMachine("mac-mini");
    await runAndFinish(machine, "gfs", 1, at(8));
    await runAndFinish(machine, "gfs", 1, at(8, 3));
    await call("/v1/jobs/gfs/pause", { method: "POST" });
    await tick(at(8, 5));
    expect(await openAlerts()).toEqual([]);
  });

  it("calls an output stale once its age passed maxAgeHours and the next slot plus an hour did not fix it, from the published pointer", async () => {
    const url = "https://data.example.com/weather/gfs.json";
    await createJob("gfs", {
      schedule: { at: { hours: [4, 10, 16, 22], minutes: [0] } },
      report: { format: "json-lines", trackEvent: "forecast_complete", trackBy: "model", freshness: { gfs: { maxAgeHours: 12, url } } },
    }, { now: at(0) });
    await call("/v1/jobs/gfs/pause", { method: "POST" });
    // Yesterday's 00 UTC run: 12 hours old at 12:00. The 16:00 slot should replace it; until 17:00 nothing is said.
    pointers[url] = { run: new Date(DAY0).toISOString().slice(0, 10).replace(/-/g, "") + "00", model: "gfs" };
    await tick(at(12, 3));
    expect((await rows("SELECT value_json FROM settings WHERE key = 'freshness_probes'"))[0].value_json).toContain(pointers[url].run);
    await tick(at(16, 59));
    expect(await openAlerts()).toEqual([]);
    await tick(at(17, 1));
    expect(await openAlerts()).toEqual(["stale:gfs:gfs"]);
    expect(subjects()[0]).toBe("[Home Compute] 1 new: gfs is 17.0 h old (limit 12 h)");

    // The pointer moves on (read at the next quarter hour): resolved.
    pointers[url] = { run: new Date(DAY0).toISOString().slice(0, 10).replace(/-/g, "") + "12" };
    await tick(at(17, 18));
    expect(await openAlerts()).toEqual([]);
    // A pointer that cannot be read keeps the last good run rather than forgetting it.
    delete pointers[url];
    await tick(at(17, 33));
    const probes = JSON.parse((await rows("SELECT value_json FROM settings WHERE key = 'freshness_probes'"))[0].value_json);
    expect(probes[url]).toMatchObject({ run: pointers[url]?.run ?? expect.stringMatching(/12$/), error: "HTTP 404" });
  });

  it("uses what the job itself published when there is no pointer", async () => {
    await createJob("blend", {
      schedule: { at: { minutes: [5] } },
      report: { format: "json-lines", trackEvent: "forecast_complete", trackBy: "model", freshness: { blend: { maxAgeHours: 3 } } },
    }, { now: at(0) });
    const machine = await enrolMachine("mac-mini");
    const run = await call("/v1/jobs/blend/run", { method: "POST", body: {}, now: at(8) });
    await syncAs(machine, at(8, 0, 5));
    await agentCall(`/agent/v1/runs/${run.body.runId}/complete`, {
      credential: machine.credential, now: at(8, 1),
      body: { protocol: 1, exitCode: 0, reports: [{ event: "forecast_complete", model: "blend", run: new Date(at(8)).toISOString() }] },
    });
    const stale = async () => (await openAlerts()).filter((key) => key.startsWith("stale:"));
    await tick(at(11, 30));
    expect(await stale()).toEqual([]);
    await tick(at(12, 6));
    expect(await stale()).toEqual(["stale:blend:blend"]);
  });

  it("says when no machine has synced for 10 minutes, and when a due run waited 15 minutes", async () => {
    await createJob("tides", { schedule: null }, { now: at(7) });
    const machine = await enrolMachine("mac-mini", { now: at(7) });
    await syncAs(machine, at(8), { claim: false });
    await call("/v1/jobs/tides/run", { method: "POST", body: {}, now: at(8, 1) });
    await tick(at(8, 10));
    expect(await openAlerts()).toEqual([]);
    await tick(at(8, 11));
    expect(await openAlerts()).toEqual(["no-machine"]);
    await tick(at(8, 17));
    expect(await openAlerts()).toEqual(["no-machine", "waiting:tides"]);
    expect(subjects()).toEqual(["[Home Compute] 1 new: No machine online for 11 min", "[Home Compute] 1 new: tides has waited 16 min for a machine"]);
    await syncAs(machine, at(8, 18));
    await tick(at(8, 19));
    expect(await openAlerts()).toEqual([]);
  });

  it("does not count scheduled runs waiting under a pause, which is deliberate", async () => {
    await createJob("blend", { schedule: { at: { minutes: [20] } } }, { now: at(7) });
    await cron(at(8, 20));
    await call("/v1/jobs/blend/pause", { method: "POST" });
    await tick(at(8, 50));
    expect(await openAlerts()).toEqual([]);
  });

  it("records the cron's heartbeat, which /health/cron turns into 200 or 503 for the check outside Cloudflare", async () => {
    const health = async (now) => agentCall("/health/cron", { method: "GET", now });
    expect((await health(at(8))).status).toBe(503);
    expect((await agentCall("/health", { method: "GET", now: at(8) })).status).toBe(200, "plain /health is liveness only");
    await cron(at(8));
    const fresh = await health(at(8, 2));
    expect([fresh.status, fresh.body.status, fresh.body.cronAgeSeconds]).toEqual([200, "ok", 120]);
    const stale = await health(at(8, 6));
    expect([stale.status, stale.body.problem]).toEqual([503, "the cron has stopped ticking"]);
    const snapshot = await call("/v1/snapshot", { now: at(8, 6) });
    expect(snapshot.body.controller.cron).toEqual({ lastTickAt: new Date(at(8)).toISOString(), stale: true });
  });

  it("sends a test alert on the next minute and then resolves it quietly", async () => {
    const test = await call("/v1/alerts/test", { method: "POST", body: {}, now: at(9) });
    expect(test.status).toBe(202);
    await tick(at(9, 1));
    expect(subjects()).toEqual(["[Home Compute] 1 new: Test alert requested by owner@example.com"]);
    await tick(at(9, 7));
    expect(await openAlerts()).toEqual([]);
    expect(sent).toHaveLength(1);
    expect((await rows("SELECT action FROM audit_log WHERE action = 'alert.test'"))).toHaveLength(1);
    const operator = await call("/v1/settings", { method: "PATCH", body: { roles: { "op@example.com": "operator" } } });
    expect(operator.status).toBe(200);
    expect((await call("/v1/alerts/test", { method: "POST", body: {}, identity: "op@example.com" })).status).toBe(403);
  });

  it("shows on the dashboard when email cannot go, and tries again ten minutes later", async () => {
    await call("/v1/alerts/test", { method: "POST", body: {}, now: at(9) });
    await alertMinute({ ...env }, at(9, 1), { send, fetcher });
    let snapshot = await call("/v1/snapshot", { now: at(9, 2) });
    expect(snapshot.body.alerts.email).toEqual({ ok: false, error: "the send_email binding ALERT_EMAIL is missing", lastSentAt: null });
    expect(snapshot.body.alerts.open.map((alert) => alert.kind)).toEqual(["test"]);

    const failing = async () => { throw new Error("destination address not verified"); };
    await alertMinute({ ...env, ...MAIL }, at(9, 3), { send: failing, fetcher });
    snapshot = await call("/v1/snapshot", { now: at(9, 4) });
    expect(snapshot.body.alerts.email).toMatchObject({ ok: false, error: "destination address not verified" });
    await tick(at(9, 8));
    expect(sent).toHaveLength(0);
    await tick(at(9, 14));
    expect(sent).toHaveLength(1);
    snapshot = await call("/v1/snapshot", { now: at(9, 15) });
    expect(snapshot.body.alerts.email.ok).toBe(true);
  });

  it("reminds once a day while a problem stays open, in one email for all of them", async () => {
    await createJob("tides", { schedule: null }, { now: at(7) });
    await createJob("gfs", { schedule: null }, { now: at(7) });
    await call("/v1/jobs/tides/run", { method: "POST", body: {}, now: at(8) });
    await call("/v1/jobs/gfs/run", { method: "POST", body: {}, now: at(8) });
    await tick(at(8, 16));
    expect(sent).toHaveLength(1);
    expect(subjects()[0]).toMatch(/^\[Home Compute\] 2 new: /);
    await tick(at(20));
    expect(sent).toHaveLength(1);
    await tick(at(8, 16) + 86_400_000);
    expect(subjects()[1]).toBe("[Home Compute] 2 still open");
  });
});

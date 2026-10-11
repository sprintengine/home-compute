import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApiServer } from "../src/api.mjs";
import { loadConfig } from "../src/config.mjs";
import { HomeComputeService } from "../src/service.mjs";

const FAKE_TIMETABLE = path.resolve(import.meta.dirname, "fixtures/fake-timetable.mjs");
const TOKEN = "test-token-0123456789";
const OWNER = "owner@example.com";
const TAILNET = "mac.example-tailnet.ts.net:8443";
const quiet = { log() {}, error() {} };

/** A raw HTTP request, so Host and the proxy's headers can be set as `tailscale serve` would. */
function send(port, { method = "GET", path: target = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, method, path: target, headers: { host: `127.0.0.1:${port}`, ...headers } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    request.on("error", reject);
    if (body !== undefined) request.end(typeof body === "string" ? body : JSON.stringify(body));
    else request.end();
  });
}

const viaTailscale = (login, extra = {}) => ({
  host: TAILNET,
  "tailscale-user-login": login,
  "tailscale-user-name": "Owner",
  "x-forwarded-for": "100.101.102.103",
  "x-forwarded-proto": "https",
  ...extra,
});

async function fixture(context, { token = TOKEN, timetable = true, logText } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "home-compute-dashboard-"));
  const configFile = path.join(directory, "home-compute.json");
  await writeFile(configFile, JSON.stringify({
    jobs: [
      { id: "harmonie", schedule: { at: { hours: [6, 12], minutes: [0] }, timezone: "UTC" },
        task: { image: "x", requiredEnv: ["AWS_SECRET_ACCESS_KEY"], report: { format: "json-lines", trackEvent: "forecast_complete", trackBy: "model" } } },
      { id: "prune", schedule: { every: "1h" }, task: { image: "x" } },
    ],
    ...(timetable ? { timetable: { command: [FAKE_TIMETABLE, configFile] } } : {}),
  }, null, 2));
  const config = await loadConfig(configFile);
  const calls = { submissions: 0, logReads: 0 };
  const client = {
    async submit() { calls.submissions += 1; return `j-run-${calls.submissions}`; },
    async describe() { return { state: "Running", terminal: false }; },
    async nodes() { return [{ Info: { NodeID: "n-1" } }]; },
    async logTail(id) {
      calls.logReads += 1;
      return { text: logText ?? `starting ${id}\nusing AWS_SECRET_ACCESS_KEY=sekrit-value-1\nTraceback (most recent call last):\n  File "x.py", line 1\nOSError: disk full\n`, bytes: 120, truncated: false, partial: false };
    },
  };
  const service = new HomeComputeService({
    config, client, environment: { AWS_SECRET_ACCESS_KEY: "sekrit-value-1" }, stateFile: path.join(directory, "state", "state.json"),
    logger: quiet, secrets: token ? [token] : [],
  });
  await service.history.record("harmonie", "j-done-1", {
    submittedAt: "2026-10-11T06:00:00Z", startedAt: "2026-10-11T06:01:00Z", finishedAt: "2026-10-11T06:05:00Z",
    state: "Completed", outcome: "published", exitCode: 0,
    reports: [{ event: "forecast_complete", model: "harmonie", run: "2026101106", seconds: 240, peakMemoryMb: 1800 }],
  });
  const api = createApiServer({ service, port: 0, token, dashboard: { allowedLogins: [OWNER] }, logger: quiet });
  const { port } = await api.listen();
  context.after(() => api.close());
  return { port, service, calls, configFile, api };
}

test("the dashboard is served with a strict content security policy", async (context) => {
  const { port } = await fixture(context);
  const page = await send(port, { path: "/" });
  assert.equal(page.status, 200);
  assert.match(page.headers["content-type"], /text\/html/);
  assert.match(page.headers["content-security-policy"], /default-src 'none'; script-src 'self'/);
  assert.match(page.headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.equal(page.headers["x-frame-options"], "DENY");
  assert.doesNotMatch(page.text, /https?:\/\/(?!www\.w3\.org)/, "nothing is loaded from elsewhere");
  for (const asset of ["/assets/app.js", "/assets/app.css", "/assets/icon.svg", "/manifest.webmanifest"]) {
    assert.equal((await send(port, { path: asset })).status, 200, asset);
  }
  assert.equal((await send(port, { path: "/assets/../src/auth.mjs" })).status, 401, "only the listed files are served");
});

test("an allowed tailnet login is trusted from tailscale serve, and only there", async (context) => {
  const { port } = await fixture(context);
  const session = await send(port, { path: "/v1/session", headers: viaTailscale("Owner@Example.com") });
  assert.equal(session.json.authenticated, true);
  assert.equal(session.json.method, "tailscale");
  assert.equal(session.json.login, OWNER);
  assert.ok(session.json.csrfToken);
  assert.equal((await send(port, { path: "/v1/snapshot", headers: viaTailscale(OWNER) })).status, 200);

  const stranger = await send(port, { path: "/v1/session", headers: viaTailscale("mallory@example.com") });
  assert.deepEqual(stranger.json, { authenticated: false, tokenLogin: true, tailscaleLogin: "mallory@example.com", tailscaleAllowed: false });
  assert.equal((await send(port, { path: "/v1/snapshot", headers: viaTailscale("mallory@example.com") })).status, 401);

  // DNS rebinding: a page on another name that resolves to 127.0.0.1.
  assert.equal((await send(port, { path: "/v1/snapshot", headers: viaTailscale(OWNER, { host: "evil.example.com:8443" }) })).status, 401);
  // A wrong bearer token is never passed over for another method.
  assert.equal((await send(port, { path: "/v1/snapshot", headers: viaTailscale(OWNER, { authorization: "Bearer nope" }) })).status, 401);
});

test("state changes from a browser need their own origin and the CSRF token", async (context) => {
  const { port, calls } = await fixture(context);
  const { csrfToken } = (await send(port, { path: "/v1/session", headers: viaTailscale(OWNER) })).json;
  const origin = `https://${TAILNET}`;
  const post = (headers) => send(port, { method: "POST", path: "/v1/jobs/harmonie/pause", headers: { ...viaTailscale(OWNER), "content-type": "application/json", ...headers }, body: {} });

  assert.equal((await post({ origin })).status, 403, "no CSRF token");
  assert.equal((await post({ origin, "x-csrf-token": "forged" })).status, 403);
  assert.equal((await post({ origin: "https://evil.example.com", "x-csrf-token": csrfToken })).status, 403, "cross-origin");
  assert.equal((await post({ "x-csrf-token": csrfToken })).status, 403, "no Origin at all");
  assert.equal((await post({ origin, "x-csrf-token": csrfToken, "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post({ origin, "x-csrf-token": csrfToken, "sec-fetch-site": "same-origin" })).status, 202);

  const run = await send(port, { method: "POST", path: "/v1/jobs/harmonie/run", headers: { authorization: `Bearer ${TOKEN}` }, body: {} });
  assert.equal(run.status, 202, "the bearer token needs no CSRF token");
  assert.equal(calls.submissions, 1);
});

test("signing in with the token sets a private session cookie", async (context) => {
  const { port } = await fixture(context);
  const local = { origin: `http://127.0.0.1:${port}`, "content-type": "application/json" };
  assert.equal((await send(port, { path: "/v1/snapshot" })).status, 401);

  const wrong = await send(port, { method: "POST", path: "/v1/session", headers: local, body: { token: "guess" } });
  assert.equal(wrong.status, 401);
  assert.equal((await send(port, { method: "POST", path: "/v1/session", headers: { ...local, origin: "http://evil.example" }, body: { token: TOKEN } })).status, 403);

  const signedIn = await send(port, { method: "POST", path: "/v1/session", headers: local, body: { token: TOKEN } });
  assert.equal(signedIn.status, 200);
  const cookie = signedIn.headers["set-cookie"][0];
  assert.match(cookie, /^hc_session=[\w-]{40,}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
  const jar = cookie.split(";")[0];
  assert.equal((await send(port, { path: "/v1/snapshot", headers: { cookie: jar } })).status, 200);
  const pause = await send(port, { method: "POST", path: "/v1/jobs/harmonie/pause", headers: { ...local, cookie: jar, "x-csrf-token": signedIn.json.csrfToken }, body: {} });
  assert.equal(pause.status, 202);

  // Over tailscale serve (HTTPS) the cookie is Secure and host-locked.
  const remote = await send(port, { method: "POST", path: "/v1/session",
    headers: { ...viaTailscale("someone@else.com"), origin: `https://${TAILNET}`, "content-type": "application/json" }, body: { token: TOKEN } });
  assert.match(remote.headers["set-cookie"][0], /^__Host-hc_session=.*; Secure$/);

  const out = await send(port, { method: "DELETE", path: "/v1/session", headers: { ...local, cookie: jar, "x-csrf-token": signedIn.json.csrfToken } });
  assert.equal(out.status, 200);
  assert.equal((await send(port, { path: "/v1/snapshot", headers: { cookie: jar } })).status, 401, "signed out");
});

test("repeated wrong tokens are throttled", async (context) => {
  const { port } = await fixture(context);
  const headers = { origin: `http://127.0.0.1:${port}`, "content-type": "application/json" };
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal((await send(port, { method: "POST", path: "/v1/session", headers, body: { token: `wrong-${attempt}` } })).status, 401);
  }
  assert.equal((await send(port, { method: "POST", path: "/v1/session", headers, body: { token: TOKEN } })).status, 429);
});

test("the menu bar app's one-time link signs a browser in once", async (context) => {
  const { port } = await fixture(context);
  assert.equal((await send(port, { method: "POST", path: "/v1/session/link", headers: viaTailscale(OWNER) })).status, 403,
    "only the token may mint links");
  const link = await send(port, { method: "POST", path: "/v1/session/link", headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(link.status, 201);
  const url = new URL(link.json.url);
  assert.equal(url.origin, `http://127.0.0.1:${port}`);
  const first = await send(port, { path: `${url.pathname}${url.search}` });
  assert.equal(first.status, 303);
  assert.equal(first.headers.location, "/");
  const jar = first.headers["set-cookie"][0].split(";")[0];
  assert.equal((await send(port, { path: "/v1/snapshot", headers: { cookie: jar } })).status, 200);
  const again = await send(port, { path: `${url.pathname}${url.search}` });
  assert.equal(again.headers.location, "/?signin=expired");
  assert.equal(again.headers["set-cookie"], undefined);
});

test("without a token, only direct local requests are let in", async (context) => {
  const { port } = await fixture(context, { token: null });
  assert.equal((await send(port, { path: "/v1/snapshot" })).status, 200, "as before tokens: a local script");
  assert.equal((await send(port, { method: "POST", path: "/v1/jobs/harmonie/pause", body: {} })).status, 202);
  assert.equal((await send(port, { path: "/v1/snapshot", headers: { host: TAILNET, "x-forwarded-for": "100.1.2.3" } })).status, 401,
    "a tailnet request through tailscale serve is not local");
  assert.equal((await send(port, { path: "/v1/snapshot", headers: { host: "evil.example.com" } })).status, 401, "DNS rebinding");
  assert.equal((await send(port, { method: "POST", path: "/v1/jobs/harmonie/pause", headers: { origin: "http://evil.example.com" }, body: {} })).status, 403,
    "a cross-site form post");
});

test("runs, logs and the snapshot's recent runs", async (context) => {
  const { port, calls } = await fixture(context);
  const auth = { authorization: `Bearer ${TOKEN}` };
  const snapshot = (await send(port, { path: "/v1/snapshot?live=false", headers: auth })).json;
  const harmonie = snapshot.jobs.find((job) => job.id === "harmonie");
  assert.equal(harmonie.recentRuns[0].id, "j-done-1");
  assert.equal(harmonie.recentRuns[0].reports, undefined, "lists leave the reports out");
  assert.equal(harmonie.recentRuns[0].metrics.peakMemoryMb, 1800);
  assert.equal(harmonie.runsUrl, "/v1/jobs/harmonie/runs");
  assert.deepEqual(snapshot.controller.features, ["history", "logs", "reload", "timetable"]);
  assert.equal(snapshot.timetable.editable, true);

  const runs = (await send(port, { path: "/v1/jobs/harmonie/runs", headers: auth })).json;
  assert.equal(runs.runs[0].reports[0].model, "harmonie");
  assert.equal((await send(port, { path: "/v1/jobs/nope/runs", headers: auth })).status, 404);

  const logs = (await send(port, { path: "/v1/runs/j-done-1/logs", headers: auth })).json;
  assert.equal(logs.job, "harmonie");
  assert.equal(logs.errorCount, 3);
  assert.deepEqual(logs.lines.map((line) => line.level), ["info", "info", "error", "error", "error"]);
  assert.doesNotMatch(JSON.stringify(logs), /sekrit-value-1/);
  await send(port, { path: "/v1/runs/j-done-1/logs", headers: auth });
  assert.equal(calls.logReads, 1, "a finished run's log is read once");

  assert.equal((await send(port, { path: "/v1/runs/j-someone-elses/logs", headers: auth })).status, 404, "only our own runs");
  assert.equal((await send(port, { path: "/v1/runs/not-a-run/logs", headers: auth })).status, 400);
  assert.equal((await send(port, { path: "/v1/runs/j-done-1/logs" })).status, 401);
});

test("a timetable change goes through the project's command and applies at once", async (context) => {
  const { port, service, configFile } = await fixture(context);
  const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const change = (id, body) => send(port, { method: "POST", path: `/v1/jobs/${id}/timetable`, headers: auth, body });

  const saved = await change("harmonie", { hours: [6, 18], minutes: [15] });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.reload.changed, ["harmonie"]);
  assert.deepEqual(saved.json.reload.restartRequired, []);
  assert.deepEqual(service.config.jobs[0].schedule.at, { hours: [6, 18], minutes: [15] }, "applied without a restart");
  assert.deepEqual(JSON.parse(await readFile(configFile, "utf8")).jobs[0].schedule.at.hours, [6, 18]);

  const off = await change("harmonie", { enabled: false });
  assert.equal(off.status, 200);
  const job = (await send(port, { path: "/v1/snapshot?live=false", headers: auth })).json.jobs.find((entry) => entry.id === "harmonie");
  assert.equal(job.configuredEnabled, false);
  assert.equal(job.nextDueAt, null);

  const refused = await change("harmonie", { minutes: [7] });
  assert.equal(refused.status, 422);
  assert.match(refused.json.error, /5-minute mark/);
  assert.equal((await change("harmonie", { hours: ["6;reboot"] })).status, 400);
  assert.equal((await change("prune", { minutes: [5] })).status, 400, "an interval job has no slots");
  assert.equal((await change("ghost", { enabled: true })).status, 404);
});

test("a reload applies new jobs and refuses a broken file", async (context) => {
  const { port, service, configFile } = await fixture(context, { timetable: false });
  const auth = { authorization: `Bearer ${TOKEN}` };
  const config = JSON.parse(await readFile(configFile, "utf8"));
  config.jobs.push({ id: "tides", schedule: { every: "6h" }, task: { image: "x" } });
  config.pollEvery = "1m";
  await writeFile(configFile, JSON.stringify(config));
  const reload = await send(port, { method: "POST", path: "/v1/reload", headers: auth });
  assert.equal(reload.status, 200);
  assert.deepEqual(reload.json.added, ["tides"]);
  assert.deepEqual(reload.json.restartRequired, ["pollEvery"]);
  assert.ok(service.config.jobs.some((job) => job.id === "tides"));

  await writeFile(configFile, "{ not json");
  const broken = await send(port, { method: "POST", path: "/v1/reload", headers: auth });
  assert.equal(broken.status, 422);
  assert.equal(service.config.jobs.length, 3, "the running jobs are kept");

  const noCommand = await send(port, { method: "POST", path: "/v1/jobs/harmonie/timetable", headers: { ...auth, "content-type": "application/json" }, body: { enabled: false } });
  assert.equal(noCommand.status, 501);
});

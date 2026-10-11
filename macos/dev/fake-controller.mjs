#!/usr/bin/env node
// Fake Home Compute controller for developing Home Compute Bar.
//
//   node dev/fake-controller.mjs [--port 4799] [--token dev-token] [--write-config /tmp/hcb/menubar.json]
//
// Serves /v1/health, /v1/snapshot, /v1/events (SSE) and POST /v1/jobs/:id/{run,pause,resume}
// with a fixed bearer token. Every 20 s the running job finishes (alternating failed / published)
// and is resubmitted 5 s later. --write-config writes a menubar.json pointing at this server,
// for use with HOME_COMPUTE_BAR_CONFIG=<path>.
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
);
const port = Number(args.port ?? 4799);
const token = args.token ?? "dev-token";
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const runId = (hoursAgo) => {
  const d = new Date(Date.now() - hoursAgo * 3600_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}`;
};

let counter = 0;
const jobs = [
  {
    id: "harmonie",
    enabled: true, paused: false, configuredEnabled: true,
    schedule: { at: { minutes: [45] }, timezone: "UTC" },
    image: "wingfoil-forecast:local",
    parameters: ["--models", "harmonie", "--step", "1"],
    resources: { cpu: "2", memory: "4Gb", disk: "20Gb" },
    labels: { application: "wingfoil", models: "harmonie" },
    description: "HARMONIE (Met Éireann), hourly DINI cycle",
    running: true, activeJobId: "j-harmonie-0", liveState: "Running",
    lastSubmittedAt: iso(-3 * 60_000), lastFinishedAt: iso(-63 * 60_000),
    lastFinishedJobId: "j-harmonie-prev", lastFinishedState: "Completed", lastExitCode: 0,
    lastOutcome: "unchanged", nextDueAt: iso(42 * 60_000),
    lastReports: [{ event: "forecast_unchanged", model: "harmonie", run: runId(3), time: iso(-63 * 60_000) }],
    published: { harmonie: { run: runId(3), at: iso(-2 * 3600_000), seconds: 412 } },
  },
  {
    id: "global-models",
    enabled: true, paused: false, configuredEnabled: true,
    schedule: { at: { hours: [3, 9, 15, 21], minutes: [30] }, timezone: "UTC" },
    image: "wingfoil-forecast:local",
    parameters: ["--models", "icon-eu,ecmwf,gfs"],
    resources: { cpu: "4", memory: "8Gb", disk: "40Gb" },
    labels: { application: "wingfoil", models: "icon-eu,ecmwf,gfs" },
    running: false, lastSubmittedAt: iso(-95 * 60_000), lastFinishedAt: iso(-80 * 60_000),
    lastFinishedJobId: "j-global-prev", lastFinishedState: "Completed", lastExitCode: 0,
    lastOutcome: "published", nextDueAt: iso(4 * 3600_000 + 30 * 60_000),
    lastReports: [
      { event: "forecast_complete", model: "icon-eu", run: runId(6), seconds: 301 },
      { event: "forecast_complete", model: "ecmwf", run: runId(6), seconds: 522 },
      { event: "forecast_unchanged", model: "gfs", run: runId(6) },
    ],
    published: {
      "icon-eu": { run: runId(6), at: iso(-81 * 60_000), seconds: 301 },
      ecmwf: { run: runId(6), at: iso(-80 * 60_000), seconds: 522 },
      gfs: { run: runId(12), at: iso(-7 * 3600_000), seconds: 199 },
    },
  },
  {
    id: "gfs-extended",
    enabled: false, paused: true, configuredEnabled: true,
    schedule: { every: "6h" },
    image: "wingfoil-forecast:local",
    labels: { application: "wingfoil", models: "gfs" },
    running: false, lastFinishedAt: iso(-26 * 3600_000), lastFinishedJobId: "j-gfs-prev",
    lastFinishedState: "Failed", lastExitCode: 2, lastOutcome: "failed",
    lastReports: [{ event: "forecast_failed", model: "gfs", run: runId(30), error: "HTTP 503 from nomads.ncep.noaa.gov" }],
  },
];

const clients = new Set();
function broadcast(event, data) {
  log(`emit ${event} ${JSON.stringify(data)} -> ${clients.size} client(s)`);
  for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify({ event, ...data })}\n\n`);
}

function submit(job, source = "schedule") {
  job.running = true;
  job.activeJobId = `j-${job.id}-${++counter}`;
  job.liveState = "Running";
  job.lastSubmittedAt = iso();
  broadcast("job_submitted", { job: job.id, bacalhauJobId: job.activeJobId, source });
}

function finish(job, outcome) {
  const failed = outcome === "failed";
  const reports = failed
    ? [{ event: "forecast_failed", model: "harmonie", run: runId(1), error: "GRIB download timed out after 120 s", time: iso() }]
    : [{ event: "forecast_complete", model: "harmonie", run: runId(1), seconds: 398, time: iso() }];
  Object.assign(job, {
    running: false, liveState: undefined, lastFinishedJobId: job.activeJobId, activeJobId: undefined,
    lastFinishedAt: iso(), lastFinishedState: failed ? "Failed" : "Completed", lastExitCode: failed ? 1 : 0,
    lastOutcome: outcome, lastReports: reports, nextDueAt: iso(45 * 60_000),
  });
  if (!failed) job.published = { harmonie: { run: runId(1), at: iso(), seconds: 398 } };
  broadcast("job_finished", {
    job: job.id, bacalhauJobId: job.lastFinishedJobId, state: job.lastFinishedState,
    exitCode: job.lastExitCode, outcome, reports,
  });
}

let cycle = 0;
setInterval(() => {
  const job = jobs[0];
  if (job.running) finish(job, cycle++ % 2 === 0 ? "failed" : "published");
  setTimeout(() => { if (!job.running && !job.paused) submit(job); }, 5_000);
}, 20_000);

function snapshot() {
  return {
    version: 1,
    generatedAt: iso(),
    controller: { status: "online", pollEvery: "30s" },
    nodeCount: 1,
    nodes: [{ Info: { NodeID: "n-macmini-1", NodeType: "Compute" }, Connection: "CONNECTED", Membership: "APPROVED" }],
    jobs: jobs.map((job) => ({ ...job, enabled: job.configuredEnabled && !job.paused })),
  };
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(`${JSON.stringify(body)}\n`);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const authed = req.headers.authorization === `Bearer ${token}`;
  log(`${req.method} ${url.pathname}${url.search} auth=${authed ? "ok" : "bad"} ua=${req.headers["user-agent"] ?? "-"}`);
  if (!authed) return send(res, 401, { error: "unauthorized" });

  if (req.method === "GET" && url.pathname === "/v1/health") return send(res, 200, { status: "ok", service: "home-compute" });
  if (req.method === "GET" && url.pathname === "/v1/snapshot") return send(res, 200, snapshot());
  if (req.method === "GET" && url.pathname === "/v1/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`event: ready\ndata: ${JSON.stringify({ service: "home-compute" })}\n\n`);
    clients.add(res);
    req.once("close", () => { clients.delete(res); log("SSE client disconnected"); });
    return;
  }
  const match = url.pathname.match(/^\/v1\/jobs\/([a-z0-9-]+)\/(run|pause|resume)$/);
  if (req.method === "POST" && match) {
    const job = jobs.find((j) => j.id === match[1]);
    if (!job) return send(res, 404, { error: `Unknown job ${match[1]}` });
    if (match[2] === "run") {
      if (job.running) return send(res, 409, { error: `Job ${job.id} already has active Bacalhau job ${job.activeJobId}` });
      submit(job, "manual");
      return send(res, 202, { job: job.id, bacalhauJobId: job.activeJobId });
    }
    job.paused = match[2] === "pause";
    broadcast(job.paused ? "job_paused" : "job_resumed", { job: job.id });
    return send(res, 202, { job: job.id, paused: job.paused });
  }
  send(res, 404, { error: "not_found" });
});

server.listen(port, "127.0.0.1", () => {
  log(`fake home-compute listening on http://127.0.0.1:${port} (token "${token}")`);
  if (args["write-config"]) {
    const path = args["write-config"];
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ url: `http://127.0.0.1:${port}`, token }, null, 2)}\n`, { mode: 0o600 });
    log(`wrote ${path}`);
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const res of clients) res.end();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}

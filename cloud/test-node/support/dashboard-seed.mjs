// A control plane with something on every page, for the dashboard's browser
// tests and screenshots: Wingfoil's timetable (imported with the CLI; every
// job is blocked on vault secrets until M5), a few demo jobs, a real agent on
// FakeRuntime ("mac-mini", a Colima-like VM that boots) running one job,
// failing another and holding a third, a second machine whose VM failed and
// whose clock is off (a scripted agent), an offline machine on an old agent,
// a lost run, a run waiting for labels nobody has, and some older history.
import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { newId } from "../../../src/core/ids.mjs";
import { ROOT } from "./dev-stack.mjs";

const execFile = promisify(execFileCallback);
const AGENT = path.join(ROOT, "agent/src/cli.mjs");
const CLI = path.join(ROOT, "src/cli.mjs");
const FIXTURE = path.join(ROOT, "test/fixtures/wingfoil-home-compute.json");
const WINGFOIL_IMAGE = `ghcr.io/sprintengine/wingfoil-forecast@sha256:${"ab12".repeat(16)}`;
const MIB = 1048576;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const image = (name) => `ghcr.io/example/${name}@sha256:${"0f".repeat(32)}`;
const quote = (value) => (value === null || value === undefined ? "NULL" : typeof value === "number" ? String(value) : `'${String(value).replace(/'/g, "''")}'`);

export const DEMO_JOBS = {
  hello: {
    description: "Says hello and reports a forecast run",
    image: "ghcr.io/example/hello:1.4", schedule: { at: { hours: [6, 12, 18], minutes: [15] } },
    resources: { cpus: 1, memoryMiB: 512, diskMiB: 1024 },
    report: { format: "json-lines", trackEvent: "forecast_complete", trackBy: "model" },
    placement: { preferMachines: ["mac-mini"], preferWaitSeconds: 300 },
  },
  flaky: { description: "Fails on purpose", image: image("flaky"), schedule: { at: { hours: [9], minutes: [45] } }, resources: { cpus: 1, memoryMiB: 256, diskMiB: 512 } },
  slow: { description: "A long import", image: image("slow"), schedule: { every: "6h" }, resources: { cpus: 1, memoryMiB: 1024, diskMiB: 2048 } },
  "gpu-render": { description: "Needs a GPU no machine has", image: image("render"), schedule: null, placement: { requireLabels: { gpu: "yes" } } },
  "nightly-backup": { description: "Copies the bucket", image: image("backup"), schedule: { at: { hours: [2], minutes: [30] } } },
};

const SCRIPTS = {
  hello: {
    output: ["starting hello", { memoryBytes: 182 * MIB, cpuPct: 64, cpuSeconds: 1.2 }, { sleepMs: 3500, line: "fetched 3 files (12.4 MB)" },
      { line: JSON.stringify({ event: "forecast_complete", model: "hello", run: "2026101112", seconds: 3.4, frames: 48, peakMemoryMb: 190 }) }, "done"],
    exitCode: 0,
  },
  flaky: {
    output: ["starting flaky", { memoryBytes: 96 * MIB, cpuPct: 30 }, { sleepMs: 2500, line: "downloading the model run" },
      "Traceback (most recent call last):", '  File "/app/run.py", line 12, in <module>', "    fetch(model)", "OSError: [Errno 28] No space left on device"],
    exitCode: 1,
  },
  slow: { output: ["starting a long import", { memoryBytes: 412 * MIB, cpuPct: 88, cpuSeconds: 30 }, { sleepMs: 6 * HOUR }], exitCode: 0 },
};

async function waitFor(check, what, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function runRow(run) {
  const columns = Object.keys(run);
  return `INSERT INTO runs (${columns.join(", ")}) VALUES (${columns.map((column) => quote(run[column])).join(", ")});`;
}

/** Finished runs of `job` over the last days, every `everyMs`, oldest first, with durations around `seconds`. */
function history(job, { machineId, count, seconds, everyMs, now, failedEvery = 0, peakMiB = 200, revision = 1 }) {
  const rows = [];
  for (let index = count; index >= 1; index -= 1) {
    const due = now - index * everyMs - 3 * HOUR;
    const took = Math.round(seconds * (0.75 + ((index * 37) % 50) / 100));
    const failed = failedEvery && index % failedEvery === 0;
    rows.push({
      id: newId("r", due), job_id: job, job_revision: revision, slot_at: due, source: "schedule", state: failed ? "failed" : "succeeded",
      outcome: failed ? "failed" : index % 3 ? "published" : "unchanged", attempt: 1, due_at: due, machine_id: machineId,
      claimed_at: due + 2000, started_at: due + 9000, finished_at: due + 9000 + took * 1000, queue_ms: 9000, duration_ms: took * 1000,
      exit_code: failed ? 1 : 0, peak_memory_bytes: Math.round(peakMiB * (0.8 + (index % 5) / 20) * MIB), stats_samples: Math.max(1, Math.round(took / 3)),
      error: failed ? "exited with 1" : null, image_digest: `sha256:${"cd".repeat(32)}`, created_at: due, updated_at: due + 9000 + took * 1000,
    });
  }
  return rows;
}

/**
 * Seeds `stack` (from startDevStack). Returns `{agentStop(), ids}`; the
 * agent and the scripted machine keep running until `agentStop`.
 */
export async function seedDashboard(stack) {
  const now = Date.now();
  const cleanups = [];
  // 1. Wingfoil's timetable through the CLI, as an owner would import it.
  await execFile(process.execPath, [CLI, "cloud", "import", FIXTURE, "--preset", "wingfoil", "--image", WINGFOIL_IMAGE],
    { env: { ...process.env, HC_URL: stack.web, HC_ACCESS_JWT: stack.seedToken } });
  for (const [id, definition] of Object.entries(DEMO_JOBS)) await stack.api(`/v1/jobs/${id}`, { method: "PUT", body: definition });

  // 2. mac-mini: the real agent on FakeRuntime with a VM that boots.
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "hc-dashboard-agent-"));
  const token = (await stack.api("/v1/join-tokens", { method: "POST", body: { name: "mac-mini", labels: { site: "home" } } })).token;
  const enrol = spawn(process.execPath, [AGENT, "enrol", "--server", stack.core, "--join-token-stdin", "--state-dir", agentDir, "--runtime", "fake",
    "--allow-images", "ghcr.io/example/*"], { stdio: ["pipe", "pipe", "pipe"] });
  enrol.stdin.end(token);
  const enrolled = await new Promise((resolve) => enrol.once("exit", resolve));
  if (enrolled !== 0) throw new Error("the agent did not enrol");
  const configFile = path.join(agentDir, "config.json");
  const config = JSON.parse(await readFile(configFile, "utf8"));
  Object.assign(config, {
    statusPort: 0, statsIntervalSeconds: 1, caps: { cpus: 4, memoryMiB: 6144, maxRuns: 4 },
    fake: { vm: "stopped", bootMs: 2500, cpus: 4, memoryMiB: 6144, diskFreeMiB: 40_000, scripts: SCRIPTS },
  });
  await writeFile(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
  const agent = spawn(process.execPath, [AGENT, "run", "--state-dir", agentDir], { stdio: ["ignore", "pipe", "pipe"] });
  let agentLog = "";
  agent.stdout.on("data", (chunk) => { agentLog += chunk; });
  agent.stderr.on("data", (chunk) => { agentLog += chunk; });
  cleanups.push(async () => {
    if (agent.exitCode === null) {
      await new Promise((resolve) => { agent.once("exit", resolve); agent.kill("SIGTERM"); });
    }
    await rm(agentDir, { recursive: true, force: true });
  });
  const machines = () => stack.api("/v1/machines");
  const mac = await waitFor(async () => (await machines()).machines.find((machine) => machine.name === "mac-mini" && machine.lastSeenAt), "mac-mini's first sync");

  // 3. linux-1: a scripted agent whose Colima VM failed three times and whose clock runs 42 s ahead.
  const linuxToken = (await stack.api("/v1/join-tokens", { method: "POST", body: { name: "linux-1", labels: { site: "office" } } })).token;
  const linux = await (await fetch(`${stack.core}/agent/v1/enrol`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ protocol: 1, joinToken: linuxToken, facts: { os: "linux", arch: "amd64", runtime: "colima", agentVersion: "0.2.0" } }),
  })).json();
  let linuxTimer = null;
  const linuxSync = async () => {
    try {
      await fetch(`${stack.core}/agent/v1/sync`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${linux.credential}` },
        body: JSON.stringify({
          protocol: 1, agentVersion: "0.2.0", agentTime: Date.now() + 42_000, claim: false, runs: [],
          machine: { drain: false, vm: { kind: "colima", state: "stopped", cpus: null, memoryMiB: null },
            free: { cpus: 2, memoryMiB: 3072, diskMiB: 20_000, runs: 2 },
            health: { docker: "ok", vm: "failed", lastError: "colima start home-compute: exit status 1 (vz: the virtual machine stopped unexpectedly)" } },
        }),
      });
    } catch {
      // The stack is going away.
    }
    linuxTimer = setTimeout(linuxSync, 20_000);
  };
  await linuxSync();
  cleanups.push(async () => clearTimeout(linuxTimer));

  // 4. Straight into D1: an offline machine on an old agent, older history, a lost run, published models.
  const oldBox = newId("m", now - 40 * 24 * HOUR);
  const harmonie = history("harmonie", { machineId: mac.id, count: 14, seconds: 290, everyMs: 12 * HOUR, now, failedEvery: 6, peakMiB: 1700 });
  const ecmwf = history("ecmwf", { machineId: mac.id, count: 16, seconds: 610, everyMs: 12 * HOUR, now, peakMiB: 820 });
  const blend = history("blend", { machineId: mac.id, count: 20, seconds: 95, everyMs: HOUR, now, peakMiB: 300 });
  const hello = history("hello", { machineId: mac.id, count: 12, seconds: 4, everyMs: 6 * HOUR, now, failedEvery: 5, peakMiB: 185 });
  const backup = history("nightly-backup", { machineId: oldBox, count: 6, seconds: 1400, everyMs: 24 * HOUR, now: now - 24 * HOUR, peakMiB: 640 });
  const lostAt = now - 5 * HOUR;
  const lost = {
    id: newId("r", lostAt), job_id: "nightly-backup", job_revision: 1, slot_at: lostAt, source: "schedule", state: "lost", attempt: 1, due_at: lostAt,
    machine_id: oldBox, claimed_at: lostAt + 3000, started_at: lostAt + 9000, created_at: lostAt, updated_at: lostAt + 30 * MINUTE,
  };
  const published = (model, run, rows) => JSON.stringify({ [model]: { run, at: new Date(rows.at(-1).finished_at).toISOString(), seconds: 300, runId: rows.at(-1).id } });
  const state = (job, rows, extra = "") => `INSERT INTO schedule_state (job_id, last_run_id, last_state, last_outcome, last_finished_at${extra ? ", published_json" : ""})
    VALUES (${quote(job)}, ${quote(rows.at(-1).id)}, ${quote(rows.at(-1).state)}, ${quote(rows.at(-1).outcome)}, ${rows.at(-1).finished_at}${extra ? `, ${quote(extra)}` : ""})
    ON CONFLICT(job_id) DO UPDATE SET last_run_id = excluded.last_run_id, last_state = excluded.last_state, last_outcome = excluded.last_outcome,
      last_finished_at = excluded.last_finished_at${extra ? ", published_json = excluded.published_json" : ""};`;
  await stack.sql([
    `INSERT INTO machines (id, name, labels_json, capabilities, capacity_json, facts_json, health_json, agent_version, credential_hash, drain,
       last_seen_at, last_ip, clock_skew_ms, enrolled_at, credential_issued_at)
     VALUES (${quote(oldBox)}, 'old-box', '{"os":"linux","arch":"amd64","runtime":"docker"}', '', '{"maxRuns":1}',
       '{"os":"linux","arch":"amd64","runtime":"docker","vm":null,"free":{"cpus":2,"memoryMiB":2048,"runs":1}}', '{"docker":"ok"}', '0.1.0',
       '${"0".repeat(64)}', 0, ${now - 3 * HOUR}, '100.101.7.9', 800, ${now - 40 * 24 * HOUR}, ${now - 40 * 24 * HOUR});`,
    ...[...harmonie, ...ecmwf, ...blend, ...hello, ...backup, lost].map(runRow),
    state("harmonie", harmonie, published("harmonie", "2026101106", harmonie)),
    state("ecmwf", ecmwf, published("ecmwf", "2026101100", ecmwf)),
    state("blend", blend),
    state("hello", hello, published("hello", "2026101106", hello)),
    state("nightly-backup", backup),
    "UPDATE settings SET value_json = CAST(CAST(value_json AS INTEGER) + 1 AS TEXT) WHERE key = 'machines_version';",
  ].join("\n"));

  // 5. Live runs on mac-mini: hello succeeds, flaky fails, slow keeps running.
  const runs = {};
  for (const job of ["hello", "flaky", "slow"]) runs[job] = (await stack.api(`/v1/jobs/${job}/run`, { method: "POST", body: {} })).runId;
  const phase = async (id) => (await stack.api(`/v1/runs/${id}`)).phase;
  try {
    await waitFor(async () => ["succeeded", "failed"].includes(await phase(runs.hello)) && await phase(runs.flaky) === "failed", "hello and flaky to finish", 120_000);
    await waitFor(async () => (await phase(runs.slow)) === "running", "slow to run");
  } catch (error) {
    throw new Error(`${error.message}\n${agentLog.slice(-3000)}`);
  }

  // 6. A run waiting 14 minutes for a label no machine has.
  runs.waiting = (await stack.api("/v1/jobs/gpu-render/run", { method: "POST", body: {} })).runId;
  const backdated = now - 14 * MINUTE;
  await stack.sql(`UPDATE runs SET due_at = ${backdated}, created_at = ${backdated}, updated_at = ${Date.now()} WHERE id = '${runs.waiting}';`);
  runs.lost = lost.id;
  runs.harmonie = harmonie.at(-1).id;
  await stack.cron();
  return {
    ids: { runs, machines: { mac: mac.id, linux: linux.machineId, oldBox } },
    agentLog: () => agentLog,
    async stop() {
      for (const cleanup of cleanups.reverse()) await cleanup();
    },
  };
}

#!/usr/bin/env node
// A second agent to point the menu bar and tray apps at, without touching a
// real one: hc-web and hc-core under `wrangler dev` (test-node/support/dev-stack.mjs),
// three manual-only jobs, and this checkout's agent enrolled on FakeRuntime
// with its own state directory and status port. It restarts the agent when
// it exits 75 (drain, restart), as launchd and systemd would.
//
//   node cloud/scripts/agent-status-demo.mjs [--state-dir DIR] [--port PORT]
//
// Defaults: /tmp/hc-status-demo/agent and 4797 (not the 4787 a real agent
// uses). Then type, one per line:
//
//   run JOB      start a run of gfs (runs ~2 min), harmonie (fails), icon-eu (publishes) or wind-obs (cancelled when run twice)
//   history      a few finished runs: icon-eu, harmonie and wind-obs
//   cancel JOB   cancel JOB's active run from the dashboard side
//   drain-web    drain this machine from the dashboard; undrain-web undoes it
//   status       print the agent's status
//   quit         stop everything and delete the scratch state
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { ROOT, startDevStack } from "../test-node/support/dev-stack.mjs";

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const STATE = path.resolve(argument("state-dir", "/tmp/hc-status-demo/agent"));
const PORT = Number(argument("port", "4797"));
if (PORT === 4787) throw new Error("4787 is a real agent's port; pick another");
const AGENT = path.join(ROOT, "agent/src/cli.mjs");
const MIB = 1048576;
const image = (name) => `ghcr.io/example/${name}@sha256:${"0f".repeat(32)}`;

const JOBS = {
  gfs: { description: "GFS 0.25° import", image: image("wingfoil"), schedule: null, resources: { cpus: 1, memoryMiB: 1024, diskMiB: 1024 } },
  harmonie: { description: "HARMONIE import", image: image("wingfoil"), schedule: null, resources: { cpus: 1, memoryMiB: 512, diskMiB: 512 } },
  "icon-eu": {
    description: "ICON-EU import", image: image("wingfoil"), schedule: null, resources: { cpus: 1, memoryMiB: 512, diskMiB: 512 },
    report: { format: "json-lines", trackEvent: "forecast_complete", trackBy: "model" },
  },
  "wind-obs": { description: "Wind observations", image: image("wingfoil"), schedule: null, resources: { cpus: 1, memoryMiB: 256, diskMiB: 256 } },
};

const SCRIPTS = {
  gfs: {
    output: ["fetching gfs 2026101812", { memoryBytes: 612 * MIB, cpuPct: 72, cpuSeconds: 5 }, { sleepMs: 20_000, line: "decoded 96 of 209 frames" },
      { memoryBytes: 812 * MIB, cpuPct: 64, cpuSeconds: 18 }, { sleepMs: 100_000, line: "uploaded 209 frames" }],
    exitCode: 0,
  },
  harmonie: {
    output: ["fetching harmonie 2026101806", { memoryBytes: 220 * MIB, cpuPct: 35 }, { sleepMs: 2500, line: "Traceback (most recent call last):" },
      '  File "/app/force5/harmonie.py", line 88, in fetch', "    response.raise_for_status()",
      "requests.exceptions.HTTPError: 503 Server Error: Service Unavailable for url: https://opendata.example.org/harmonie/2026101806"],
    exitCode: 1,
  },
  "icon-eu": {
    output: ["fetching icon-eu 2026101806", { memoryBytes: 410 * MIB, cpuPct: 58 }, { sleepMs: 3000, line: "decoded 79 frames" },
      JSON.stringify({ event: "forecast_complete", model: "icon-eu", run: "2026101806", seconds: 3.1 })],
    exitCode: 0,
  },
  "wind-obs": { output: ["polling stations", { memoryBytes: 64 * MIB, cpuPct: 5 }, { sleepMs: 600_000 }], exitCode: 0 },
};

const stack = await startDevStack();
let agent = null;
let stopping = false;
const close = async () => {
  stopping = true;
  if (agent && agent.exitCode === null) await new Promise((resolve) => { agent.once("exit", resolve); agent.kill("SIGTERM"); });
  await stack.close();
  await rm(path.dirname(STATE), { recursive: true, force: true });
};

try {
  for (const [id, definition] of Object.entries(JOBS)) await stack.api(`/v1/jobs/${id}`, { method: "PUT", body: definition });
  await rm(STATE, { recursive: true, force: true });
  await mkdir(STATE, { recursive: true, mode: 0o700 });
  const token = (await stack.api("/v1/join-tokens", { method: "POST", body: { name: "status-demo", labels: { site: "home" } } })).token;
  const enrol = spawn(process.execPath, [AGENT, "enrol", "--server", stack.core, "--join-token-stdin", "--state-dir", STATE, "--runtime", "fake",
    "--allow-images", "ghcr.io/example/*"], { stdio: ["pipe", "inherit", "inherit"] });
  enrol.stdin.end(token);
  if ((await new Promise((resolve) => enrol.once("exit", resolve))) !== 0) throw new Error("the agent did not enrol");
  const configFile = path.join(STATE, "config.json");
  const config = JSON.parse(await readFile(configFile, "utf8"));
  const logFile = path.join(path.dirname(STATE), "agent.log");
  Object.assign(config, {
    statusPort: PORT, statsIntervalSeconds: 1, caps: { cpus: 4, memoryMiB: 6144, maxRuns: 2 }, dashboardUrl: stack.web, logFile,
    fake: { cpus: 4, memoryMiB: 6144, diskFreeMiB: 40_000, scripts: SCRIPTS },
  });
  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  const start = async () => {
    const log = await import("node:fs").then((fs) => fs.createWriteStream(logFile, { flags: "a" }));
    agent = spawn(process.execPath, [AGENT, "run", "--state-dir", STATE], { stdio: ["ignore", "pipe", "pipe"] });
    agent.stdout.pipe(log);
    agent.stderr.pipe(log);
    agent.once("exit", (code) => {
      console.log(`agent exited ${code}`);
      if (!stopping && code !== 0) setTimeout(start, 2000);
    });
  };
  await start();
  console.log(`hc-web ${stack.web}  hc-core ${stack.core}`);
  console.log(`agent state ${STATE}, status API http://127.0.0.1:${PORT}, log ${logFile}`);
  console.log("commands: run JOB | history | cancel JOB | drain-web | undrain-web | status | quit");

  const machineId = config.machineId;
  const runOf = async (job) => (await stack.api(`/v1/jobs/${job}/runs`)).runs?.find((run) => ["due", "claimed", "starting-vm", "pulling", "running"].includes(run.phase));
  const commands = {
    run: async (job) => console.log(await stack.api(`/v1/jobs/${job}/run`, { method: "POST", body: {} })),
    history: async () => {
      for (const job of ["icon-eu", "harmonie"]) {
        await commands.run(job);
        await new Promise((resolve) => setTimeout(resolve, 6000));
      }
      await commands.run("wind-obs");
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await commands.cancel("wind-obs");
    },
    cancel: async (job) => {
      const run = await runOf(job);
      if (!run) return console.log(`no active run of ${job}`);
      console.log(await stack.api(`/v1/runs/${run.id}/cancel`, { method: "POST", body: {} }));
    },
    "drain-web": async () => console.log((await stack.api(`/v1/machines/${machineId}`, { method: "PATCH", body: { drain: true } })).drain),
    "undrain-web": async () => console.log((await stack.api(`/v1/machines/${machineId}`, { method: "PATCH", body: { drain: false } })).drain),
    status: async () => new Promise((resolve) => {
      spawn(process.execPath, [AGENT, "status", "--state-dir", STATE], { stdio: "inherit" }).once("exit", resolve);
    }),
  };
  const lines = readline.createInterface({ input: process.stdin });
  const done = new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
    lines.on("close", resolve);
    lines.on("line", async (line) => {
      const [command, ...rest] = line.trim().split(/\s+/);
      if (command === "quit") return resolve();
      try {
        if (commands[command]) await commands[command](...rest);
        else if (command) console.log(`unknown command ${command}`);
      } catch (error) {
        console.log(`${command}: ${error.message}`);
      }
    });
  });
  await done;
} finally {
  await close();
}

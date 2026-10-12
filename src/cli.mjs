#!/usr/bin/env node

import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { BacalhauClient, buildJobSpec } from "./bacalhau.mjs";
import { createApiServer } from "./api.mjs";
import { cloudCommand } from "./cloud-cli.mjs";
import { stampConsole } from "./log.mjs";
import { dashboardSettings, loadConfig, parseDuration, readEnvFile } from "./config.mjs";
import { readState } from "./scheduler.mjs";
import { HomeComputeService } from "./service.mjs";

const HELP = `home-compute — schedule containers on an unmodified Bacalhau cluster

Usage:
  home-compute validate [--config FILE]
  home-compute render JOB [--config FILE] [--env-file FILE] [--show-secrets]
  home-compute run JOB [--config FILE] [--env-file FILE] [-- EXTRA_ARGUMENTS...]
  home-compute daemon [--config FILE] [--env-file FILE] [--state FILE] [--once] [--no-api]
  home-compute status [--config FILE] [--state FILE] [--live]
  home-compute doctor [--config FILE] [--env-file FILE]
  home-compute cloud import FILE [--preset NAME] [--image REF] [--dry-run]   (see: home-compute cloud help)

Defaults: ./home-compute.json and ./.home-compute/state.json. Secret values come
from the process environment or an ignored env file. Configuration contains only
the names of environment variables that should be passed to a job.
`;

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const options = { command, positionals: [], extraParameters: [] };
  let passthrough = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (passthrough) {
      options.extraParameters.push(arg);
    } else if (arg === "--") {
      passthrough = true;
    } else if (["--config", "--env-file", "--state"].includes(arg)) {
      if (!rest[index + 1]) throw new Error(`${arg} needs a value`);
      options[arg.slice(2).replace("-", "_")] = rest[++index];
    } else if (arg === "--once") {
      options.once = true;
    } else if (arg === "--live") {
      options.live = true;
    } else if (arg === "--show-secrets") {
      options.showSecrets = true;
    } else if (arg === "--no-api") {
      options.noApi = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option ${arg}`);
    } else {
      options.positionals.push(arg);
    }
  }
  return options;
}

function stateFilename(config, option) {
  const configured = option ?? config.stateFile ?? ".home-compute/state.json";
  return path.resolve(path.dirname(config.filename), configured);
}

async function environmentFor(options, config) {
  const configured = options.env_file ?? config.envFile;
  const filename = configured ? path.resolve(path.dirname(config.filename), configured) : undefined;
  try {
    return { ...process.env, ...(await readEnvFile(filename)) };
  } catch (error) {
    if (!options.env_file && error.code === "ENOENT") return { ...process.env };
    throw error;
  }
}

function clientFor(config) {
  return new BacalhauClient({
    binary: config.bacalhau?.binary,
    apiHost: config.bacalhau?.apiHost,
    apiPort: config.bacalhau?.apiPort,
  });
}

function requireJob(config, id) {
  if (!id) throw new Error("A job id is required");
  const job = config.jobs.find((candidate) => candidate.id === id);
  if (!job) throw new Error(`Unknown job ${id}`);
  return job;
}

async function acquireLock(filename) {
  await mkdir(path.dirname(filename), { recursive: true });
  const lockFile = `${filename}.lock`;
  try {
    const handle = await open(lockFile, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n`);
    await handle.close();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const owner = Number((await readFile(lockFile, "utf8")).trim());
    try {
      process.kill(owner, 0);
      throw new Error(`Another scheduler is running with pid ${owner}`);
    } catch (probe) {
      if (probe.code !== "ESRCH") throw probe;
    }
    await rm(lockFile);
    return acquireLock(filename);
  }
  return async () => rm(lockFile, { force: true });
}

async function runNow({ config, options, environment }) {
  const stateFile = stateFilename(config, options.state);
  const service = new HomeComputeService({ config, client: clientFor(config), environment, stateFile });
  console.log(JSON.stringify(await service.run(options.positionals[0], options.extraParameters)));
}

async function daemon({ config, options, environment }) {
  const stateFile = stateFilename(config, options.state);
  const client = clientFor(config);
  const interval = parseDuration(config.pollEvery ?? "30s");
  const apiConfig = config.api ?? {};
  const token = apiConfig.tokenEnv ? environment[apiConfig.tokenEnv] : undefined;
  if (apiConfig.tokenEnv && !token) throw new Error(`API authentication requires ${apiConfig.tokenEnv}`);
  const service = new HomeComputeService({ config, client, environment, stateFile, secrets: token ? [token] : [] });
  const dashboard = dashboardSettings(config, environment);
  const api = options.once || options.noApi || apiConfig.enabled === false ? undefined : createApiServer({
    service,
    host: apiConfig.host ?? "127.0.0.1",
    port: apiConfig.port ?? 4786,
    token,
    dashboard,
  });
  const release = await acquireLock(stateFile);
  let stopping = false;
  let wake;
  const stop = () => {
    stopping = true;
    wake?.();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  // `kill -HUP` reloads the jobs, as POST /v1/reload does.
  const reload = () => service.reloadConfig({ reason: "SIGHUP" }).catch((error) => {
    console.error(JSON.stringify({ event: "config_reload_failed", error: error.message }));
  });
  process.on("SIGHUP", reload);
  try {
    if (api) {
      const address = await api.listen();
      console.log(JSON.stringify({
        event: "api_listening",
        ...address,
        authenticated: Boolean(token),
        dashboard: dashboard.enabled !== false,
        tailscaleLogins: dashboard.allowedLogins.length,
      }));
    }
    do {
      await service.reconcile();
      if (options.once || stopping) break;
      await new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        };
        const timer = setTimeout(finish, interval);
        wake = finish;
      });
    } while (!stopping);
  } finally {
    process.off("SIGHUP", reload);
    await api?.close();
    await release();
  }
}

async function showStatus({ config, options }) {
  const state = await readState(stateFilename(config, options.state));
  if (options.live) {
    const client = clientFor(config);
    for (const record of Object.values(state.jobs)) {
      if (!record.activeJobId) continue;
      try {
        const status = await client.describe(record.activeJobId);
        record.liveState = status.state;
      } catch (error) {
        record.liveError = error.message;
      }
    }
  }
  console.log(JSON.stringify(state, null, 2));
}

async function doctor({ config, environment }) {
  const client = clientFor(config);
  const report = { configuration: "ok", bacalhau: "unknown", nodes: "unknown", jobs: {} };
  for (const job of config.jobs) {
    try {
      buildJobSpec(job, environment, { redact: true });
      report.jobs[job.id] = "ready";
    } catch (error) {
      report.jobs[job.id] = error.message;
    }
  }
  try {
    report.bacalhau = await client.version();
    const nodes = await client.nodes();
    report.nodes = Array.isArray(nodes) ? nodes.length : nodes;
  } catch (error) {
    report.bacalhau = `unavailable: ${error.message}`;
  }
  console.log(JSON.stringify(report, null, 2));
  if (String(report.bacalhau).startsWith("unavailable") || Object.values(report.jobs).some((value) => value !== "ready")) {
    process.exitCode = 1;
  }
}

async function main() {
  if (process.argv[2] === "cloud") {
    await cloudCommand(process.argv.slice(3));
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  if (["help", "--help", "-h"].includes(options.command)) {
    console.log(HELP);
    return;
  }
  const config = await loadConfig(options.config ?? "home-compute.json");
  const context = { config, options };
  if (options.command === "validate") {
    console.log(`${config.filename}: valid`);
  } else if (options.command === "status") {
    await showStatus(context);
  } else {
    context.environment = await environmentFor(options, config);
    if (options.command === "render") {
      const job = requireJob(config, options.positionals[0]);
      console.log(JSON.stringify(buildJobSpec(job, context.environment, { redact: !options.showSecrets }), null, 2));
    } else if (options.command === "run") {
      await runNow(context);
    } else if (options.command === "daemon") {
      // controller.log is this process's output: every event in it says when it happened.
      stampConsole();
      await daemon(context);
    } else if (options.command === "doctor") {
      await doctor(context);
    } else {
      throw new Error(`Unknown command ${options.command}\n\n${HELP}`);
    }
  }
}

main().catch((error) => {
  console.error(`home-compute: ${error.message}`);
  process.exitCode = 1;
});

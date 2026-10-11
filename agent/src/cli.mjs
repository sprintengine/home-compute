#!/usr/bin/env node
// home-compute-agent: enrol this machine, run the agent as a service, show
// its status, or check its setup. See agent/README.md.

import { realpathSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { PROTOCOL } from "../../src/core/protocol.mjs";
import { Agent, jsonLog } from "./agent.mjs";
import { ControlPlaneClient } from "./client.mjs";
import { enrol } from "./enrol.mjs";
import { createRuntime } from "./runtime/runtime.mjs";
import { defaultStateDir, StateDir } from "./state.mjs";
import { startStatusServer } from "./status-server.mjs";
import { AGENT_VERSION } from "./version.mjs";

const USAGE = `home-compute-agent ${AGENT_VERSION}

Usage:
  home-compute-agent enrol --server URL --join-token-stdin [--name NAME] [--runtime fake] [--reenrol]
  home-compute-agent run
  home-compute-agent status [--json]
  home-compute-agent doctor
  home-compute-agent version

Every command takes --state-dir DIR (or HC_AGENT_STATE_DIR); the default is
~/Library/Application Support/home-compute on a Mac and /etc/home-compute
(root) or ~/.local/state/home-compute on Linux.`;

const FLAGS = new Set(["join-token-stdin", "reenrol", "json", "help"]);

/** `--name value`, `--name=value` and boolean flags; the first bare word is the command. */
export function parseArguments(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      options._.push(argument);
      continue;
    }
    const [key, inline] = argument.slice(2).split(/=(.*)/s);
    if (FLAGS.has(key)) options[key] = inline === undefined ? true : inline !== "false";
    else if (inline !== undefined) options[key] = inline;
    else if (index + 1 < argv.length) options[key] = argv[++index];
    else throw new Error(`--${key} needs a value`);
  }
  return options;
}

async function readStdin(stdin = process.stdin) {
  let text = "";
  for await (const chunk of stdin) text += chunk;
  return text.trim();
}

function stateFrom(options) {
  return new StateDir(options["state-dir"] ?? defaultStateDir());
}

async function loadEnrolled(state) {
  const config = await state.loadConfig();
  const credential = await state.readCredential();
  if (!config?.server || !credential) throw new Error(`Not enrolled: no configuration or credential in ${state.dir}. Run "home-compute-agent enrol" first.`);
  return { config, credential };
}

async function localStatus(state, config, timeoutMs = 2000) {
  if (!config?.statusPort) return null;
  const token = (await state.readText(state.statusTokenPath))?.trim();
  if (!token) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${config.statusPort}/status`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

function ago(isoTime, now = Date.now()) {
  if (!isoTime) return "never";
  const seconds = Math.round((now - Date.parse(isoTime)) / 1000);
  return seconds >= 0 ? `${seconds} s ago` : `in ${-seconds} s`;
}

async function commandEnrol(options, io) {
  const state = stateFrom(options);
  let joinToken = options["join-token"];
  if (joinToken) io.error("Warning: --join-token puts the token in the process list; prefer --join-token-stdin.");
  if (options["join-token-stdin"]) joinToken = await readStdin(io.stdin);
  const answer = await enrol({
    state, server: options.server, joinToken, name: options.name, runtime: options.runtime ?? "fake", reenrol: Boolean(options.reenrol),
    fetch: io.fetch,
  });
  io.out(`Enrolled ${answer.name} (${answer.machineId}) with labels ${JSON.stringify(answer.labels)}.`);
  io.out(`Configuration and credential are in ${state.dir}. Start the agent with "home-compute-agent run".`);
  return 0;
}

async function commandRun(options, io) {
  const state = stateFrom(options);
  const { config, credential } = await loadEnrolled(state);
  const runtime = createRuntime(config);
  const agent = new Agent({ state, config, credential, runtime, fetch: io.fetch });
  await agent.start();
  let statusServer = null;
  if (config.statusPort) {
    try {
      statusServer = await startStatusServer({ agent, token: await state.statusToken(), port: config.statusPort });
    } catch (error) {
      jsonLog("status_server_error", { port: config.statusPort, error: error.message });
    }
  }
  const stop = (signal) => {
    jsonLog("stopping", { signal });
    agent.stop();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  jsonLog("started", { version: AGENT_VERSION, protocol: PROTOCOL, machine: config.name, server: config.server, runtime: config.runtime,
    statusPort: statusServer?.port ?? null });
  await agent.run();
  await statusServer?.close();
  jsonLog("stopped", { runs: agent.runs.size });
  return 0;
}

async function commandStatus(options, io) {
  const state = stateFrom(options);
  const config = await state.loadConfig();
  if (!config) {
    io.out(`Not enrolled (no configuration in ${state.dir}).`);
    return 1;
  }
  const live = await localStatus(state, config);
  if (options.json) {
    io.out(JSON.stringify(live ?? { running: false, name: config.name, machineId: config.machineId, server: config.server }, null, 2));
    return live ? 0 : 1;
  }
  io.out(`${config.name} (${config.machineId}) → ${config.server}`);
  if (!live) {
    io.out("The agent is not running (its status server did not answer).");
    return 1;
  }
  io.out(`connection: ${live.connection}; last sync ${ago(live.lastSyncAt)}; next ${ago(live.nextSyncAt)}; clock skew ${live.clockSkewMs ?? "?"} ms`);
  io.out(`drain: ${live.drain ? "on" : "off"}; runtime ${live.runtime.kind}: ${live.runtime.ok ? "ok" : `not ok (${live.runtime.lastError})`}`);
  if (live.lastError) io.out(`last error: ${live.lastError}`);
  for (const run of live.runs) io.out(`run ${run.id} ${run.job}: ${run.phase} since ${run.since}${run.waitingToReport ? " (result waiting to send)" : ""}`);
  io.out(`outbox: ${live.outbox}; upcoming: ${live.upcoming.map((entry) => `${entry.jobId} at ${new Date(entry.dueAt).toISOString()}`).join(", ") || "none"}`);
  return 0;
}

/** Checks the setup step by step; exits 1 if anything failed. */
async function commandDoctor(options, io) {
  const state = stateFrom(options);
  let failed = false;
  const report = (status, text) => {
    if (status === "FAIL") failed = true;
    io.out(`${status.padEnd(4)} ${text}`);
  };
  const config = await state.loadConfig().catch((error) => {
    report("FAIL", `configuration: ${error.message}`);
    return null;
  });
  if (!config) {
    report("FAIL", `not enrolled: no configuration in ${state.dir}`);
    return 1;
  }
  report("ok", `configuration: ${config.name} (${config.machineId}), runtime ${config.runtime}, state in ${state.dir}`);
  const problems = await state.permissionProblems();
  if (problems.length) for (const problem of problems) report("FAIL", `${problem.file} is mode ${problem.mode}; it must be ${problem.expected}`);
  else report("ok", "state directory 0700, files 0600");
  const credential = await state.readCredential();
  report(credential ? "ok" : "FAIL", credential ? "credential present" : "no credential: enrol again");
  if (config.allowImages.includes("*")) report("warn", "allowImages is \"*\": any image the control plane names may run; narrow it, e.g. [\"ghcr.io/you/*\"]");
  let runtime = null;
  try {
    runtime = createRuntime(config);
    const facts = await runtime.facts();
    report("ok", `runtime ${facts.kind} ${facts.version}: ${facts.cpus} CPU, ${facts.memoryMiB} MiB, ${facts.diskFreeMiB} MiB disk free`);
  } catch (error) {
    report("FAIL", `runtime: ${error.message}`);
  }
  const client = new ControlPlaneClient({ server: config.server, credential: () => credential, fetch: io.fetch });
  try {
    await client.health();
    report("ok", `control plane ${config.server} answers`);
  } catch (error) {
    report("FAIL", `control plane: ${error.message}`);
    return 1;
  }
  const live = await localStatus(state, config);
  if (live) {
    report(live.connection === "online" ? "ok" : "FAIL", `the agent service is running: ${live.connection}, last sync ${ago(live.lastSyncAt)}`);
    if (live.clockSkewWarning) report("warn", `clock skew ${live.clockSkewMs} ms (more than 30 s)`);
  } else if (credential) {
    try {
      const sentAt = Date.now();
      const { body } = await client.sync({
        agentVersion: AGENT_VERSION, agentTime: sentAt, runs: [], claim: false,
        machine: { drain: false, vm: { kind: config.runtime, state: null }, free: {}, health: { docker: runtime ? "ok" : "unreachable" } },
      });
      const skew = Math.round((sentAt + Date.now()) / 2 - body.serverTime);
      report("ok", `first sync accepted the credential (the agent service is not running); clock skew ${skew} ms`);
      if (Math.abs(skew) > 30_000) report("warn", `clock skew ${skew} ms is more than 30 s`);
    } catch (error) {
      report("FAIL", `sync: ${error.message}${error.kind === "revoked" ? " (this machine's credential was revoked: enrol again)" : ""}`);
    }
  }
  return failed ? 1 : 0;
}

/** Runs one command; returns its exit code. `io` is for tests. */
export async function main(argv = process.argv.slice(2), io = {}) {
  const streams = {
    out: io.out ?? ((text) => process.stdout.write(`${text}\n`)),
    error: io.error ?? ((text) => process.stderr.write(`${text}\n`)),
    stdin: io.stdin ?? process.stdin,
    fetch: io.fetch ?? globalThis.fetch,
  };
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    streams.error(error.message);
    return 2;
  }
  const [command] = options._;
  try {
    if (!command || options.help || command === "help") {
      streams.out(USAGE);
      return command || options.help ? 0 : 2;
    }
    if (command === "version") {
      streams.out(`${AGENT_VERSION} (protocol ${PROTOCOL})`);
      return 0;
    }
    if (command === "enrol" || command === "enroll") return await commandEnrol(options, streams);
    if (command === "run") return await commandRun(options, streams);
    if (command === "status") return await commandStatus(options, streams);
    if (command === "doctor") return await commandDoctor(options, streams);
    streams.error(`Unknown command ${command}\n\n${USAGE}`);
    return 2;
  } catch (error) {
    streams.error(`home-compute-agent ${command}: ${error.message}`);
    return 1;
  }
}

function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exitCode = await main();

// The shapes of agent requests (§4.2, §7), checked before hc-core trusts any
// of it. An agent is authenticated but still only a machine: every figure is
// bounded, every string cut, and anything unexpected refused with a 400.

import { ACTIVE_STATES } from "../../src/core/run.mjs";
import { FINAL_TAIL, MAX_ERROR_DETAIL, RUN_ID, RUNNING_TAIL } from "../../src/core/protocol.mjs";
import { HttpError } from "./http.mjs";

const MAX_RUNS_PER_SYNC = 32;
const MAX_REPORTS = 500;

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function bad(message) {
  return new HttpError(400, message);
}

function object(value, name) {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw bad(`${name} must be an object`);
  return value;
}

function number(value, name, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER, integer = false } = {}) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
    throw bad(`${name} must be a number from ${minimum} to ${maximum}`);
  }
  return value;
}

function text(value, name, maximum) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw bad(`${name} must be a string`);
  return value.length > maximum ? value.slice(0, maximum) : value;
}

function flag(value, name) {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw bad(`${name} must be true or false`);
  return value;
}

/** A small JSON object (facts, health, vm) kept as it is, within a size limit. */
function smallObject(value, name, maxChars = 2048) {
  const result = object(value, name);
  if (JSON.stringify(result).length > maxChars) throw bad(`${name} is too large`);
  return result;
}

function runId(value, name) {
  if (typeof value !== "string" || !RUN_ID.test(value)) throw bad(`${name} must be a run id`);
  return value;
}

/**
 * A figure the agent only reports (free capacity): clamped into range rather
 * than refused, because a refused sync renews no lease and the same body
 * would be refused on every retry.
 */
function advisory(value, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(maximum, Math.max(0, value));
}

function free(value) {
  const input = isObject(value) ? value : {};
  return {
    cpus: advisory(input.cpus, 1024),
    memoryMiB: advisory(input.memoryMiB, 1024 * 1024 * 1024),
    diskMiB: advisory(input.diskMiB, 1024 * 1024 * 1024),
    runs: advisory(input.runs, 1024) === null ? null : Math.floor(advisory(input.runs, 1024)),
  };
}

/** Health and VM state as reported, cut to what fits rather than refused: short strings, numbers, booleans. */
function report(value, maxChars) {
  const result = {};
  for (const [key, item] of Object.entries(isObject(value) ? value : {}).slice(0, 20)) {
    if (typeof item === "string") result[key.slice(0, 40)] = item.slice(0, 300);
    else if (typeof item === "number" || typeof item === "boolean" || item === null) result[key.slice(0, 40)] = item;
  }
  return JSON.stringify(result).length > maxChars ? {} : result;
}

function logTail(value, name, bounds) {
  if (value === undefined || value === null) return null;
  const input = object(value, name);
  const tail = text(input.text, `${name}.text`, bounds.bytes + bounds.lines * 2) ?? "";
  return {
    text: tail,
    bytesTotal: number(input.bytesTotal, `${name}.bytesTotal`, { integer: true }),
    linesTotal: number(input.linesTotal, `${name}.linesTotal`, { integer: true }),
    truncated: flag(input.truncated, `${name}.truncated`),
    errorCount: number(input.errorCount, `${name}.errorCount`, { integer: true }),
  };
}

/** POST /agent/v1/enrol: `{protocol, joinToken, name?, facts?, publicFacts?}`. */
export function parseEnrol(body) {
  const input = object(body, "body");
  return {
    joinToken: text(input.joinToken, "joinToken", 200),
    name: text(input.name, "name", 100),
    facts: smallObject(input.facts, "facts", 4096),
    publicFacts: smallObject(input.publicFacts, "publicFacts", 4096),
  };
}

/** POST /agent/v1/sync (§4.2). */
export function parseSync(body) {
  const input = object(body, "body");
  const machine = object(input.machine, "machine");
  if (input.runs !== undefined && !Array.isArray(input.runs)) throw bad("runs must be an array");
  const runs = (input.runs ?? []).slice(0, MAX_RUNS_PER_SYNC).map((value, index) => {
    const run = object(value, `runs[${index}]`);
    const phase = run.phase ?? null;
    if (phase !== null && !ACTIVE_STATES.includes(phase)) throw bad(`runs[${index}].phase must be one of ${ACTIVE_STATES.join(", ")}`);
    const stats = object(run.stats, `runs[${index}].stats`);
    return {
      id: runId(run.id, `runs[${index}].id`),
      phase,
      phaseAt: number(run.phaseAt, `runs[${index}].phaseAt`),
      stats: {
        peakMemoryBytes: number(stats.peakMemoryBytes, `runs[${index}].stats.peakMemoryBytes`, { integer: true }),
        memoryLimitBytes: number(stats.memoryLimitBytes, `runs[${index}].stats.memoryLimitBytes`, { integer: true }),
        cpuPct: number(stats.cpuPct, `runs[${index}].stats.cpuPct`, { maximum: 100_000 }),
      },
      logTail: logTail(run.logTail, `runs[${index}].logTail`, RUNNING_TAIL),
    };
  });
  return {
    agentVersion: text(input.agentVersion, "agentVersion", 32),
    agentTime: number(input.agentTime, "agentTime"),
    machine: {
      drain: flag(machine.drain, "machine.drain"),
      vm: report(machine.vm, 512),
      free: free(machine.free),
      health: report(machine.health, 2048),
    },
    runs,
    claim: flag(input.claim, "claim"),
  };
}

/** POST /agent/v1/runs/:id/complete: the final record of a run. */
export function parseComplete(body) {
  const input = object(body, "body");
  const stats = object(input.stats, "stats");
  const durations = object(input.durations, "durations");
  const image = object(input.image, "image");
  if (input.reports !== undefined && !Array.isArray(input.reports)) throw bad("reports must be an array");
  const reports = (input.reports ?? []).slice(-MAX_REPORTS).filter((report) => isObject(report) && typeof report.event === "string");
  const exitCode = input.exitCode === undefined || input.exitCode === null ? null
    : number(input.exitCode, "exitCode", { minimum: -1_000_000, maximum: 1_000_000, integer: true });
  return {
    exitCode,
    oomKilled: flag(input.oomKilled, "oomKilled"),
    timedOut: flag(input.timedOut, "timedOut"),
    cancelled: flag(input.cancelled, "cancelled"),
    failed: flag(input.failed, "failed"),
    error: text(input.error, "error", 500),
    errorDetail: text(input.errorDetail, "errorDetail", MAX_ERROR_DETAIL),
    reports,
    logTail: logTail(input.logTail, "logTail", FINAL_TAIL),
    stats: {
      peakMemoryBytes: number(stats.peakMemoryBytes, "stats.peakMemoryBytes", { integer: true }),
      memoryLimitBytes: number(stats.memoryLimitBytes, "stats.memoryLimitBytes", { integer: true }),
      avgCpuPct: number(stats.avgCpuPct, "stats.avgCpuPct", { maximum: 100_000 }),
      peakCpuPct: number(stats.peakCpuPct, "stats.peakCpuPct", { maximum: 100_000 }),
      cpuSeconds: number(stats.cpuSeconds, "stats.cpuSeconds"),
      samples: number(stats.samples, "stats.samples", { integer: true }),
    },
    durations: {
      durationMs: number(durations.durationMs, "durations.durationMs", { integer: true }),
      vmWaitMs: number(durations.vmWaitMs, "durations.vmWaitMs", { integer: true }),
      pullMs: number(durations.pullMs, "durations.pullMs", { integer: true }),
    },
    image: { ref: text(image.ref, "image.ref", 500), digest: text(image.digest, "image.digest", 200) },
  };
}

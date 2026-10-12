// Job definitions: the v1 configuration rules the local controller has always
// applied, and the hosted control plane's job shape. Pure: no `node:` imports,
// so this runs in a Worker, the agent and the CLI alike.

const DURATION = /^(\d+)(s|m|h|d)$/;
export const JOB_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const SECRET_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const LABEL_KEY = /^[a-z0-9][a-z0-9._/-]{0,62}$/i;

export function parseDuration(value) {
  const match = typeof value === "string" && value.match(DURATION);
  if (!match) throw new Error(`Invalid duration ${JSON.stringify(value)}; use 30s, 15m, 2h, or 1d`);
  const amount = Number(match[1]);
  if (amount === 0) throw new Error("Duration must be greater than zero");
  return amount * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
}

function assertString(value, description) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${description} must be a non-empty string`);
}

function assertWholeNumbers(values, maximum, description) {
  if (!Array.isArray(values) || values.length === 0
    || values.some((value) => !Number.isInteger(value) || value < 0 || value > maximum)) {
    throw new Error(`${description} must be a non-empty array of whole numbers from 0 to ${maximum}`);
  }
}

/**
 * A schedule is either an interval from the previous completion (`every`), or
 * wall-clock slots (`at`) for work that follows someone else's timetable, such
 * as a data source that publishes at fixed times. Slots are UTC, the only zone
 * accepted, so a schedule never shifts with daylight saving.
 */
export function validateSchedule(schedule, description) {
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
    throw new Error(`${description} must be an object`);
  }
  if ((schedule.every === undefined) === (schedule.at === undefined)) {
    throw new Error(`${description} needs exactly one of every or at`);
  }
  if (schedule.every !== undefined) {
    parseDuration(schedule.every);
    return;
  }
  const { at } = schedule;
  if (!at || typeof at !== "object" || Array.isArray(at)) throw new Error(`${description}.at must be an object`);
  if (at.hours !== undefined) assertWholeNumbers(at.hours, 23, `${description}.at.hours`);
  if (at.minutes !== undefined) assertWholeNumbers(at.minutes, 59, `${description}.at.minutes`);
  if (schedule.timezone !== undefined && schedule.timezone !== "UTC") {
    throw new Error(`${description}.timezone must be UTC`);
  }
}

export function validateReport(report, description) {
  if (report === undefined) return;
  if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error(`${description} must be an object`);
  if (report.format !== "json-lines") throw new Error(`${description}.format must be json-lines`);
  if (report.trackEvent !== undefined) assertString(report.trackEvent, `${description}.trackEvent`);
  if (report.trackBy !== undefined) assertString(report.trackBy, `${description}.trackBy`);
  if (report.freshness !== undefined && report.freshness !== null) normaliseFreshness(report.freshness, `${description}.freshness`);
}

const TRACKED_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

/**
 * How fresh a job's published output must stay (the stale-output alert):
 * `{"<trackBy value>": {maxAgeHours, url?}}`. The age is that of the newest
 * `run` the job published (a `YYYYMMDDHH` hour or an ISO time), or, with
 * `url`, of the `run` in the JSON document there (a published pointer, which
 * shows the output whichever system produced it). Sorted by value.
 */
export function normaliseFreshness(freshness, description = "report.freshness") {
  if (!freshness || typeof freshness !== "object" || Array.isArray(freshness)) throw new Error(`${description} must be an object`);
  const result = {};
  for (const [value, entry] of Object.entries(freshness).sort(([a], [b]) => a.localeCompare(b))) {
    if (!TRACKED_VALUE.test(value)) throw new Error(`${description}: invalid tracked value ${JSON.stringify(value)}`);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${description}.${value} must be an object`);
    const unknown = Object.keys(entry).filter((key) => !["maxAgeHours", "url"].includes(key));
    if (unknown.length) throw new Error(`${description}.${value}: unknown field ${unknown.join(", ")}`);
    const hours = entry.maxAgeHours;
    if (typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0 || hours > 24 * 90) {
      throw new Error(`${description}.${value}.maxAgeHours must be a number of hours above 0 and at most 2160`);
    }
    if (entry.url !== undefined && (typeof entry.url !== "string" || !/^https:\/\/[^\s/]+\/\S*$/.test(entry.url) || entry.url.length > 500)) {
      throw new Error(`${description}.${value}.url must be an https:// URL`);
    }
    result[value] = { maxAgeHours: hours, ...(entry.url ? { url: entry.url } : {}) };
  }
  return result;
}

/** The names of the environment variables a v1 job is given, optional ones first. */
export function jobEnvironmentNames(job) {
  return [...new Set([...(job.task.passEnv ?? []), ...(job.task.requiredEnv ?? [])])];
}

// ---------- The hosted job definition (the `jobs` table, §2 of docs/hosted-control-plane.md)

export const OVERLAP = ["coalesce", "skip"];
export const CATCH_UP = ["latest", "none"];
export const NETWORKS = ["bridge", "none"];
export const DEFAULT_RETRY = { maxAttempts: 3, onLostRunning: false, lostGraceSeconds: 600, onFailed: 0, backoffSeconds: 300 };

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function objectOf(value, description) {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw new Error(`${description} must be an object`);
  return value;
}

function strings(value, description, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string") || (nonEmpty && !value.length)) {
    throw new Error(`${description} must be ${nonEmpty ? "a non-empty" : "an"} array of strings`);
  }
  return [...value];
}

function wholeNumber(value, description, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${description} must be a whole number from ${minimum} to ${maximum}`);
  }
  return value;
}

function flag(value, description, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${description} must be true or false`);
  return value;
}

function oneOf(value, allowed, description, fallback) {
  if (value === undefined) return fallback;
  if (!allowed.includes(value)) throw new Error(`${description} must be one of ${allowed.join(", ")}`);
  return value;
}

function sortedUnique(values) {
  return [...new Set(values)].sort((a, b) => a - b);
}

/** A schedule in its canonical form: `{at: {hours?, minutes}}`, `{every}` or null (manual runs only). */
export function normaliseSchedule(schedule, description = "schedule") {
  if (schedule === undefined || schedule === null) return null;
  validateSchedule(schedule, description);
  if (schedule.every !== undefined) return { every: schedule.every };
  const at = {};
  if (schedule.at.hours !== undefined) at.hours = sortedUnique(schedule.at.hours);
  at.minutes = sortedUnique(schedule.at.minutes ?? [0]);
  return { at };
}

function normaliseEnv(env, description) {
  const result = {};
  for (const [name, value] of Object.entries(objectOf(env, description)).sort(([a], [b]) => a.localeCompare(b))) {
    if (!ENV_NAME.test(name)) throw new Error(`${description}: invalid environment name ${JSON.stringify(name)}`);
    if (typeof value !== "string") throw new Error(`${description}.${name} must be a string`);
    result[name] = value;
  }
  return result;
}

/** `NAME -> "vault:<secret>" | "local:<NAME>"`: references only, never values. */
function normaliseSecretEnv(secretEnv, description) {
  const result = {};
  for (const [name, reference] of Object.entries(objectOf(secretEnv, description)).sort(([a], [b]) => a.localeCompare(b))) {
    if (!ENV_NAME.test(name)) throw new Error(`${description}: invalid environment name ${JSON.stringify(name)}`);
    const match = typeof reference === "string" && reference.match(/^(vault|local):(.+)$/);
    const valid = match && (match[1] === "vault" ? SECRET_NAME.test(match[2]) : ENV_NAME.test(match[2]));
    if (!valid) throw new Error(`${description}.${name} must be "vault:<secret-name>" or "local:<ENV_NAME>"`);
    result[name] = reference;
  }
  return result;
}

/** Labels as `{key: value}` strings, sorted by key. */
export function normaliseLabels(labels, description = "labels") {
  const result = {};
  for (const [key, value] of Object.entries(objectOf(labels, description)).sort(([a], [b]) => a.localeCompare(b))) {
    if (!LABEL_KEY.test(key)) throw new Error(`${description}: invalid label ${JSON.stringify(key)}`);
    if (typeof value !== "string") throw new Error(`${description}.${key} must be a string`);
    result[key] = value;
  }
  return result;
}

function normaliseResources(resources) {
  const value = objectOf(resources, "resources");
  const cpus = value.cpus ?? 1;
  if (typeof cpus !== "number" || !Number.isFinite(cpus) || cpus <= 0 || cpus > 64) {
    throw new Error("resources.cpus must be a number above 0 and at most 64");
  }
  return {
    cpus,
    memoryMiB: wholeNumber(value.memoryMiB ?? 2048, "resources.memoryMiB", { minimum: 16, maximum: 1024 * 1024 }),
    diskMiB: wholeNumber(value.diskMiB ?? 2048, "resources.diskMiB", { minimum: 1, maximum: 16 * 1024 * 1024 }),
  };
}

function normaliseTimeouts(timeouts) {
  const value = objectOf(timeouts, "timeouts");
  const lateness = value.maxLatenessSeconds ?? null;
  return {
    runSeconds: wholeNumber(value.runSeconds ?? 3600, "timeouts.runSeconds", { minimum: 1, maximum: 7 * 86_400 }),
    maxLatenessSeconds: lateness === null ? null
      : wholeNumber(lateness, "timeouts.maxLatenessSeconds", { minimum: 1, maximum: 30 * 86_400 }),
  };
}

function normalisePlacement(placement) {
  const value = objectOf(placement, "placement");
  const result = {};
  const labels = normaliseLabels(value.requireLabels, "placement.requireLabels");
  if (Object.keys(labels).length) result.requireLabels = labels;
  if (value.preferMachines !== undefined) {
    const machines = strings(value.preferMachines, "placement.preferMachines");
    if (machines.length) result.preferMachines = machines;
  }
  if (value.preferWaitSeconds !== undefined) {
    result.preferWaitSeconds = wholeNumber(value.preferWaitSeconds, "placement.preferWaitSeconds", { maximum: 86_400 });
  }
  return result;
}

function normalisePolicy(policy) {
  const value = objectOf(policy, "policy");
  const retry = objectOf(value.retry, "policy.retry");
  return {
    overlap: oneOf(value.overlap, OVERLAP, "policy.overlap", "coalesce"),
    catchUp: oneOf(value.catchUp, CATCH_UP, "policy.catchUp", "latest"),
    retry: {
      maxAttempts: wholeNumber(retry.maxAttempts ?? DEFAULT_RETRY.maxAttempts, "policy.retry.maxAttempts", { minimum: 1, maximum: 10 }),
      onLostRunning: flag(retry.onLostRunning, "policy.retry.onLostRunning", DEFAULT_RETRY.onLostRunning),
      lostGraceSeconds: wholeNumber(retry.lostGraceSeconds ?? DEFAULT_RETRY.lostGraceSeconds, "policy.retry.lostGraceSeconds", { maximum: 86_400 }),
      onFailed: wholeNumber(retry.onFailed ?? DEFAULT_RETRY.onFailed, "policy.retry.onFailed", { maximum: 10 }),
      backoffSeconds: wholeNumber(retry.backoffSeconds ?? DEFAULT_RETRY.backoffSeconds, "policy.retry.backoffSeconds", { maximum: 86_400 }),
    },
    priority: wholeNumber(value.priority ?? 0, "policy.priority", { minimum: -100, maximum: 100 }),
  };
}

/** The fields of a definition, in the order they are stored and compared. */
export const JOB_FIELDS = [
  "description", "enabled", "image", "entrypoint", "args", "env", "secretEnv", "resources", "timeouts",
  "schedule", "placement", "policy", "report", "network", "labels", "registryAuth",
];

/**
 * A hosted job definition, checked and in canonical form: every field
 * present, defaults filled in and keys in a fixed order, so two definitions
 * are equal exactly when their JSON is. Operator state (`paused`) and
 * bookkeeping (`revision`, timestamps) are not part of it.
 */
export function normaliseJob(input) {
  if (!isObject(input)) throw new Error("A job must be an object");
  if (!JOB_ID.test(input.id ?? "")) throw new Error(`Invalid job id ${JSON.stringify(input.id)}`);
  const id = input.id;
  if (input.description !== undefined && input.description !== null) assertString(input.description, "description");
  assertString(input.image, "image");
  if (/\s/.test(input.image)) throw new Error("image must not contain spaces");
  if (input.report !== undefined && input.report !== null) validateReport(input.report, "report");
  const entrypoint = input.entrypoint === undefined || input.entrypoint === null
    ? null : strings(input.entrypoint, "entrypoint", { nonEmpty: true });
  const env = normaliseEnv(input.env, "env");
  const secretEnv = normaliseSecretEnv(input.secretEnv, "secretEnv");
  const both = Object.keys(env).filter((name) => name in secretEnv);
  if (both.length) throw new Error(`${both.join(", ")} cannot be both env and secretEnv`);
  const freshness = input.report?.freshness ? normaliseFreshness(input.report.freshness) : {};
  const report = input.report ? {
    format: "json-lines",
    ...(input.report.trackEvent ? { trackEvent: input.report.trackEvent } : {}),
    ...(input.report.trackBy ? { trackBy: input.report.trackBy } : {}),
    ...(Object.keys(freshness).length ? { freshness } : {}),
  } : null;
  return {
    id,
    description: input.description ?? null,
    enabled: flag(input.enabled, "enabled", true),
    image: input.image,
    entrypoint,
    args: input.args === undefined ? [] : strings(input.args, "args"),
    env,
    secretEnv,
    resources: normaliseResources(input.resources),
    timeouts: normaliseTimeouts(input.timeouts),
    schedule: normaliseSchedule(input.schedule),
    placement: normalisePlacement(input.placement),
    policy: normalisePolicy(input.policy),
    report,
    network: oneOf(input.network, NETWORKS, "network", "bridge"),
    labels: normaliseLabels(input.labels, "labels"),
    registryAuth: normaliseRegistryAuth(input.registryAuth),
  };
}

/** A private registry's credential: `"vault:<secret>"` (its value `{server, username, password}`), or null. */
function normaliseRegistryAuth(reference) {
  if (reference === undefined || reference === null) return null;
  const match = typeof reference === "string" && reference.match(/^vault:(.+)$/);
  if (!match || !SECRET_NAME.test(match[1])) throw new Error('registryAuth must be "vault:<secret-name>" or null');
  return reference;
}

/** The fields whose values differ between two normalised definitions, with both values; every field for a new job. */
export function jobDifferences(before, after) {
  return JOB_FIELDS
    .filter((field) => !before || JSON.stringify(before[field] ?? null) !== JSON.stringify(after?.[field] ?? null))
    .map((field) => ({ field, before: before?.[field] ?? null, after: after?.[field] ?? null }));
}

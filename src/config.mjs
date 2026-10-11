import { readFile } from "node:fs/promises";
import path from "node:path";

const DURATION = /^(\d+)(s|m|h|d)$/;
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

export function parseDuration(value) {
  const match = typeof value === "string" && value.match(DURATION);
  if (!match) throw new Error(`Invalid duration ${JSON.stringify(value)}; use 30s, 15m, 2h, or 1d`);
  const amount = Number(match[1]);
  if (amount === 0) throw new Error("Duration must be greater than zero");
  return amount * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
}

export async function readEnvFile(filename) {
  if (!filename) return {};
  const text = await readFile(filename, "utf8");
  const values = {};
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals < 1) throw new Error(`${filename}:${index + 1}: expected NAME=value`);
    const name = line.slice(0, equals).trim();
    if (!ENV_NAME.test(name)) throw new Error(`${filename}:${index + 1}: invalid environment name`);
    let value = line.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return values;
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

function validateReport(report, description) {
  if (report === undefined) return;
  if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error(`${description} must be an object`);
  if (report.format !== "json-lines") throw new Error(`${description}.format must be json-lines`);
  if (report.trackEvent !== undefined) assertString(report.trackEvent, `${description}.trackEvent`);
  if (report.trackBy !== undefined) assertString(report.trackBy, `${description}.trackBy`);
}

export function validateConfig(config, filename = "configuration") {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`${filename} must contain an object`);
  if (!Array.isArray(config.jobs) || config.jobs.length === 0) throw new Error(`${filename} must define at least one job`);
  const ids = new Set();
  for (const job of config.jobs) {
    if (!job || typeof job !== "object") throw new Error("Each job must be an object");
    if (!ID.test(job.id ?? "")) throw new Error(`Invalid job id ${JSON.stringify(job.id)}`);
    if (ids.has(job.id)) throw new Error(`Duplicate job id ${job.id}`);
    ids.add(job.id);
    validateSchedule(job.schedule, `${job.id}.schedule`);
    if (job.description !== undefined) assertString(job.description, `${job.id}.description`);
    assertString(job.task?.image, `${job.id}.task.image`);
    validateReport(job.task.report, `${job.id}.task.report`);
    if (job.task.parameters !== undefined && !Array.isArray(job.task.parameters)) {
      throw new Error(`${job.id}.task.parameters must be an array`);
    }
    if (job.task.entrypoint !== undefined && (!Array.isArray(job.task.entrypoint) || job.task.entrypoint.length === 0)) {
      throw new Error(`${job.id}.task.entrypoint must be a non-empty array`);
    }
    for (const name of [...(job.task.passEnv ?? []), ...(job.task.requiredEnv ?? [])]) {
      if (!ENV_NAME.test(name)) throw new Error(`${job.id}: invalid environment name ${JSON.stringify(name)}`);
    }
  }
  if (config.pollEvery !== undefined) parseDuration(config.pollEvery);
  if (config.api !== undefined) {
    if (!config.api || typeof config.api !== "object" || Array.isArray(config.api)) {
      throw new Error(`${filename}.api must be an object`);
    }
    if (config.api.host !== undefined) assertString(config.api.host, `${filename}.api.host`);
    if (config.api.port !== undefined && (!Number.isInteger(config.api.port) || config.api.port < 0 || config.api.port > 65535)) {
      throw new Error(`${filename}.api.port must be an integer from 0 to 65535`);
    }
    if (config.api.tokenEnv !== undefined && !ENV_NAME.test(config.api.tokenEnv)) {
      throw new Error(`${filename}.api.tokenEnv must be an environment variable name`);
    }
  }
  validateExtensions(config, filename);
  return config;
}

function assertObject(value, description) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${description} must be an object`);
}

function assertStrings(values, description) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value.trim())) {
    throw new Error(`${description} must be an array of non-empty strings`);
  }
}

/** The optional history, dashboard and timetable sections. */
function validateExtensions(config, filename) {
  if (config.history !== undefined) {
    assertObject(config.history, `${filename}.history`);
    const { keep } = config.history;
    if (keep !== undefined && (!Number.isInteger(keep) || keep < 1 || keep > 1000)) {
      throw new Error(`${filename}.history.keep must be a whole number from 1 to 1000`);
    }
  }
  if (config.dashboard !== undefined) {
    const { dashboard } = config;
    assertObject(dashboard, `${filename}.dashboard`);
    if (dashboard.enabled !== undefined && typeof dashboard.enabled !== "boolean") {
      throw new Error(`${filename}.dashboard.enabled must be true or false`);
    }
    if (dashboard.allowedLogins !== undefined) assertStrings(dashboard.allowedLogins, `${filename}.dashboard.allowedLogins`);
    if (dashboard.allowedLoginsEnv !== undefined && !ENV_NAME.test(dashboard.allowedLoginsEnv)) {
      throw new Error(`${filename}.dashboard.allowedLoginsEnv must be an environment variable name`);
    }
    if (dashboard.hosts !== undefined) assertStrings(dashboard.hosts, `${filename}.dashboard.hosts`);
    if (dashboard.sessionHours !== undefined
      && (typeof dashboard.sessionHours !== "number" || dashboard.sessionHours <= 0 || dashboard.sessionHours > 24 * 90)) {
      throw new Error(`${filename}.dashboard.sessionHours must be a number of hours up to 2160`);
    }
  }
  if (config.timetable !== undefined) {
    const { timetable } = config;
    assertObject(timetable, `${filename}.timetable`);
    if (!Array.isArray(timetable.command) || timetable.command.length === 0) {
      throw new Error(`${filename}.timetable.command must be a non-empty array: [program, arguments...]`);
    }
    assertStrings(timetable.command, `${filename}.timetable.command`);
    if (timetable.command.some((part) => part.includes("\0"))) throw new Error(`${filename}.timetable.command must not contain NUL`);
    // A bare name would be looked up on PATH; the program must be named by its path.
    if (!timetable.command[0].includes("/")) {
      throw new Error(`${filename}.timetable.command[0] must be a path, such as ./macmini.sh or /usr/local/bin/edit-timetable`);
    }
    const { timeoutSeconds } = timetable;
    if (timeoutSeconds !== undefined && (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600)) {
      throw new Error(`${filename}.timetable.timeoutSeconds must be a whole number from 1 to 600`);
    }
  }
}

/** The dashboard's settings, with an allow-list kept out of the configuration in an environment variable. */
export function dashboardSettings(config, environment) {
  const dashboard = config.dashboard ?? {};
  const fromEnvironment = dashboard.allowedLoginsEnv
    ? String(environment[dashboard.allowedLoginsEnv] ?? "").split(/[\s,]+/).filter(Boolean)
    : [];
  return { ...dashboard, allowedLogins: [...(dashboard.allowedLogins ?? []), ...fromEnvironment] };
}

/** Sections a running controller cannot change without a restart. */
const RESTART_KEYS = ["pollEvery", "stateFile", "envFile", "api", "bacalhau", "dashboard", "history", "timetable"];

/**
 * What a reload of `next` over `current` changes. Only jobs are applied in
 * place; any other section that differs is named in `restartRequired`.
 */
export function configDifferences(current, next) {
  const before = new Map(current.jobs.map((job) => [job.id, JSON.stringify(job)]));
  const after = new Map(next.jobs.map((job) => [job.id, JSON.stringify(job)]));
  return {
    added: [...after.keys()].filter((id) => !before.has(id)),
    removed: [...before.keys()].filter((id) => !after.has(id)),
    changed: [...after.keys()].filter((id) => before.has(id) && before.get(id) !== after.get(id)),
    restartRequired: RESTART_KEYS.filter((key) => JSON.stringify(current[key]) !== JSON.stringify(next[key])),
  };
}

export async function loadConfig(filename) {
  const absolute = path.resolve(filename);
  const config = JSON.parse(await readFile(absolute, "utf8"));
  validateConfig(config, absolute);
  return { ...config, filename: absolute };
}

export function resolveTemplate(value, environment, description) {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => {
    if (!environment[name]) throw new Error(`${description} requires ${name}`);
    return environment[name];
  });
}

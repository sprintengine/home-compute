// The D1 repository: rows to objects and back, settings and audit rows.
// Statements that write many rows take one JSON parameter and expand it with
// json_each, so a 21-job import is a handful of queries, not one per row
// (D1 allows 50 queries per invocation on the Free plan, and 100 bound
// parameters per query).

import { normaliseJob } from "../../src/core/job.mjs";
import { ACTIVE_STATES, NON_TERMINAL_STATES } from "../../src/core/run.mjs";
import { previousSlot } from "../../src/core/schedule.mjs";

export const MINUTE = 60_000;

const JSON_FIELDS = {
  entrypoint: "entrypoint_json", args: "args_json", env: "env_json", secretEnv: "secret_env_json",
  resources: "resources_json", timeouts: "timeouts_json", schedule: "schedule_json", placement: "placement_json",
  policy: "policy_json", report: "report_json", labels: "labels_json",
};
export const JOB_COLUMNS = [
  "id", "description", "enabled", "paused", "image", ...Object.values(JSON_FIELDS), "network", "preset",
  "revision", "created_at", "updated_at", "updated_by",
];

/** SQL text for a list of states: `'a','b'` (the states are constants, never input). */
export function stateList(states) {
  return states.map((state) => `'${state}'`).join(",");
}
export const ACTIVE_SQL = stateList(ACTIVE_STATES);
export const NON_TERMINAL_SQL = stateList(NON_TERMINAL_STATES);

function parse(text, fallback = null) {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** A `jobs` row as a definition plus its operator state and bookkeeping. */
export function jobFromRow(row) {
  const definition = {
    id: row.id,
    description: row.description ?? null,
    enabled: row.enabled === 1,
    image: row.image,
    network: row.network,
  };
  for (const [field, column] of Object.entries(JSON_FIELDS)) definition[field] = parse(row[column]);
  return {
    ...normaliseJob(definition),
    paused: row.paused === 1,
    preset: row.preset ?? null,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by ?? null,
  };
}

/** A definition as `jobs` column values (paused and bookkeeping supplied by the caller). */
export function jobToRow(job, { paused = false, preset = null, revision = 1, createdAt, updatedAt, updatedBy }) {
  const row = {
    id: job.id,
    description: job.description ?? null,
    enabled: job.enabled ? 1 : 0,
    paused: paused ? 1 : 0,
    image: job.image,
    network: job.network,
    preset,
    revision,
    created_at: createdAt,
    updated_at: updatedAt,
    updated_by: updatedBy ?? null,
  };
  for (const [field, column] of Object.entries(JSON_FIELDS)) {
    row[column] = job[field] === null || job[field] === undefined ? null : JSON.stringify(job[field]);
  }
  return row;
}

function camel(name) {
  return name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/** A `runs` row as an object: camelCase, JSON columns parsed, flags as booleans. */
export function runFromRow(row) {
  const run = {};
  for (const [column, value] of Object.entries(row)) {
    if (column.endsWith("_json")) run[camel(column.slice(0, -5))] = parse(value);
    else run[camel(column)] = value;
  }
  for (const flag of ["oomKilled", "timedOut", "recovered"]) if (flag in run) run[flag] = run[flag] === null ? null : run[flag] === 1;
  return run;
}

export async function loadJob(db, id) {
  const row = await db.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first();
  return row ? jobFromRow(row) : null;
}

export async function loadJobs(db) {
  const { results } = await db.prepare("SELECT * FROM jobs ORDER BY id").all();
  return results.map(jobFromRow);
}

// ---------- Settings

/** Settings by key, parsed. A missing key is undefined. */
export async function readSettings(db, keys) {
  const placeholders = keys.map(() => "?").join(",");
  const { results } = await db.prepare(`SELECT key, value_json FROM settings WHERE key IN (${placeholders})`).bind(...keys).all();
  return Object.fromEntries(results.map((row) => [row.key, parse(row.value_json)]));
}

export function putSetting(db, key, value) {
  return db.prepare("INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .bind(key, JSON.stringify(value));
}

/**
 * `jobs_version` goes up on every job or settings write, so clients (and,
 * from M2, hc-core's cached job set) know to read again.
 */
export function bumpJobsVersion(db) {
  return db.prepare(`INSERT INTO settings (key, value_json) VALUES ('jobs_version', '1')
    ON CONFLICT(key) DO UPDATE SET value_json = CAST(CAST(value_json AS INTEGER) + 1 AS TEXT)`);
}

// ---------- Audit

/** One audit row; returned as a statement so it commits with the change it describes. */
export function auditStatement(db, { at, actor, action, target = null, before = null, after = null, ip = null }) {
  return db.prepare("INSERT INTO audit_log (at, actor, action, target, before_json, after_json, ip) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(at, actor, action, target, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), ip);
}

/** Many audit rows in one statement. */
export function auditManyStatement(db, entries) {
  const rows = entries.map((entry) => ({
    at: entry.at, actor: entry.actor, action: entry.action, target: entry.target ?? null,
    before_json: entry.before === undefined || entry.before === null ? null : JSON.stringify(entry.before),
    after_json: entry.after === undefined || entry.after === null ? null : JSON.stringify(entry.after),
    ip: entry.ip ?? null,
  }));
  return db.prepare(`INSERT INTO audit_log (at, actor, action, target, before_json, after_json, ip)
    SELECT value->>'at', value->>'actor', value->>'action', value->>'target', value->>'before_json', value->>'after_json', value->>'ip'
    FROM json_each(?)`).bind(JSON.stringify(rows));
}

// ---------- Jobs

/**
 * Where a new (or rescheduled) job's timetable starts: its latest slot is
 * counted as already passed, so creating or importing a job never runs it at
 * once (Run now does that), and moving a slot earlier does not fire the one
 * just moved past. An interval job counts from now.
 */
export function initialLastSlot(schedule, now) {
  if (!schedule) return null;
  if (schedule.at) return previousSlot(schedule.at, now);
  return Math.floor(now / MINUTE) * MINUTE;
}

/** Inserts or replaces many jobs (with `revision + 1` on replace) and seeds their schedule state. */
export function upsertJobsStatements(db, jobs, { now, actor, preset = null, paused = false }) {
  const rows = jobs.map((job) => jobToRow(job, { paused, preset, createdAt: now, updatedAt: now, updatedBy: actor }));
  const columns = JOB_COLUMNS.join(", ");
  const values = JOB_COLUMNS.map((column) => `value->>'${column}'`).join(", ");
  const updates = JOB_COLUMNS.filter((column) => !["id", "paused", "revision", "created_at"].includes(column))
    .map((column) => `${column} = excluded.${column}`).join(", ");
  const states = jobs.map((job) => ({ job_id: job.id, last_slot_at: initialLastSlot(job.schedule, now) }));
  return [
    db.prepare(`INSERT INTO jobs (${columns}) SELECT ${values} FROM json_each(?) WHERE true
      ON CONFLICT(id) DO UPDATE SET ${updates}, revision = jobs.revision + 1`).bind(JSON.stringify(rows)),
    db.prepare(`INSERT INTO schedule_state (job_id, last_slot_at) SELECT value->>'job_id', value->>'last_slot_at' FROM json_each(?) WHERE true
      ON CONFLICT(job_id) DO UPDATE SET last_slot_at = CASE
        WHEN schedule_state.last_slot_at IS NULL OR excluded.last_slot_at > schedule_state.last_slot_at THEN excluded.last_slot_at
        ELSE schedule_state.last_slot_at END`).bind(JSON.stringify(states)),
  ];
}

/**
 * The job's waiting run and its active run, if any. Each half matches a
 * partial unique index's WHERE clause exactly, so SQLite reads at most two
 * rows instead of the job's whole history.
 */
export async function openRuns(db, jobId) {
  const { results } = await db.prepare(`SELECT id, state, due_at FROM runs WHERE job_id = ?1 AND state = 'due'
    UNION ALL SELECT id, state, due_at FROM runs WHERE job_id = ?1 AND state IN (${ACTIVE_SQL})`).bind(jobId).all();
  return {
    due: results.find((run) => run.state === "due") ?? null,
    active: results.find((run) => run.state !== "due") ?? null,
  };
}

// The /v1 handlers behind hc-web. Each mutation commits with its audit row
// in one D1 batch. Handlers stay small: a request is a few indexed reads and
// at most one batch of writes, well inside the 10 ms CPU budget.

import { normaliseGuard } from "../../src/core/cloudflare.mjs";
import { classifyLines, tailLines } from "../../src/core/logs.mjs";
import { newId } from "../../src/core/ids.mjs";
import { jobDifferences, normaliseJob } from "../../src/core/job.mjs";
import { preferredUntil } from "../../src/core/placement.mjs";
import { isTerminal, transition, TransitionError } from "../../src/core/run.mjs";
import { applyTimetable, timetableChange } from "../../src/core/timetable.mjs";
import { bootstrapAdminList, ROLES, rolesRefusal } from "./access.mjs";
import { DEFAULT_RETENTION } from "./cron.mjs";
import {
  auditStatement, bumpJobsVersion, initialLastSlot, JOB_COLUMNS, jobToRow, loadJob, openRuns, putSetting, readSettings,
} from "./db.mjs";
import { empty, HttpError, integerParam, iso, json, readJson } from "./http.mjs";
import { importJobs } from "./importing.mjs";
import { buildSnapshot, clientRun, RUN_LIST_COLUMNS } from "./snapshot.mjs";

const MAX_PARAMETERS = 50;
const LOG_LINES = 500;

function definitionOf(job) {
  const { paused, preset, revision, createdAt, updatedAt, updatedBy, ...definition } = job;
  return definition;
}

/** A job as GET /v1/jobs/:id returns it: the definition, its operator state and bookkeeping. */
function jobView(job) {
  return { ...job, createdAt: iso(job.createdAt), updatedAt: iso(job.updatedAt) };
}

async function requireJob(db, id) {
  const job = await loadJob(db, id);
  if (!job) throw new HttpError(404, `Unknown job ${id}`);
  return job;
}

/** If-Match as a revision number, `"*"`, or null when absent. Accepts `3`, `"3"` and `W/"3"`. */
function ifMatch(request) {
  const raw = request.headers.get("if-match");
  if (raw === null) return null;
  const value = raw.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
  if (value === "*") return "*";
  if (!/^\d+$/.test(value)) throw new HttpError(400, "If-Match must be a job revision");
  return Number(value);
}

function conflict(current) {
  const error = new HttpError(412, `The job has changed: it is at revision ${current}`);
  error.code = "revision_mismatch";
  return error;
}

/** Only the changed fields, before and after, for the audit log. */
function changedFields(differences) {
  return {
    before: Object.fromEntries(differences.map((change) => [change.field, change.before])),
    after: Object.fromEntries(differences.map((change) => [change.field, change.after])),
  };
}

/**
 * Replaces a job's definition if it is still at `revision`. The audit row,
 * the schedule state and the version bump are conditional on the update
 * itself (`changes() = 1`, run in the same transaction), so a lost race
 * writes nothing at all.
 */
async function replaceJob(db, current, next, { now, actor, ip, action }) {
  const row = jobToRow(next, { updatedAt: now, updatedBy: actor });
  const columns = JOB_COLUMNS.filter((column) => !["id", "paused", "preset", "revision", "created_at"].includes(column));
  const differences = jobDifferences(definitionOf(current), next);
  const { before, after } = changedFields(differences);
  const statements = [
    db.prepare(`UPDATE jobs SET ${columns.map((column) => `${column} = ?`).join(", ")}, revision = revision + 1
      WHERE id = ? AND revision = ?`).bind(...columns.map((column) => row[column]), current.id, current.revision),
    db.prepare(`INSERT INTO audit_log (at, actor, action, target, before_json, after_json, ip)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`)
      .bind(now, actor, action, current.id, JSON.stringify(before), JSON.stringify(after), ip),
    db.prepare(`INSERT INTO settings (key, value_json) SELECT 'jobs_version', '1' WHERE changes() = 1
      ON CONFLICT(key) DO UPDATE SET value_json = CAST(CAST(value_json AS INTEGER) + 1 AS TEXT)`),
  ];
  // A changed timetable starts from now: moving a slot earlier must not fire the one just passed.
  if (next.schedule && JSON.stringify(next.schedule) !== JSON.stringify(current.schedule)) {
    statements.push(db.prepare(`UPDATE schedule_state SET last_slot_at = ?1
      WHERE job_id = ?2 AND (last_slot_at IS NULL OR last_slot_at < ?1)
        AND (SELECT revision FROM jobs WHERE id = ?2) = ?3`)
      .bind(initialLastSlot(next.schedule, now), current.id, current.revision + 1));
  }
  const [update] = await db.batch(statements);
  if (update.meta.changes !== 1) throw conflict((await loadJob(db, current.id))?.revision ?? "unknown");
  return { revision: current.revision + 1, differences };
}

// ---------- Jobs

export async function getJob({ db, params }) {
  const job = await requireJob(db, params.id);
  return json(200, jobView(job), { etag: `"${job.revision}"` });
}

/** PUT /v1/jobs/:id: create (no If-Match) or replace (If-Match: its revision). */
export async function putJob({ db, request, params, identity, ip, now }) {
  const body = await readJson(request);
  if (body.id !== undefined && body.id !== params.id) throw new HttpError(400, "The body's id must match the path");
  const next = normaliseJob({ ...body, id: params.id });
  const expected = ifMatch(request);
  const current = await loadJob(db, params.id);
  if (!current) {
    if (expected !== null) throw new HttpError(412, `${params.id} does not exist`);
    const row = jobToRow(next, { createdAt: now, updatedAt: now, updatedBy: identity.actor });
    const insert = await db.batch([
      db.prepare(`INSERT INTO jobs (${JOB_COLUMNS.join(", ")}) VALUES (${JOB_COLUMNS.map(() => "?").join(", ")})
        ON CONFLICT(id) DO NOTHING`).bind(...JOB_COLUMNS.map((column) => row[column])),
      db.prepare(`INSERT INTO audit_log (at, actor, action, target, after_json, ip) SELECT ?, ?, 'job.create', ?, ?, ? WHERE changes() = 1`)
        .bind(now, identity.actor, params.id, JSON.stringify(next), ip),
      db.prepare("INSERT INTO schedule_state (job_id, last_slot_at) VALUES (?, ?) ON CONFLICT(job_id) DO NOTHING")
        .bind(params.id, initialLastSlot(next.schedule, now)),
      bumpJobsVersion(db),
    ]);
    if (insert[0].meta.changes !== 1) throw new HttpError(412, `${params.id} was created meanwhile`);
    return json(201, jobView(await loadJob(db, params.id)), { etag: '"1"' });
  }
  if (expected === null) throw new HttpError(428, "Replacing a job needs If-Match: its revision");
  if (expected !== "*" && expected !== current.revision) throw conflict(current.revision);
  if (!jobDifferences(definitionOf(current), next).length) return json(200, jobView(current), { etag: `"${current.revision}"` });
  await replaceJob(db, current, next, { now, actor: identity.actor, ip, action: "job.update" });
  const saved = await loadJob(db, params.id);
  return json(200, jobView(saved), { etag: `"${saved.revision}"` });
}

/** PATCH (or POST, as the dashboard sends it) /v1/jobs/:id/timetable: `{enabled?, hours?, minutes?}`. */
export async function patchTimetable({ db, request, params, identity, ip, now }) {
  const body = await readJson(request, { maxBytes: 4096 });
  const current = await requireJob(db, params.id);
  const expected = ifMatch(request);
  if (expected !== null && expected !== "*" && expected !== current.revision) throw conflict(current.revision);
  const change = timetableChange(current, body);
  const next = normaliseJob({
    ...definitionOf(current),
    ...(change.enabled !== undefined ? { enabled: change.enabled } : {}),
    schedule: applyTimetable(current.schedule, change),
  });
  let revision = current.revision;
  let differences = [];
  if (jobDifferences(definitionOf(current), next).length) {
    ({ revision, differences } = await replaceJob(db, current, next, { now, actor: identity.actor, ip, action: "job.timetable" }));
  }
  return json(200, {
    ok: true,
    job: current.id,
    changes: body,
    changed: differences.map((difference) => difference.field),
    revision,
    schedule: next.schedule,
    enabled: next.enabled,
    // The local controller's answer named settings needing a restart; nothing here does.
    reload: { restartRequired: [] },
  }, { etag: `"${revision}"` });
}

/**
 * The parts of a definition the dashboard edits on their own (§7): each
 * handler takes only its own fields, merges them into the current
 * definition and saves the whole through normaliseJob, so every rule a PUT
 * checks applies here too.
 */
const DEFINITION_PARTS = {
  // `{requireLabels?, preferMachines?, preferWaitSeconds?}`; a field given as null is removed.
  placement: {
    keys: ["requireLabels", "preferMachines", "preferWaitSeconds"],
    apply: (current, body) => ({ placement: withoutNulls({ ...current.placement, ...body }) }),
  },
  // `{cpus?, memoryMiB?, diskMiB?, instanceType?}`. `instanceType: null` clears it (Cloudflare then uses basic).
  resources: {
    keys: ["cpus", "memoryMiB", "diskMiB", "instanceType"],
    apply: (current, body) => {
      const resources = { ...current.resources, ...withoutNulls(body) };
      if (body.instanceType === null) delete resources.instanceType;
      return { resources };
    },
  },
  // `{image?, registryAuth?}`: a tag or, preferably, `repo@sha256:…` (the "promote tag → digest" button sends that),
  // and the vault secret that pulls it from a private registry (`"vault:<name>"`, null for none).
  image: {
    keys: ["image", "registryAuth"],
    apply: (current, body) => {
      const next = {};
      if (body.image !== undefined) {
        if (typeof body.image !== "string" || !body.image.trim()) throw new HttpError(400, "image must be an image reference");
        next.image = body.image.trim();
      }
      if (body.registryAuth !== undefined) next.registryAuth = body.registryAuth;
      return next;
    },
  },
};

function withoutNulls(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== null && value !== undefined));
}

/** PATCH /v1/jobs/:id/placement | /resources | /image. If-Match is honoured when sent. */
export async function patchDefinition({ db, request, params, identity, ip, now }, part) {
  const { keys, apply } = DEFINITION_PARTS[part];
  const body = await readJson(request, { maxBytes: 8192 });
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "The body must be an object");
  const unknown = Object.keys(body).filter((key) => !keys.includes(key));
  if (unknown.length) throw new HttpError(400, `Unknown ${part} field ${unknown.join(", ")}`);
  if (!Object.keys(body).length) throw new HttpError(400, "Nothing to change");
  const current = await requireJob(db, params.id);
  const expected = ifMatch(request);
  if (expected !== null && expected !== "*" && expected !== current.revision) throw conflict(current.revision);
  const next = normaliseJob({ ...definitionOf(current), ...apply(current, body) });
  let revision = current.revision;
  let differences = [];
  if (jobDifferences(definitionOf(current), next).length) {
    ({ revision, differences } = await replaceJob(db, current, next, { now, actor: identity.actor, ip, action: `job.${part}` }));
  }
  return json(200, {
    ok: true,
    job: current.id,
    changed: differences.map((difference) => difference.field),
    revision,
    [part]: next[part],
  }, { etag: `"${revision}"` });
}

export async function setPaused({ db, params, identity, ip, now }, paused) {
  await requireJob(db, params.id);
  const [update] = await db.batch([
    db.prepare("UPDATE jobs SET paused = ?, updated_at = ?, updated_by = ? WHERE id = ? AND paused != ?")
      .bind(paused ? 1 : 0, now, identity.actor, params.id, paused ? 1 : 0),
    db.prepare(`INSERT INTO audit_log (at, actor, action, target, before_json, after_json, ip) SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`)
      .bind(now, identity.actor, paused ? "job.pause" : "job.resume", params.id,
        JSON.stringify({ paused: !paused }), JSON.stringify({ paused }), ip),
    db.prepare(`INSERT INTO settings (key, value_json) SELECT 'jobs_version', '1' WHERE changes() = 1
      ON CONFLICT(key) DO UPDATE SET value_json = CAST(CAST(value_json AS INTEGER) + 1 AS TEXT)`),
  ]);
  return json(202, { event: paused ? "job_paused" : "job_resumed", job: params.id, changed: update.meta.changes === 1 });
}

/**
 * POST /v1/jobs/:id/run: a manual run, due now. It waits for a machine like
 * any due run. Refused while the job already has a run waiting, or (unless
 * `force`) one running, as the local controller refuses a second submission.
 */
export async function runJob({ db, request, params, identity, ip, now }) {
  const body = await readJson(request, { maxBytes: 16 * 1024 });
  const extra = body.extraParameters ?? [];
  if (!Array.isArray(extra) || extra.length > MAX_PARAMETERS || extra.some((value) => typeof value !== "string" || value.length > 1000)) {
    throw new HttpError(400, `extraParameters must be an array of at most ${MAX_PARAMETERS} strings`);
  }
  if (body.force !== undefined && typeof body.force !== "boolean") throw new HttpError(400, "force must be true or false");
  const job = await requireJob(db, params.id);
  const { due, active } = await openRuns(db, job.id);
  if (due) throw new HttpError(409, `${job.id} already has a run waiting (${due.id})`);
  if (active && !body.force) throw new HttpError(409, `${job.id} already has an active run ${active.id} (${active.state})`);
  const id = newId("r", now);
  const wait = job.placement.preferMachines?.length ? (job.placement.preferWaitSeconds ?? 300) * 1000 : null;
  const [insert] = await db.batch([
    db.prepare(`INSERT INTO runs (id, job_id, job_revision, slot_at, source, state, due_at, preferred_until, parameters_json,
        requested_by, created_at, updated_at)
      VALUES (?1, ?2, ?3, NULL, 'manual', 'due', ?4, ?5, ?6, ?7, ?4, ?4) ON CONFLICT DO NOTHING`)
      .bind(id, job.id, job.revision, now, wait === null ? null : now + wait, extra.length ? JSON.stringify(extra) : null, identity.actor),
    db.prepare(`INSERT INTO audit_log (at, actor, action, target, after_json, ip) SELECT ?, ?, 'job.run', ?, ?, ? WHERE changes() = 1`)
      .bind(now, identity.actor, job.id, JSON.stringify({ runId: id, extraParameters: extra, force: Boolean(body.force) }), ip),
  ]);
  if (insert.meta.changes !== 1) throw new HttpError(409, `${job.id} already has a run waiting`);
  return json(202, { event: "job_submitted", job: job.id, runId: id, source: "manual" });
}

export async function listRuns({ db, params, url }) {
  await requireJob(db, params.id);
  const limit = integerParam(url, "limit", { fallback: 50, minimum: 1, maximum: 200 });
  const before = integerParam(url, "before", { fallback: Number.MAX_SAFE_INTEGER, minimum: 0 });
  // `skipped=0` leaves out skipped slots (a paused job records one per slot), as the dashboard's history does.
  const skipped = url.searchParams.get("skipped") !== "0";
  const [{ results }, names] = await Promise.all([
    db.prepare(`SELECT ${RUN_LIST_COLUMNS}, reports_json FROM runs
      WHERE job_id = ? AND due_at < ? ${skipped ? "" : "AND state != 'skipped'"} ORDER BY due_at DESC LIMIT ?`).bind(params.id, before, limit).all(),
    machineNames(db),
  ]);
  return json(200, {
    job: params.id,
    keep: null,
    runs: results.map((row) => clientRun(row, names)),
    next: results.length === limit ? results.at(-1).due_at : null,
  });
}

async function requireRun(db, id) {
  if (!/^r_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw new HttpError(400, "Invalid run id");
  const row = await db.prepare("SELECT * FROM runs WHERE id = ?").bind(id).first();
  if (!row) throw new HttpError(404, `Unknown run ${id}`);
  return row;
}

/** Machine names by id, revoked ones included (old runs name them). One small read. */
export async function machineNames(db) {
  const { results } = await db.prepare("SELECT id, name FROM machines").all();
  return new Map(results.map((row) => [row.id, row.name]));
}

export async function getRun({ db, params }) {
  const row = await requireRun(db, params.id);
  const machine = row.machine_id ? await db.prepare("SELECT name FROM machines WHERE id = ?").bind(row.machine_id).first() : null;
  return json(200, clientRun(row, machine ? new Map([[row.machine_id, machine.name]]) : null));
}

/** The run's stored log tail (redacted by the agent and again by hc-core), each line with a level. */
export async function runLogs({ db, params, url }) {
  const run = await requireRun(db, params.id);
  const maxLines = integerParam(url, "lines", { fallback: LOG_LINES, minimum: 1, maximum: LOG_LINES });
  const log = await db.prepare("SELECT tail, bytes_total, truncated, final, updated_at FROM run_logs WHERE run_id = ?").bind(run.id).first();
  const tail = tailLines(log?.tail ?? "", maxLines);
  const lines = classifyLines(tail.lines);
  return json(200, {
    runId: run.id,
    job: run.job_id,
    active: !["succeeded", "failed", "timed-out", "cancelled", "skipped", "lost"].includes(run.state),
    fetchedAt: iso(log?.updated_at ?? null),
    bytes: log?.bytes_total ?? 0,
    truncated: Boolean(log?.truncated) || tail.omitted > 0,
    partial: log ? log.final !== 1 : false,
    errorCount: lines.filter((line) => line.level === "error").length,
    lines,
  });
}

/**
 * POST /v1/runs/:id/cancel: a waiting or active run becomes `cancelled`.
 * An agent running it learns on its next sync (the run is in its `cancel`
 * list), stops the container and still sends its final log.
 */
export async function cancelRun({ db, params, identity, ip, now }) {
  const run = await requireRun(db, params.id);
  try {
    transition({ state: run.state }, { type: "cancel", at: now });
  } catch (error) {
    if (error instanceof TransitionError) throw new HttpError(409, `The run is already ${run.state}`);
    throw error;
  }
  const [update] = await db.batch([
    db.prepare(`UPDATE runs SET state = 'cancelled', finished_at = ?1, lease_expires_at = NULL, updated_at = ?1
      WHERE id = ?2 AND state = ?3`).bind(now, run.id, run.state),
    db.prepare(`INSERT INTO audit_log (at, actor, action, target, before_json, after_json, ip) SELECT ?, ?, 'run.cancel', ?, ?, ?, ? WHERE changes() = 1`)
      .bind(now, identity.actor, run.id, JSON.stringify({ state: run.state, machine: run.machine_id }), JSON.stringify({ state: "cancelled" }), ip),
  ]);
  if (update.meta.changes !== 1) throw new HttpError(409, "The run changed meanwhile; look again");
  return json(202, { event: "run_cancelled", runId: run.id, job: run.job_id, previousState: run.state, machine: run.machine_id ?? null });
}

/**
 * POST /v1/runs/:id/retry: a finished (or lost) run again, as a new due run
 * with `attempt + 1` and `retry_of`. Refused while the job has a run waiting,
 * or (unless `force`) one active, as Run now is.
 */
export async function retryRun({ db, request, params, identity, ip, now }) {
  const body = await readJson(request, { maxBytes: 1024 });
  if (body.force !== undefined && typeof body.force !== "boolean") throw new HttpError(400, "force must be true or false");
  const run = await requireRun(db, params.id);
  if (!isTerminal(run.state) && run.state !== "lost") throw new HttpError(409, `The run is still ${run.state}`);
  const job = await requireJob(db, run.job_id);
  const { due, active } = await openRuns(db, job.id);
  if (due) throw new HttpError(409, `${job.id} already has a run waiting (${due.id})`);
  if (active && !body.force) throw new HttpError(409, `${job.id} already has an active run ${active.id} (${active.state})`);
  const id = newId("r", now);
  const [insert] = await db.batch([
    db.prepare(`INSERT INTO runs (id, job_id, job_revision, slot_at, source, state, attempt, retry_of, due_at, preferred_until,
        parameters_json, requested_by, created_at, updated_at)
      VALUES (?1, ?2, ?3, NULL, 'retry', 'due', ?4, ?5, ?6, ?7, ?8, ?9, ?6, ?6) ON CONFLICT DO NOTHING`)
      .bind(id, job.id, job.revision, run.attempt + 1, run.id, now, preferredUntil(job, now), run.parameters_json, identity.actor),
    db.prepare(`INSERT INTO audit_log (at, actor, action, target, after_json, ip) SELECT ?, ?, 'run.retry', ?, ?, ? WHERE changes() = 1`)
      .bind(now, identity.actor, run.id, JSON.stringify({ runId: id, attempt: run.attempt + 1 }), ip),
  ]);
  if (insert.meta.changes !== 1) throw new HttpError(409, `${job.id} already has a run waiting`);
  return json(202, { event: "run_retried", runId: id, retryOf: run.id, job: job.id, attempt: run.attempt + 1 });
}

// ---------- Overview, changes, audit, settings, import

export async function snapshot({ db, now }) {
  return json(200, await buildSnapshot(db, now));
}

/**
 * A cursor over everything the overview shows: the newest run update, the
 * job/settings version, the newest machine heartbeat and the machines'
 * version (drain, labels, revocation). 204 when `since`
 * is still current, so an idle dashboard's poll costs three indexed reads.
 */
export async function changes({ db, url }) {
  const [runs, versions, machines, alerts] = await db.batch([
    db.prepare("SELECT MAX(updated_at) AS at FROM runs"),
    db.prepare("SELECT key, value_json FROM settings WHERE key IN ('jobs_version', 'machines_version', 'secrets_version')"),
    db.prepare("SELECT MAX(COALESCE(last_seen_at, enrolled_at)) AS at FROM machines"),
    // An alert opening or resolving (not its summary's minute-by-minute age).
    db.prepare("SELECT MAX(MAX(opened_at), COALESCE(MAX(resolved_at), 0)) AS at FROM alerts"),
  ]);
  const version = Object.fromEntries(versions.results.map((row) => [row.key, row.value_json]));
  const cursor = [runs.results[0]?.at ?? 0, version.jobs_version ?? "0", machines.results[0]?.at ?? 0, version.machines_version ?? "0",
    version.secrets_version ?? "0", alerts.results[0]?.at ?? 0].join(".");
  if (url.searchParams.get("since") === cursor) return empty(204);
  return json(200, { cursor });
}

export async function audit({ db, url }) {
  const limit = integerParam(url, "limit", { fallback: 50, minimum: 1, maximum: 200 });
  const before = integerParam(url, "before", { fallback: Number.MAX_SAFE_INTEGER, minimum: 0 });
  const { results } = await db.prepare(`SELECT id, at, actor, action, target, before_json, after_json, ip FROM audit_log
    WHERE id < ? ORDER BY id DESC LIMIT ?`).bind(before, limit).all();
  const parse = (text) => (text === null ? null : JSON.parse(text));
  return json(200, {
    entries: results.map((row) => ({
      id: row.id, at: iso(row.at), actor: row.actor, action: row.action, target: row.target,
      before: parse(row.before_json), after: parse(row.after_json), ip: row.ip,
    })),
    next: results.length === limit ? results.at(-1).id : null,
  });
}

const SETTING_KEYS = {
  globalPause: "global_pause", retention: "retention", roles: "roles", desiredAgentVersion: "desired_agent_version",
  cloudflare: "cloudflare",
};
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

function checkSettings(body) {
  const unknown = Object.keys(body).filter((key) => !(key in SETTING_KEYS));
  if (unknown.length) throw new HttpError(400, `Unknown setting ${unknown.join(", ")}`);
  if (body.globalPause !== undefined && typeof body.globalPause !== "boolean") throw new HttpError(400, "globalPause must be true or false");
  if (body.retention !== undefined) {
    if (!body.retention || typeof body.retention !== "object" || Array.isArray(body.retention)) throw new HttpError(400, "retention must be an object");
    for (const [key, value] of Object.entries(body.retention)) {
      if (!(key in DEFAULT_RETENTION)) throw new HttpError(400, `Unknown retention setting ${key}`);
      if (!Number.isInteger(value) || value < 1 || value > 3650) throw new HttpError(400, `retention.${key} must be a whole number from 1 to 3650`);
    }
  }
  if (body.desiredAgentVersion !== undefined && body.desiredAgentVersion !== null && !VERSION.test(String(body.desiredAgentVersion))) {
    throw new HttpError(400, "desiredAgentVersion must be a version like 0.2.0, or null");
  }
  if (body.cloudflare !== undefined) {
    if (!body.cloudflare || typeof body.cloudflare !== "object" || Array.isArray(body.cloudflare)) throw new HttpError(400, "cloudflare must be an object");
    const unknownGuard = Object.keys(body.cloudflare).filter((key) => !["maxConcurrent", "maxRunSeconds", "labels"].includes(key));
    if (unknownGuard.length) throw new HttpError(400, `Unknown cloudflare setting ${unknownGuard.join(", ")}`);
    try {
      normaliseGuard(body.cloudflare);
    } catch (error) {
      throw new HttpError(400, error.message);
    }
  }
  if (body.roles !== undefined) body.roles = normaliseRoles(body.roles);
}

/**
 * The roles map as it is stored. An email is lower-cased (Access emails are).
 * A service token keeps the client id's case (`service:<client-id>`). The same
 * login twice, ignoring case, is refused.
 */
function normaliseRoles(roles) {
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) throw new HttpError(400, "roles must be an object");
  const normalised = {};
  const seen = new Set();
  for (const [rawLogin, role] of Object.entries(roles)) {
    const login = canonicalLogin(rawLogin);
    if (!login) throw new HttpError(400, `${rawLogin} is not an email or service:<client-id>`);
    const folded = login.toLowerCase();
    if (seen.has(folded)) throw new HttpError(400, `${login} is listed more than once`);
    if (!ROLES.includes(role)) throw new HttpError(400, `roles.${login} must be viewer, operator or admin`);
    seen.add(folded);
    normalised[login] = role;
  }
  return normalised;
}

function canonicalLogin(raw) {
  const text = String(raw ?? "").trim();
  if (!text || text.length > 200) return null;
  const service = /^service:(\S+)$/i.exec(text);
  if (service) return `service:${service[1]}`;
  const email = text.toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(email) ? email : null;
}

async function currentSettings(db) {
  const stored = await readSettings(db, Object.values(SETTING_KEYS));
  return {
    globalPause: stored.global_pause === true,
    retention: { ...DEFAULT_RETENTION, ...(stored.retention ?? {}) },
    roles: stored.roles ?? {},
    // Machines on an older agent show "needs update" (until M7's signed updates, a person updates them).
    desiredAgentVersion: stored.desired_agent_version ?? null,
    cloudflare: normaliseGuard(stored.cloudflare ?? {}),
  };
}

function settingsResponse(stored, env, extra = {}) {
  return { ...stored, bootstrapAdmins: bootstrapAdminList(env?.BOOTSTRAP_ADMINS), ...extra };
}

export async function getSettings({ db, env }) {
  return json(200, settingsResponse(await currentSettings(db), env));
}

/** PATCH /v1/settings, and pause-all/resume-all (which only touch globalPause, as an operator may). */
export async function patchSettings({ db, env, identity, ip, now }, body) {
  checkSettings(body);
  if (body.roles !== undefined) {
    const refusal = rolesRefusal(body.roles, { actor: identity.login, bootstrapAdmins: env?.BOOTSTRAP_ADMINS });
    if (refusal) throw new HttpError(400, refusal);
  }
  const before = await currentSettings(db);
  const proposed = Object.fromEntries(Object.keys(body).map((key) => [key, key === "retention"
    ? { ...before.retention, ...body.retention }
    : key === "cloudflare" ? normaliseGuard({ ...before.cloudflare, ...body.cloudflare }) : body[key]]));
  const changed = Object.keys(proposed).filter((key) => JSON.stringify(proposed[key]) !== JSON.stringify(before[key]));
  if (changed.length) {
    await db.batch([
      ...changed.map((key) => putSetting(db, SETTING_KEYS[key], proposed[key])),
      auditStatement(db, {
        at: now, actor: identity.actor, ip, action: changed.length === 1 && changed[0] === "globalPause" ? `settings.${body.globalPause ? "pause-all" : "resume-all"}` : "settings.update",
        target: changed.join(","),
        before: Object.fromEntries(changed.map((key) => [key, before[key]])),
        after: Object.fromEntries(changed.map((key) => [key, proposed[key]])),
      }),
      bumpJobsVersion(db),
    ]);
  }
  return json(200, settingsResponse(await currentSettings(db), env, { changed }));
}

export async function importHandler({ db, request, url, identity, ip, now }) {
  const body = await readJson(request, { maxBytes: 256 * 1024 });
  const dryRun = ["1", "true"].includes(url.searchParams.get("dryRun") ?? "");
  return json(200, await importJobs(db, body, { actor: identity.actor, ip, now, dryRun }));
}

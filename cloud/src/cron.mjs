// hc-core's minute: create due runs from every job's schedule (§3.2), mark
// runs whose agent went quiet as lost, time out runs the agent never reported
// (§3.6), and, once an hour, apply retention (§12). Every step is idempotent:
// a second cron in the same minute, or a sync materialising lazily, finds
// the work done.

import { newId } from "../../src/core/ids.mjs";
import { preferredUntil } from "../../src/core/placement.mjs";
import { lostRetry } from "../../src/core/run.mjs";
import { materialise } from "../../src/core/schedule.mjs";
import { ACTIVE_SQL, NON_TERMINAL_SQL } from "./db.mjs";

const TIMEOUT_GRACE_MS = 300_000;
const RETENTION_MINUTE = 37;
const RETENTION_BATCH = 500;
const DAY = 86_400_000;
export const DEFAULT_RETENTION = {
  skippedDays: 14, runDays: 180, keepRunsPerJob: 50, successLogDays: 14, failureLogDays: 90, auditDays: 365,
};

function parse(text, fallback = null) {
  try {
    return text === null || text === undefined ? fallback : JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** Every job's schedule, state and open runs, in three reads. */
async function readSchedules(db) {
  const [jobs, runs, settings] = await db.batch([
    db.prepare(`SELECT j.id, j.enabled, j.paused, j.revision, j.schedule_json, j.policy_json, j.timeouts_json, j.placement_json,
      s.last_slot_at, s.last_finished_at, s.next_due_at
      FROM jobs j LEFT JOIN schedule_state s ON s.job_id = j.id`),
    db.prepare(`SELECT id, job_id, state, due_at FROM runs WHERE state IN (${NON_TERMINAL_SQL})`),
    db.prepare("SELECT value_json FROM settings WHERE key = 'global_pause'"),
  ]);
  const open = new Map();
  for (const run of runs.results) {
    const entry = open.get(run.job_id) ?? { due: null, active: null };
    if (run.state === "due") entry.due = { id: run.id, dueAt: run.due_at };
    else entry.active = { id: run.id, state: run.state };
    open.set(run.job_id, entry);
  }
  return { jobs: jobs.results, open, globalPause: parse(settings.results[0]?.value_json) === true };
}

/**
 * Applies `materialise` to every job and writes what it decided in at most
 * three statements: new runs (`ON CONFLICT DO NOTHING`, so a slot another
 * cron or sync already created is left alone), expired due runs, and each
 * job's newest slot (which only ever moves forward).
 */
export async function materialiseAll(db, now, { jobIds } = {}) {
  const { jobs, open, globalPause } = await readSchedules(db);
  const inserts = [];
  const expire = [];
  const states = [];
  for (const row of jobs) {
    if (jobIds && !jobIds.includes(row.id)) continue;
    const job = {
      id: row.id,
      enabled: row.enabled === 1,
      paused: row.paused === 1,
      schedule: parse(row.schedule_json),
      policy: parse(row.policy_json, {}),
      timeouts: parse(row.timeouts_json, {}),
      placement: parse(row.placement_json, {}),
    };
    const state = { lastSlotAt: row.last_slot_at ?? null, lastFinishedAt: row.last_finished_at ?? null, ...(open.get(row.id) ?? {}) };
    let result;
    try {
      result = materialise(job, state, now, { globalPause });
    } catch (error) {
      console.error(JSON.stringify({ event: "materialise_error", job: row.id, error: error.message }));
      continue;
    }
    expire.push(...result.expire);
    for (const slot of result.slots) {
      inserts.push({
        id: newId("r", now),
        job_id: row.id,
        job_revision: row.revision,
        slot_at: slot.slotAt,
        state: slot.state,
        skip_reason: slot.skipReason,
        due_at: slot.dueAt,
        preferred_until: slot.preferredUntil,
        finished_at: slot.state === "skipped" ? now : null,
      });
    }
    if (result.lastSlotAt !== state.lastSlotAt || result.nextDueAt !== (row.next_due_at ?? null)) {
      states.push({ job_id: row.id, last_slot_at: result.lastSlotAt, next_due_at: result.nextDueAt });
    }
  }
  const statements = [];
  if (expire.length) {
    statements.push(db.prepare(`UPDATE runs SET state = 'skipped', skip_reason = 'expired', finished_at = ?1, updated_at = ?1
      WHERE id IN (SELECT value FROM json_each(?2)) AND state = 'due'`).bind(now, JSON.stringify(expire)));
  }
  if (inserts.length) {
    statements.push(db.prepare(`INSERT INTO runs (id, job_id, job_revision, slot_at, source, state, skip_reason, due_at,
        preferred_until, finished_at, requested_by, created_at, updated_at)
      SELECT value->>'id', value->>'job_id', value->>'job_revision', value->>'slot_at', 'schedule', value->>'state',
        value->>'skip_reason', value->>'due_at', value->>'preferred_until', value->>'finished_at', 'schedule', ?1, ?1
      FROM json_each(?2) WHERE true ON CONFLICT DO NOTHING`).bind(now, JSON.stringify(inserts)));
  }
  if (states.length) {
    statements.push(db.prepare(`INSERT INTO schedule_state (job_id, last_slot_at, next_due_at)
      SELECT value->>'job_id', value->>'last_slot_at', value->>'next_due_at' FROM json_each(?) WHERE true
      ON CONFLICT(job_id) DO UPDATE SET
        last_slot_at = CASE WHEN schedule_state.last_slot_at IS NULL OR excluded.last_slot_at > schedule_state.last_slot_at
          THEN excluded.last_slot_at ELSE schedule_state.last_slot_at END,
        next_due_at = excluded.next_due_at`).bind(JSON.stringify(states)));
  }
  const results = statements.length ? await db.batch(statements) : [];
  const created = inserts.length ? results[expire.length ? 1 : 0].meta.changes : 0;
  return { jobs: jobs.length, slots: inserts.length, created, expired: expire.length };
}

/**
 * Runs whose lease ran out become `lost` (§3.4): their machine stopped
 * syncing. `updated_at` then records when, which the retry's grace counts from.
 */
export async function expireLeases(db, now) {
  const result = await db.prepare(`UPDATE runs SET state = 'lost', lease_expires_at = NULL, updated_at = ?1
    WHERE state IN (${ACTIVE_SQL}) AND lease_expires_at IS NOT NULL AND lease_expires_at < ?1`).bind(now).run();
  return result.meta.changes;
}

const LOST_LOOKBACK_MS = 2 * DAY;

/**
 * Automatic retries of lost runs (§3.4, `lostRetry`): a new due run with
 * `attempt + 1` and `retry_of`. A lost run already followed by a newer run of
 * its job (its retry, a later slot or a manual run) needs none: under
 * coalescing that run does the work. A late completion settles the lost run
 * instead (it is no longer `lost`), so no retry follows it either.
 */
export async function retryLostRuns(db, now) {
  const { results } = await db.prepare(`SELECT l.id, l.job_id, l.attempt, l.started_at, l.updated_at, j.policy_json, j.placement_json
    FROM runs l JOIN jobs j ON j.id = l.job_id
    WHERE l.state = 'lost' AND l.updated_at > ?1
      AND NOT EXISTS (SELECT 1 FROM runs n WHERE n.job_id = l.job_id AND n.due_at > l.due_at AND n.state != 'skipped')
    LIMIT 50`).bind(now - LOST_LOOKBACK_MS).all();
  const retries = [];
  for (const lost of results) {
    const policy = parse(lost.policy_json, {});
    const decision = lostRetry({ attempt: lost.attempt, startedAt: lost.started_at, lostAt: lost.updated_at }, policy, now);
    if (!decision.retry) continue;
    retries.push({
      id: newId("r", now), retry_of: lost.id,
      preferred_until: preferredUntil({ placement: parse(lost.placement_json, {}) }, now),
    });
  }
  if (!retries.length) return 0;
  const result = await db.prepare(`INSERT INTO runs (id, job_id, job_revision, slot_at, source, state, attempt, retry_of, due_at,
      preferred_until, parameters_json, requested_by, created_at, updated_at)
    SELECT value->>'id', l.job_id, l.job_revision, NULL, 'retry', 'due', l.attempt + 1, l.id, ?1, value->>'preferred_until',
      l.parameters_json, 'retry', ?1, ?1
    FROM json_each(?2) JOIN runs l ON l.id = value->>'retry_of' WHERE l.state = 'lost'
    ON CONFLICT DO NOTHING`).bind(now, JSON.stringify(retries)).run();
  return result.meta.changes;
}

/** The backstop for a run its agent never finished: `started_at + runSeconds + 300 s` (§3.6). */
export async function timeOutRuns(db, now) {
  const result = await db.prepare(`UPDATE runs SET state = 'timed-out', outcome = 'failed', timed_out = 1,
      error = COALESCE(error, 'timed out: no result from the agent'), finished_at = ?1, lease_expires_at = NULL, updated_at = ?1
    WHERE id IN (SELECT r.id FROM runs r JOIN jobs j ON j.id = r.job_id
      WHERE r.state IN ('running', 'reporting') AND r.started_at IS NOT NULL
        AND r.started_at + json_extract(j.timeouts_json, '$.runSeconds') * 1000 + ${TIMEOUT_GRACE_MS} < ?1)`).bind(now).run();
  return result.meta.changes;
}

/**
 * Deletes what retention no longer keeps, at most 500 rows per kind per
 * hour: skipped slots after 14 days, run logs after 14 days for successes
 * and 90 for the rest, runs after 180 days (always keeping each job's newest
 * 50), and audit rows after a year. Overridden by the `retention` setting.
 */
export async function applyRetention(db, now, overrides = {}) {
  const policy = { ...DEFAULT_RETENTION, ...overrides };
  const ago = (days) => now - days * DAY;
  const results = await db.batch([
    db.prepare(`DELETE FROM runs WHERE id IN (SELECT id FROM runs WHERE state = 'skipped' AND due_at < ? LIMIT ${RETENTION_BATCH})`)
      .bind(ago(policy.skippedDays)),
    db.prepare(`DELETE FROM run_logs WHERE run_id IN (SELECT l.run_id FROM run_logs l JOIN runs r ON r.id = l.run_id
      WHERE l.final = 1 AND ((r.state = 'succeeded' AND l.updated_at < ?1) OR l.updated_at < ?2) LIMIT ${RETENTION_BATCH})`)
      .bind(ago(policy.successLogDays), ago(policy.failureLogDays)),
    db.prepare(`DELETE FROM runs WHERE id IN (SELECT r.id FROM runs r
      WHERE r.state IN ('succeeded', 'failed', 'timed-out', 'cancelled', 'lost') AND r.due_at < ?1
        AND (SELECT COUNT(*) FROM runs n WHERE n.job_id = r.job_id AND n.due_at > r.due_at) >= ?2
      LIMIT ${RETENTION_BATCH})`).bind(ago(policy.runDays), policy.keepRunsPerJob),
    db.prepare(`DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE at < ? LIMIT ${RETENTION_BATCH})`)
      .bind(ago(policy.auditDays)),
  ]);
  const [skipped, logs, runs, audit] = results.map((result) => result.meta.changes);
  return { skipped, logs, runs, audit };
}

/** One cron invocation. `now` is the trigger's scheduled time, so a late cron still counts its own minute. */
export async function minute(env, now) {
  const db = env.DB;
  const summary = { materialised: await materialiseAll(db, now) };
  summary.lost = await expireLeases(db, now);
  summary.retried = await retryLostRuns(db, now);
  summary.timedOut = await timeOutRuns(db, now);
  if (new Date(now).getUTCMinutes() === RETENTION_MINUTE) {
    const settings = await db.prepare("SELECT value_json FROM settings WHERE key = 'retention'").first();
    summary.retention = await applyRetention(db, now, parse(settings?.value_json, {}) ?? {});
  }
  return summary;
}

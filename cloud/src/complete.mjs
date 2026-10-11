// POST /agent/v1/runs/:id/complete: a run's final record (§4.2, §4.6). It is
// idempotent per run, because the agent's outbox sends it again until it
// sees a 2xx. A run the server already finished (a duplicate, a cancel, the
// timeout backstop) keeps its state and gains the agent's final log; a run
// marked lost is settled with `recovered` (§3.4). The run, its log, its
// job's schedule state (`published`, the last outcome, an interval job's next
// slot) and any retry commit together.

import { boundedReports, reportMetrics } from "../../src/core/history.mjs";
import { parseDuration } from "../../src/core/job.mjs";
import { publishedEntries, trackPublished } from "../../src/core/reports.mjs";
import { redactValue } from "../../src/core/redact.mjs";
import { preferredUntil } from "../../src/core/placement.mjs";
import { newId } from "../../src/core/ids.mjs";
import { ACTIVE_STATES, failedRetry, TERMINAL_STATES, transition } from "../../src/core/run.mjs";
import { HttpError, iso } from "./http.mjs";
import { jobsAt } from "./jobcache.mjs";
import { logTailStatement, redactPatterns } from "./sync.mjs";

const ACTIVE = new Set(ACTIVE_STATES);
const TERMINAL = new Set(TERMINAL_STATES);

function parse(text, fallback) {
  try {
    return text === null || text === undefined ? fallback : JSON.parse(text);
  } catch {
    return fallback;
  }
}

function larger(a, b) {
  const values = [a, b].filter((value) => typeof value === "number");
  return values.length ? Math.max(...values) : null;
}

async function read(db, runId) {
  const [runs, states, settings] = await db.batch([
    db.prepare("SELECT * FROM runs WHERE id = ?").bind(runId),
    db.prepare("SELECT s.published_json FROM runs r JOIN schedule_state s ON s.job_id = r.job_id WHERE r.id = ?").bind(runId),
    db.prepare("SELECT value_json FROM settings WHERE key = 'jobs_version'"),
  ]);
  return { run: runs.results[0] ?? null, published: parse(states.results[0]?.published_json, {}), version: settings.results[0]?.value_json ?? "0" };
}

/** The statements that settle `run` (read in state `run.state`) with the agent's `record`, and the answer. */
function settle(db, run, job, published, record, now) {
  const reports = boundedReports(redactValue(record.reports, redactPatterns));
  const error = record.error ? redactPatterns(record.error) : null;
  const errorDetail = record.errorDetail ? redactPatterns(record.errorDetail) : null;
  const event = record.cancelled && ACTIVE.has(run.state)
    ? { type: "cancel", at: now }
    : { type: "complete", exitCode: record.exitCode, oomKilled: record.oomKilled, timedOut: record.timedOut, reports, report: job?.report, error, at: now };
  const next = transition({ state: run.state, error: null, recovered: run.recovered === 1 }, event);
  const outcome = next.state === "cancelled" ? null : next.outcome;
  const { stats, durations } = record;
  // A run that started and ended between two syncs has no server-stamped start: it is its end less its (monotonic) duration.
  const startedAt = run.started_at ?? (typeof durations.durationMs === "number" ? now - durations.durationMs : null);
  const values = {
    state: next.state,
    outcome,
    error: next.state === "cancelled" ? error : next.error ?? null,
    error_detail: errorDetail,
    exit_code: record.exitCode,
    oom_killed: record.oomKilled ? 1 : 0,
    timed_out: record.timedOut ? 1 : 0,
    started_at: startedAt,
    finished_at: now,
    lease_expires_at: null,
    recovered: next.recovered ? 1 : 0,
    reports_json: reports.length ? JSON.stringify(reports) : null,
    metrics_json: reports.length ? JSON.stringify(reportMetrics(reports)) : null,
    published_json: job?.report?.trackEvent ? JSON.stringify(publishedEntries(reports, job.report, run.job_id)) : null,
    peak_memory_bytes: larger(run.peak_memory_bytes, stats.peakMemoryBytes),
    memory_limit_bytes: stats.memoryLimitBytes ?? run.memory_limit_bytes,
    avg_cpu_pct: stats.avgCpuPct,
    peak_cpu_pct: larger(run.peak_cpu_pct, stats.peakCpuPct),
    cpu_seconds: stats.cpuSeconds,
    stats_samples: stats.samples,
    duration_ms: durations.durationMs,
    vm_wait_ms: durations.vmWaitMs,
    pull_ms: durations.pullMs,
    queue_ms: startedAt !== null && startedAt >= run.due_at ? startedAt - run.due_at : null,
    image_ref: record.image.ref ?? run.image_ref,
    image_digest: record.image.digest ?? run.image_digest,
    updated_at: now,
  };
  const columns = Object.keys(values);
  const statements = [
    db.prepare(`UPDATE runs SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ? AND state = ?`)
      .bind(...columns.map((column) => values[column]), run.id, run.state),
  ];
  // Everything else holds only if that update did: same state, same finish time (a lost race leaves both unmatched).
  const settled = "EXISTS (SELECT 1 FROM runs WHERE id = ?1 AND state = ?2 AND finished_at = ?3)";
  if (record.logTail) statements.push(logTailStatement(db, run.id, record.logTail, { now, final: true }));
  if (next.state !== "cancelled") {
    const tracked = job?.report?.trackEvent
      ? trackPublished(published, reports, job.report, { fallbackKey: run.job_id, at: iso(now), runId: run.id })
      : published;
    const every = job?.schedule?.every ? now + parseDuration(job.schedule.every) : null;
    statements.push(db.prepare(`UPDATE schedule_state SET last_run_id = ?1, last_state = ?2, last_finished_at = ?3, last_outcome = ?4,
        published_json = ?5, next_due_at = CASE WHEN ?6 IS NULL THEN next_due_at ELSE ?6 END
      WHERE job_id = ?7 AND ${settled}`).bind(run.id, next.state, now, outcome, JSON.stringify(tracked ?? {}), every, run.job_id));
  }
  let retry = null;
  const decision = next.recovered ? { retry: false } : failedRetry({ state: next.state, attempt: run.attempt }, job?.policy, now);
  if (decision.retry) {
    retry = newId("r", now);
    statements.push(db.prepare(`INSERT INTO runs (id, job_id, job_revision, slot_at, source, state, attempt, retry_of, due_at, preferred_until,
        parameters_json, requested_by, created_at, updated_at)
      SELECT ?4, job_id, job_revision, NULL, 'retry', 'due', attempt + 1, id, ?5, ?6, parameters_json, 'retry', ?3, ?3
      FROM runs WHERE id = ?1 AND state = ?2 AND finished_at = ?3 ON CONFLICT DO NOTHING`)
      .bind(run.id, next.state, now, retry, decision.at, preferredUntil(job, decision.at)));
  }
  return { statements, answer: { ok: true, runId: run.id, state: next.state, outcome, recovered: Boolean(next.recovered), retry } };
}

export async function complete(db, runId, record, { machine, now }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { run, published, version } = await read(db, runId);
    if (!run || run.machine_id !== machine.id) throw new HttpError(404, `Unknown run ${runId}`);
    if (TERMINAL.has(run.state)) {
      // Already settled: an outbox resend, or the server cancelled or timed it out first. Keep the agent's final log.
      if (record.logTail) await logTailStatement(db, run.id, record.logTail, { now, final: true }).run();
      return { ok: true, runId: run.id, state: run.state, outcome: run.outcome, recovered: run.recovered === 1, duplicate: true };
    }
    if (!ACTIVE.has(run.state) && run.state !== "lost") throw new HttpError(409, `The run is ${run.state}`);
    const jobs = await jobsAt(db, String(parse(version, 0)));
    const { statements, answer } = settle(db, run, jobs.get(run.job_id) ?? null, published, record, now);
    const [update, ...rest] = await db.batch(statements);
    if (update.meta.changes === 1) {
      const retried = answer.retry && rest.at(-1).meta.changes === 1;
      return { ...answer, retry: retried ? answer.retry : null };
    }
    // The run moved meanwhile (the cron marked it lost, say): read it again and settle what it is now.
  }
  throw new HttpError(409, "The run changed while it was being completed; send it again");
}

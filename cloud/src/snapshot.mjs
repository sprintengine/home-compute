// GET /v1/snapshot and the run shapes: the same fields the local controller
// returns, so the dashboard, the menu bar app and the Studio module need only
// a base URL and auth change (§1, "What is reused"). Hosted fields (`phase`,
// `machine`, `revision`…) are additions; `nodes` aliases `machines`.

import { summarizeRun } from "../../src/core/history.mjs";
import { upcomingAt } from "../../src/core/schedule.mjs";
import { iso } from "./http.mjs";
import { jobFromRow, NON_TERMINAL_SQL, runFromRow } from "./db.mjs";

const RECENT_RUNS = 5;
/** Hosted states in the local controller's (Bacalhau's) words, which existing clients understand. */
const CLIENT_STATE = {
  due: "Queued", claimed: "Pending", "starting-vm": "Pending", pulling: "Pending", running: "Running", reporting: "Running",
  succeeded: "Completed", failed: "Failed", "timed-out": "Failed", cancelled: "Cancelled", skipped: "Skipped", lost: "Lost",
};
// Everything but the big columns: lists never read reports or log tails.
export const RUN_LIST_COLUMNS = `id, job_id, job_revision, slot_at, source, state, skip_reason, outcome, attempt, retry_of, due_at,
  preferred_until, machine_id, claimed_at, started_at, finished_at, queue_ms, duration_ms, vm_wait_ms, pull_ms, exit_code,
  oom_killed, timed_out, peak_memory_bytes, memory_limit_bytes, avg_cpu_pct, peak_cpu_pct, cpu_seconds, image_digest,
  parameters_json, error, metrics_json, published_json, recovered, requested_by, created_at, updated_at`;

function seconds(ms) {
  return ms === null || ms === undefined ? undefined : Math.round(ms / 100) / 10;
}

function between(from, to) {
  return from && to && to >= from ? to - from : null;
}

/** A run as clients see it: the local controller's history fields plus the hosted ones. */
export function clientRun(row) {
  const run = runFromRow(row);
  const metrics = run.metrics ?? undefined;
  const peakMemoryMb = run.peakMemoryBytes ? Math.round(run.peakMemoryBytes / 1048576) : undefined;
  const view = {
    id: run.id,
    job: run.jobId,
    phase: run.state,
    state: CLIENT_STATE[run.state] ?? run.state,
    source: run.source,
    attempt: run.attempt,
    ...(run.retryOf ? { retryOf: run.retryOf } : {}),
    submittedAt: iso(run.dueAt),
    slotAt: iso(run.slotAt) ?? undefined,
    claimedAt: iso(run.claimedAt) ?? undefined,
    startedAt: iso(run.startedAt) ?? undefined,
    finishedAt: iso(run.finishedAt) ?? undefined,
    queueSeconds: seconds(run.queueMs ?? between(run.dueAt, run.startedAt)),
    durationSeconds: seconds(run.durationMs ?? between(run.startedAt, run.finishedAt)),
    outcome: run.outcome ?? undefined,
    exitCode: run.exitCode ?? undefined,
    error: run.error ?? undefined,
    failureDetail: run.errorDetail ?? undefined,
    skipReason: run.skipReason ?? undefined,
    machine: run.machineId ?? undefined,
    parameters: run.parameters ?? undefined,
    metrics: metrics || peakMemoryMb ? { ...(peakMemoryMb ? { peakMemoryMb } : {}), ...(metrics ?? {}) } : undefined,
    published: run.published ?? undefined,
    reports: run.reports ?? undefined,
    imageDigest: run.imageDigest ?? undefined,
    recovered: run.recovered || undefined,
    requestedBy: run.requestedBy ?? undefined,
  };
  return Object.fromEntries(Object.entries(view).filter(([, value]) => value !== undefined && value !== null));
}

/** A schedule as v1 clients read it (`at` slots say they are UTC). */
function clientSchedule(schedule) {
  if (!schedule) return null;
  return schedule.at ? { at: schedule.at, timezone: "UTC" } : schedule;
}

function machineView(row, now) {
  const lastSeen = row.last_seen_at ?? null;
  const online = lastSeen !== null && now - lastSeen < 90_000;
  const parse = (text) => { try { return JSON.parse(text ?? "{}"); } catch { return {}; } };
  return {
    id: row.id,
    name: row.name,
    status: row.drain ? "draining" : online ? "online" : "offline",
    labels: parse(row.labels_json),
    capabilities: row.capabilities ? row.capabilities.split(",").filter(Boolean) : [],
    capacity: parse(row.capacity_json),
    health: parse(row.health_json),
    agentVersion: row.agent_version ?? null,
    drain: row.drain === 1,
    lastSeenAt: iso(lastSeen),
  };
}

/**
 * The whole overview in one batch of five indexed reads. Recent runs are a
 * correlated `IN (… LIMIT 5)` per job, which SQLite answers from runs_by_job;
 * a UNION ALL per job would hit D1's limit on compound SELECTs.
 */
export async function buildSnapshot(db, now) {
  const [jobs, open, settings, machines, recentRows] = await db.batch([
    db.prepare(`SELECT j.*, s.last_slot_at, s.last_finished_at, s.published_json AS state_published_json
      FROM jobs j LEFT JOIN schedule_state s ON s.job_id = j.id ORDER BY j.id`),
    db.prepare(`SELECT ${RUN_LIST_COLUMNS} FROM runs WHERE state IN (${NON_TERMINAL_SQL})`),
    db.prepare("SELECT key, value_json FROM settings WHERE key IN ('global_pause', 'jobs_version')"),
    db.prepare(`SELECT id, name, labels_json, capabilities, capacity_json, health_json, agent_version, drain, last_seen_at
      FROM machines WHERE revoked_at IS NULL ORDER BY name`),
    db.prepare(`SELECT ${RUN_LIST_COLUMNS.replace(/(^|,\s*)(\w+)/g, "$1r.$2")} FROM jobs j JOIN runs r ON r.id IN
      (SELECT id FROM runs WHERE job_id = j.id AND state != 'skipped' ORDER BY due_at DESC LIMIT ${RECENT_RUNS})`),
  ]);
  const setting = Object.fromEntries(settings.results.map((row) => [row.key, JSON.parse(row.value_json)]));
  const globalPause = setting.global_pause === true;
  const openByJob = new Map();
  for (const row of open.results) {
    const entry = openByJob.get(row.job_id) ?? {};
    if (row.state === "due") entry.due = row;
    else entry.active = row;
    openByJob.set(row.job_id, entry);
  }
  const recent = new Map();
  for (const row of recentRows.results) {
    if (!recent.has(row.job_id)) recent.set(row.job_id, []);
    recent.get(row.job_id).push(clientRun(row));
  }
  for (const runs of recent.values()) runs.sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt));
  const jobViews = jobs.results.map((row) => {
    const job = jobFromRow(row);
    const { due, active } = openByJob.get(job.id) ?? {};
    const current = active ?? due;
    const runs = recent.get(job.id) ?? [];
    const finished = runs.find((run) => run.finishedAt);
    let published = {};
    try { published = JSON.parse(row.state_published_json ?? "{}"); } catch { /* keep {} */ }
    const next = upcomingAt(job, {
      lastSlotAt: row.last_slot_at, lastFinishedAt: row.last_finished_at,
      due: due ? { id: due.id, dueAt: due.due_at } : null, active,
    }, now, { globalPause });
    const view = {
      id: job.id,
      enabled: job.enabled && !job.paused,
      configuredEnabled: job.enabled,
      paused: job.paused,
      schedule: clientSchedule(job.schedule),
      image: job.image,
      parameters: job.args,
      resources: job.resources,
      labels: job.labels,
      preset: job.preset,
      revision: job.revision,
      ...(job.description ? { description: job.description } : {}),
      running: Boolean(current),
      ...(current ? {
        activeJobId: current.id,
        activeState: CLIENT_STATE[current.state],
        liveState: CLIENT_STATE[current.state],
        phase: current.state,
        lastSubmittedAt: iso(current.due_at),
      } : runs[0] ? { lastSubmittedAt: runs[0].submittedAt } : {}),
      ...(finished ? {
        lastFinishedJobId: finished.id,
        lastFinishedAt: finished.finishedAt,
        lastFinishedState: finished.state,
        lastOutcome: finished.outcome,
        ...(finished.exitCode !== undefined ? { lastExitCode: finished.exitCode } : {}),
        ...(finished.outcome === "failed" && finished.error ? { lastError: finished.error } : {}),
      } : {}),
      published,
      nextDueAt: iso(next),
      recentRuns: runs.map(summarizeRun),
      runsUrl: `/v1/jobs/${job.id}/runs`,
    };
    return view;
  });
  const machineViews = machines.results.map((row) => machineView(row, now));
  return {
    version: 1,
    generatedAt: iso(now),
    controller: {
      status: "online",
      kind: "hosted",
      pollEvery: "60s",
      features: ["history", "logs", "timetable", "machines", "import", "audit"],
      globalPause,
    },
    timetable: { editable: true },
    jobs: jobViews,
    machines: machineViews,
    // The local controller's Bacalhau node list, in the shape existing clients decode.
    nodes: machineViews.map((machine) => ({
      ...machine,
      Info: { NodeID: machine.name },
      Connection: machine.status === "offline" ? "DISCONNECTED" : "CONNECTED",
    })),
    nodeCount: machineViews.length,
    jobsVersion: setting.jobs_version ?? 0,
    stateUpdatedAt: iso(now),
  };
}

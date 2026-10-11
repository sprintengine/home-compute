// GET /v1/snapshot and the run shapes: the same fields the local controller
// returns, so the dashboard, the menu bar app and the Studio module need only
// a base URL and auth change (§1, "What is reused"). Hosted fields (`phase`,
// `machine`, `revision`…) are additions; `nodes` aliases `machines`.

import { summarizeRun } from "../../src/core/history.mjs";
import { claimBlockers, labelsMatch, machineAvailable, unhealthyReason } from "../../src/core/placement.mjs";
import { OFFLINE_MS } from "../../src/core/protocol.mjs";
import { upcomingAt } from "../../src/core/schedule.mjs";
import { iso } from "./http.mjs";
import { jobFromRow, machineFromRow, NON_TERMINAL_SQL, runFromRow } from "./db.mjs";

const RECENT_RUNS = 5;
const RECENT_RUNS_ALL = 20;
const CLOCK_SKEW_WARNING_MS = 30_000;
/** Hosted states in the local controller's (Bacalhau's) words, which existing clients understand. */
const CLIENT_STATE = {
  due: "Queued", claimed: "Pending", "starting-vm": "Pending", pulling: "Pending", running: "Running", reporting: "Running",
  succeeded: "Completed", failed: "Failed", "timed-out": "Failed", cancelled: "Cancelled", skipped: "Skipped", lost: "Lost",
};
// Everything but the big columns: lists never read reports or log tails.
export const RUN_LIST_COLUMNS = `id, job_id, job_revision, slot_at, source, state, skip_reason, outcome, attempt, retry_of, due_at,
  preferred_until, machine_id, claimed_at, vm_started_at, pull_started_at, started_at, reporting_at, finished_at, queue_ms, duration_ms,
  vm_wait_ms, pull_ms, exit_code, oom_killed, timed_out, peak_memory_bytes, memory_limit_bytes, avg_cpu_pct, peak_cpu_pct, cpu_seconds,
  stats_samples, image_digest, parameters_json, error, metrics_json, published_json, recovered, requested_by, created_at, updated_at`;

function seconds(ms) {
  return ms === null || ms === undefined ? undefined : Math.round(ms / 100) / 10;
}

function between(from, to) {
  return from && to && to >= from ? to - from : null;
}

/** A run as clients see it: the local controller's history fields plus the hosted ones. */
export function clientRun(row, machineNames = null) {
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
    vmStartedAt: iso(run.vmStartedAt) ?? undefined,
    pullStartedAt: iso(run.pullStartedAt) ?? undefined,
    startedAt: iso(run.startedAt) ?? undefined,
    reportingAt: iso(run.reportingAt) ?? undefined,
    finishedAt: iso(run.finishedAt) ?? undefined,
    queueSeconds: seconds(run.queueMs ?? between(run.dueAt, run.startedAt)),
    durationSeconds: seconds(run.durationMs ?? between(run.startedAt, run.finishedAt)),
    vmWaitSeconds: seconds(run.vmWaitMs),
    pullSeconds: seconds(run.pullMs),
    outcome: run.outcome ?? undefined,
    exitCode: run.exitCode ?? undefined,
    error: run.error ?? undefined,
    failureDetail: run.errorDetail ?? undefined,
    skipReason: run.skipReason ?? undefined,
    machine: run.machineId ?? undefined,
    machineName: run.machineId ? machineNames?.get(run.machineId) : undefined,
    parameters: run.parameters ?? undefined,
    metrics: metrics || peakMemoryMb ? { ...(peakMemoryMb ? { peakMemoryMb } : {}), ...(metrics ?? {}) } : undefined,
    published: run.published ?? undefined,
    reports: run.reports ?? undefined,
    imageDigest: run.imageDigest ?? undefined,
    // The agent's measurements (§4.6): stats_samples 0 means the run was too short to sample.
    stats: run.statsSamples !== null && run.statsSamples !== undefined ? {
      samples: run.statsSamples, peakMemoryBytes: run.peakMemoryBytes, memoryLimitBytes: run.memoryLimitBytes,
      avgCpuPct: run.avgCpuPct, peakCpuPct: run.peakCpuPct, cpuSeconds: run.cpuSeconds,
    } : undefined,
    oomKilled: run.oomKilled || undefined,
    timedOut: run.timedOut || undefined,
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

/**
 * A machine as clients see it: its status (online, offline, draining,
 * unhealthy or revoked), VM, caps, labels, agent, clock skew and current
 * runs. `runs` are run rows; those this machine holds are listed.
 */
export function machineView(row, now, runs = []) {
  const machine = machineFromRow(row);
  const online = machine.lastSeenAt !== null && now - machine.lastSeenAt <= OFFLINE_MS;
  const unhealthy = unhealthyReason(machine.health);
  let status = "online";
  if (machine.revokedAt) status = "revoked";
  else if (!online) status = "offline";
  else if (machine.drain || machine.health.localDrain) status = "draining";
  else if (unhealthy) status = "unhealthy";
  const { vm = null, free = null, ...facts } = machine.facts;
  return {
    id: machine.id,
    name: machine.name,
    status,
    ...(unhealthy ? { unhealthy } : {}),
    labels: machine.labels,
    capabilities: machine.capabilities,
    capacity: machine.capacity,
    vm,
    free,
    facts,
    health: machine.health,
    agentVersion: machine.agentVersion,
    drain: machine.drain,
    localDrain: Boolean(machine.health.localDrain),
    lastSeenAt: iso(machine.lastSeenAt),
    lastIp: machine.lastIp,
    clockSkewMs: machine.clockSkewMs,
    ...(Math.abs(machine.clockSkewMs ?? 0) > CLOCK_SKEW_WARNING_MS ? { clockSkewWarning: true } : {}),
    enrolledAt: iso(machine.enrolledAt),
    ...(machine.revokedAt ? { revokedAt: iso(machine.revokedAt) } : {}),
    credentialIssuedAt: iso(machine.credentialIssuedAt),
    rotationPending: Boolean(row.rotation_pending) || machine.rotateRequestedAt !== null,
    currentRuns: runs.filter((run) => run.machine_id === machine.id).map((run) => ({ id: run.id, job: run.job_id, phase: run.state })),
  };
}

function minutes(ms) {
  return `${Math.max(0, Math.round(ms / 60_000))} min`;
}

/**
 * Why a due run is still waiting (§3.5: "waiting 12 min: preferred mac-mini
 * busy"), from the same rules hc-core claims by.
 */
export function waitingReason(job, run, machines, now, { globalPause }) {
  const waited = `waiting ${minutes(now - run.due_at)}`;
  const blockers = claimBlockers(job);
  if (blockers.length) return `blocked: ${blockers.join("; ")}`;
  if (run.source !== "manual" && (job.paused || globalPause || !job.enabled)) return `${waited}: paused`;
  const required = job.placement?.requireLabels ?? {};
  const matching = machines.filter((machine) => !machine.revokedAt && labelsMatch(required, machine.labels));
  if (!matching.length) {
    const labels = Object.entries(required).map(([key, value]) => `${key}=${value}`).join(", ");
    return `${waited}: no machine has ${labels ? `labels ${labels}` : "enrolled"}`;
  }
  const preferred = job.placement?.preferMachines ?? [];
  const available = matching.filter((machine) => machineAvailable(machine, now));
  if (preferred.length && run.preferred_until && now < run.preferred_until) {
    const waitingFor = available.filter((machine) => preferred.includes(machine.name));
    if (waitingFor.length) return `${waited}: preferred ${waitingFor.map((machine) => machine.name).join(", ")} busy`;
  }
  if (!available.length) return `${waited}: no machine online`;
  return `${waited}: no machine has ${job.resources.cpus} CPU and ${job.resources.memoryMiB} MiB free`;
}

/**
 * The whole overview in one batch of five indexed reads. Recent runs are a
 * correlated `IN (… LIMIT 5)` per job, which SQLite answers from runs_by_job;
 * a UNION ALL per job would hit D1's limit on compound SELECTs.
 */
export async function buildSnapshot(db, now) {
  const [jobs, open, settings, machines, recentRows, lastReportRows, latestRows] = await db.batch([
    db.prepare(`SELECT j.*, s.last_slot_at, s.last_finished_at, s.published_json AS state_published_json
      FROM jobs j LEFT JOIN schedule_state s ON s.job_id = j.id ORDER BY j.id`),
    db.prepare(`SELECT ${RUN_LIST_COLUMNS} FROM runs WHERE state IN (${NON_TERMINAL_SQL})`),
    db.prepare("SELECT key, value_json FROM settings WHERE key IN ('global_pause', 'jobs_version')"),
    db.prepare(`SELECT id, name, labels_json, capabilities, capacity_json, facts_json, health_json, agent_version, drain, last_seen_at,
        last_ip, clock_skew_ms, enrolled_at, revoked_at, credential_issued_at, rotate_requested_at,
        credential_next_hash IS NOT NULL AS rotation_pending
      FROM machines WHERE revoked_at IS NULL ORDER BY name`),
    db.prepare(`SELECT ${RUN_LIST_COLUMNS.replace(/(^|,\s*)(\w+)/g, "$1r.$2")} FROM jobs j JOIN runs r ON r.id IN
      (SELECT id FROM runs WHERE job_id = j.id AND state != 'skipped' ORDER BY due_at DESC LIMIT ${RECENT_RUNS})`),
    // The reports of each job's last finished run (the local controller's lastReports), via schedule_state.last_run_id.
    db.prepare("SELECT s.job_id, r.reports_json FROM schedule_state s JOIN runs r ON r.id = s.last_run_id WHERE r.reports_json IS NOT NULL"),
    // The latest changes across jobs, newest first (runs_by_updated).
    db.prepare(`SELECT ${RUN_LIST_COLUMNS} FROM runs WHERE state != 'skipped' ORDER BY updated_at DESC LIMIT ${RECENT_RUNS_ALL}`),
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
  const machineObjects = machines.results.map(machineFromRow);
  const names = new Map(machineObjects.map((machine) => [machine.id, machine.name]));
  const view = (row) => clientRun(row, names);
  const recent = new Map();
  for (const row of recentRows.results) {
    if (!recent.has(row.job_id)) recent.set(row.job_id, []);
    recent.get(row.job_id).push(view(row));
  }
  const lastReports = new Map(lastReportRows.results.map((row) => [row.job_id, JSON.parse(row.reports_json)]));
  const jobsById = new Map();
  for (const runs of recent.values()) runs.sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt));
  const jobViews = jobs.results.map((row) => {
    const job = jobFromRow(row);
    jobsById.set(job.id, job);
    const blocked = claimBlockers(job);
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
        ...(current.machine_id ? { machine: names.get(current.machine_id) ?? current.machine_id } : {}),
        ...(current.state === "due" ? { waiting: waitingReason(job, current, machineObjects, now, { globalPause }) } : {}),
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
      ...(lastReports.has(job.id) ? { lastReports: lastReports.get(job.id) } : {}),
      ...(blocked.length ? { blocked: blocked.join("; ") } : {}),
      nextDueAt: iso(next),
      recentRuns: runs.map(summarizeRun),
      runsUrl: `/v1/jobs/${job.id}/runs`,
    };
    return view;
  });
  const machineViews = machines.results.map((row) => machineView(row, now, open.results));
  const activeRuns = open.results.map((row) => {
    const run = view(row);
    const job = jobsById.get(row.job_id);
    return row.state === "due" && job ? { ...run, waiting: waitingReason(job, row, machineObjects, now, { globalPause }) } : run;
  });
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
    activeRuns,
    recentRuns: latestRows.results.map(view),
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

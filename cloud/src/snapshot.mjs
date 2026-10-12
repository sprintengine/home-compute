// GET /v1/snapshot and the run shapes: the same fields the local controller
// returns, so the dashboard, the menu bar app and the Studio module need only
// a base URL and auth change (§1, "What is reused"). Hosted fields (`phase`,
// `machine`, `revision`…) are additions; `nodes` aliases `machines`.

import { summarizeRun } from "../../src/core/history.mjs";
import { claimBlockers, labelsMatch, machineAvailable, secretsRefused, unhealthyReason } from "../../src/core/placement.mjs";
import { OFFLINE_MS } from "../../src/core/protocol.mjs";
import { nextSlot, upcomingAt } from "../../src/core/schedule.mjs";
import { iso } from "./http.mjs";
import { jobFromRow, machineFromRow, NON_TERMINAL_SQL, runFromRow } from "./db.mjs";
import { alertState } from "./alerts.mjs";

const RECENT_RUNS = 5;
/** Runs per job read for the overview's duration sparkline; `recentRuns` keeps its 5. */
const SPARKLINE_RUNS = 20;
const RECENT_RUNS_ALL = 20;
const UPCOMING_SLOTS = 6;
const LOST_WINDOW_MS = 24 * 3_600_000;
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

/** Whether dotted version `a` is older than `b` (`0.2.0` < `0.10.0`). */
export function olderVersion(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) < (right[index] ?? 0);
  }
  return false;
}

/**
 * The agent version machines should run: the `desiredAgentVersion` setting,
 * else the newest any enrolled machine runs (so one left behind stands out).
 */
export function desiredAgentVersion(setting, rows) {
  if (typeof setting === "string" && setting) return setting;
  return rows.map((row) => row.agent_version).filter(Boolean).reduce((newest, version) => (!newest || olderVersion(newest, version) ? version : newest), null);
}

/**
 * A machine as clients see it: its status (online, offline, draining,
 * unhealthy or revoked), VM (with when it last changed state and when it ran
 * in the last 24 hours), caps, labels, agent, clock skew and current runs.
 * `runs` are run rows; those this machine holds are listed.
 */
export function machineView(row, now, runs = [], { desiredVersion = null } = {}) {
  const machine = machineFromRow(row);
  const online = machine.lastSeenAt !== null && now - machine.lastSeenAt <= OFFLINE_MS;
  const unhealthy = unhealthyReason(machine.health);
  let status = "online";
  if (machine.revokedAt) status = "revoked";
  else if (!online) status = "offline";
  else if (machine.drain || machine.health.localDrain) status = "draining";
  else if (unhealthy) status = "unhealthy";
  const { vm = null, free = null, vmSince = null, vmHistory = [], ...facts } = machine.facts;
  const updateAvailable = !machine.revokedAt && olderVersion(machine.agentVersion, desiredVersion);
  return {
    id: machine.id,
    name: machine.name,
    status,
    ...(unhealthy ? { unhealthy } : {}),
    labels: machine.labels,
    capabilities: machine.capabilities,
    capacity: machine.capacity,
    vm,
    vmSince: iso(vmSince),
    vmHistory: vmHistory.map((span) => ({ from: iso(span.from), to: iso(span.to) })),
    free,
    facts,
    health: machine.health,
    agentVersion: machine.agentVersion,
    ...(updateAvailable ? { updateAvailable: true, desiredAgentVersion: desiredVersion } : {}),
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
export function waitingReason(job, run, machines, now, { globalPause, secrets = new Map() }) {
  const waited = `waiting ${minutes(now - run.due_at)}`;
  const blockers = claimBlockers(job, secrets);
  if (blockers.length) return `blocked: ${blockers.join("; ")}`;
  if (run.source !== "manual" && (job.paused || globalPause || !job.enabled)) return `${waited}: paused`;
  const required = job.placement?.requireLabels ?? {};
  const labelled = machines.filter((machine) => !machine.revokedAt && labelsMatch(required, machine.labels));
  if (!labelled.length) {
    const labels = Object.entries(required).map(([key, value]) => `${key}=${value}`).join(", ");
    return `${waited}: no machine has ${labels ? `labels ${labels}` : "enrolled"}`;
  }
  const matching = labelled.filter((machine) => !secretsRefused(job, machine, secrets).length);
  if (!matching.length) return `${waited}: no machine may receive ${secretsRefused(job, labelled[0], secrets).join(", ")} (the secrets' allowed labels)`;
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
 * Which machine a job's next run would most likely go to, or why none can:
 * hc-core's placement rules without capacity, which changes by the minute.
 */
export function expectedMachine(job, machines, now, secrets = new Map()) {
  const blockers = claimBlockers(job, secrets);
  if (blockers.length) return { machine: null, note: `blocked: ${blockers.join("; ")}` };
  const required = job.placement?.requireLabels ?? {};
  const matching = machines.filter((machine) => !machine.revokedAt && labelsMatch(required, machine.labels)
    && !secretsRefused(job, machine, secrets).length);
  if (!matching.length) {
    const labels = Object.entries(required).map(([key, value]) => `${key}=${value}`).join(", ");
    return { machine: null, note: labels ? `no machine has labels ${labels}` : "no machine enrolled" };
  }
  const preferred = job.placement?.preferMachines ?? [];
  const available = matching.filter((machine) => machineAvailable(machine, now));
  const pick = available.find((machine) => preferred.includes(machine.name)) ?? available[0];
  if (!pick) return { machine: null, note: "no machine online" };
  if (preferred.length && !preferred.includes(pick.name)) return { machine: pick.name, note: `preferred ${preferred.join(", ")} unavailable` };
  return { machine: pick.name };
}

/**
 * The next `count` slots across all jobs, soonest first, each with the
 * machine expected to take it. `next` is each job's own next due time
 * (upcomingAt); an `at` job's later slots follow from its timetable.
 */
export function upcomingSlots(jobs, next, machines, now, { globalPause = false, count = UPCOMING_SLOTS, secrets = new Map() } = {}) {
  if (globalPause) return [];
  const slots = [];
  for (const job of jobs) {
    if (!job.schedule || !job.enabled || job.paused) continue;
    const first = next.get(job.id);
    if (job.schedule.at) {
      let time = first ?? nextSlot(job.schedule.at, now);
      for (let index = 0; index < count; index += 1) {
        slots.push({ job, at: time });
        time = nextSlot(job.schedule.at, time);
      }
    } else if (first !== null && first !== undefined) {
      slots.push({ job, at: first });
    }
  }
  slots.sort((a, b) => a.at - b.at || a.job.id.localeCompare(b.job.id));
  const expected = new Map();
  return slots.slice(0, count).map(({ job, at }) => {
    if (!expected.has(job.id)) expected.set(job.id, expectedMachine(job, machines, now, secrets));
    return { job: job.id, at: iso(at), ...expected.get(job.id) };
  });
}

/**
 * The whole overview in one batch of indexed reads. Recent runs are a
 * correlated `IN (… LIMIT 5)` per job, which SQLite answers from runs_by_job;
 * a UNION ALL per job would hit D1's limit on compound SELECTs.
 */
export async function buildSnapshot(db, now) {
  const [jobs, open, settings, machines, recentRows, lastReportRows, latestRows, durationRows, lostRows, secretRows] = await db.batch([
    db.prepare(`SELECT j.*, s.last_slot_at, s.last_finished_at, s.published_json AS state_published_json
      FROM jobs j LEFT JOIN schedule_state s ON s.job_id = j.id ORDER BY j.id`),
    db.prepare(`SELECT ${RUN_LIST_COLUMNS} FROM runs WHERE state IN (${NON_TERMINAL_SQL})`),
    db.prepare("SELECT key, value_json FROM settings WHERE key IN ('global_pause', 'jobs_version', 'desired_agent_version')"),
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
    // The dashboard's duration sparkline: each job's last finished runs, a few narrow columns only.
    db.prepare(`SELECT r.id, r.job_id, r.state, r.outcome, r.started_at, r.finished_at, r.duration_ms FROM jobs j JOIN runs r ON r.id IN
      (SELECT id FROM runs WHERE job_id = j.id AND state IN ('succeeded', 'failed', 'timed-out') ORDER BY due_at DESC LIMIT ${SPARKLINE_RUNS})`),
    // Runs lost in the last day (runs_by_state), for the dashboard's attention list.
    db.prepare(`SELECT ${RUN_LIST_COLUMNS} FROM runs WHERE state = 'lost' AND due_at >= ? ORDER BY due_at DESC LIMIT 20`).bind(now - LOST_WINDOW_MS),
    // The vault's names and labels (never values): which jobs are blocked, and on which machines.
    db.prepare("SELECT name, allowed_labels_json FROM secrets"),
  ]);
  const secrets = new Map(secretRows.results.map((row) => [row.name, { allowedLabels: JSON.parse(row.allowed_labels_json ?? "{}") ?? {} }]));
  const alerts = await alertState(db, now);
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
  const durations = new Map();
  for (const row of durationRows.results) {
    if (!durations.has(row.job_id)) durations.set(row.job_id, []);
    durations.get(row.job_id).push(row);
  }
  const nextByJob = new Map();
  const jobsById = new Map();
  for (const runs of recent.values()) runs.sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt));
  const jobViews = jobs.results.map((row) => {
    const job = jobFromRow(row);
    jobsById.set(job.id, job);
    const blocked = claimBlockers(job, secrets);
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
    nextByJob.set(job.id, job.schedule?.at ? nextSlot(job.schedule.at, Math.max(now, row.last_slot_at ?? now)) : next);
    const view = {
      id: job.id,
      enabled: job.enabled && !job.paused,
      configuredEnabled: job.enabled,
      paused: job.paused,
      schedule: clientSchedule(job.schedule),
      image: job.image,
      parameters: job.args,
      resources: job.resources,
      placement: job.placement,
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
        ...(current.state === "due" ? { waiting: waitingReason(job, current, machineObjects, now, { globalPause, secrets }) } : {}),
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
      // Oldest first, for a sparkline: when each finished, how long it ran, how it ended.
      durations: (durations.get(job.id) ?? []).sort((a, b) => (a.finished_at ?? 0) - (b.finished_at ?? 0)).map((run) => ({
        id: run.id,
        at: iso(run.finished_at),
        seconds: seconds(run.duration_ms ?? between(run.started_at, run.finished_at)) ?? null,
        outcome: run.outcome ?? (run.state === "succeeded" ? "completed" : "failed"),
      })),
      runsUrl: `/v1/jobs/${job.id}/runs`,
    };
    return view;
  });
  const desiredVersion = desiredAgentVersion(setting.desired_agent_version, machines.results);
  const machineViews = machines.results.map((row) => machineView(row, now, open.results, { desiredVersion }));
  const activeRuns = open.results.map((row) => {
    const run = view(row);
    const job = jobsById.get(row.job_id);
    return row.state === "due" && job ? { ...run, waiting: waitingReason(job, row, machineObjects, now, { globalPause, secrets }) } : run;
  });
  return {
    version: 1,
    generatedAt: iso(now),
    controller: {
      status: "online",
      kind: "hosted",
      pollEvery: "60s",
      features: ["history", "logs", "timetable", "machines", "import", "audit", "changes", "settings", "job-parts", "machine-runs", "secrets", "alerts"],
      globalPause,
      // The cron's heartbeat: stale means slots are not being created (the dashboard says so on every page).
      cron: alerts.cron,
    },
    // What the owner is told by email (open problems, the last day's resolved ones) and whether email works.
    alerts: { open: alerts.open, resolved: alerts.resolved, email: alerts.email },
    timetable: { editable: true },
    jobs: jobViews,
    machines: machineViews,
    activeRuns,
    recentRuns: latestRows.results.map(view),
    // The next slots across jobs, each with the machine expected to take it.
    upcoming: upcomingSlots([...jobsById.values()], nextByJob, machineObjects, now, { globalPause, secrets }),
    // Runs whose machine went quiet in the last day; a later finished run of the job settles them for people.
    lostRuns: lostRows.results.map(view),
    desiredAgentVersion: desiredVersion,
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

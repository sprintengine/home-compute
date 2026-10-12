// POST /agent/v1/sync (§4.2): one request is the agent's heartbeat, its
// runs' progress and its claim. The cost is kept to a few round trips: the
// machine (authentication), one batch of reads, the job set from isolate
// memory, and one batch of writes that holds progress, the machine's row and
// the compare-and-set claims together. Lazy materialisation adds a few more
// only when a slot has come and the agent asked for work.

import { classifyLines } from "../../src/core/logs.mjs";
import {
  claimBlockers, effectiveFree, fits, labelsMatch, nextSyncDelay, placementRefusal, preferredUntil, secretsRefused, subtract,
  unhealthyReason,
} from "../../src/core/placement.mjs";
import {
  CLAIM_SCAN, LAST_SEEN_WRITE_MS, LEASE_MS, LEASE_RENEW_AFTER_MS, newCredential, sha256Hex, UPCOMING_MS,
} from "../../src/core/protocol.mjs";
import { createRedactor } from "../../src/core/redact.mjs";
import { ACTIVE_STATES, transition } from "../../src/core/run.mjs";
import { failedRunsStateSql, materialiseAll } from "./cron.mjs";
import { ACTIVE_SQL, auditStatement, machineFromRow } from "./db.mjs";
import { jobsAt } from "./jobcache.mjs";
import { rotationDue } from "./machines.mjs";
import { openSecretsFor, secretsAt } from "./secrets.mjs";
import { parseRegistryAuth, vaultNames } from "../../src/core/vault.mjs";

const ACTIVE = new Set(ACTIVE_STATES);
const PHASE_COLUMNS = { "starting-vm": "vm_started_at", pulling: "pull_started_at", running: "started_at", reporting: "reporting_at" };
/** The agent's settings for its runtime (§4.4); fixed until the dashboard can set them. */
export const AGENT_CONFIG = { idleStopSeconds: 300, keepWarmSeconds: 600 };
/** hc-core's own redaction: credential patterns only (the agent already removed the exact secret values). */
export const redactPatterns = createRedactor([]);

const RUN_COLUMNS = `id, job_id, state, source, attempt, machine_id, lease_expires_at, claimed_at, started_at, due_at,
  peak_memory_bytes, peak_cpu_pct, memory_limit_bytes, parameters_json, preferred_until`;

function parse(text, fallback) {
  try {
    return text === null || text === undefined ? fallback : JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** Due runs a machine might claim: the oldest 20 whose job has nothing active (runs_by_state, runs_one_active). */
function dueRunsQuery(db, now) {
  return db.prepare(`SELECT ${RUN_COLUMNS} FROM runs r WHERE r.state = 'due' AND r.due_at <= ?1
    AND NOT EXISTS (SELECT 1 FROM runs a WHERE a.job_id = r.job_id AND a.state IN (${ACTIVE_SQL}))
    ORDER BY r.due_at LIMIT ${CLAIM_SCAN}`).bind(now);
}

/** Upserts a run's log tail, redacted again here, unless its final tail is already stored. */
export function logTailStatement(db, runId, tail, { now, final = false }) {
  const textValue = redactPatterns(tail.text ?? "");
  const errorCount = tail.errorCount ?? classifyLines(textValue ? textValue.split("\n") : []).filter((line) => line.level === "error").length;
  return db.prepare(`INSERT INTO run_logs (run_id, tail, bytes_total, lines_total, truncated, error_count, final, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    ON CONFLICT(run_id) DO UPDATE SET tail = excluded.tail, bytes_total = excluded.bytes_total, lines_total = excluded.lines_total,
      truncated = excluded.truncated, error_count = excluded.error_count, final = excluded.final, updated_at = excluded.updated_at
    WHERE run_logs.final = 0`)
    .bind(runId, textValue, tail.bytesTotal ?? textValue.length, tail.linesTotal ?? null, tail.truncated ? 1 : 0, errorCount, final ? 1 : 0, now);
}

/**
 * The write a run's reported progress needs, or null: a phase moved forward
 * (stamped with the server's receipt time, §3.1), a new peak, or a lease
 * that is due for renewal. Compare-and-set on the state it was read in, so a
 * cancel or a timeout that lands meanwhile is never overwritten.
 */
function progressStatement(db, row, report, now) {
  const set = {};
  let state = row.state;
  if (report?.phase && report.phase !== row.state) {
    try {
      state = transition({ state: row.state }, { type: "phase", phase: report.phase, at: now }).state;
      if (state !== row.state) set[PHASE_COLUMNS[state]] = now;
    } catch {
      // A phase behind the server's is a stale report; the run stays where it is.
    }
  }
  const stats = report?.stats ?? {};
  if (stats.peakMemoryBytes !== null && stats.peakMemoryBytes !== undefined && stats.peakMemoryBytes > (row.peak_memory_bytes ?? 0)) {
    set.peak_memory_bytes = stats.peakMemoryBytes;
  }
  if (stats.cpuPct !== null && stats.cpuPct !== undefined && stats.cpuPct > (row.peak_cpu_pct ?? 0)) set.peak_cpu_pct = stats.cpuPct;
  if (stats.memoryLimitBytes && stats.memoryLimitBytes !== row.memory_limit_bytes) set.memory_limit_bytes = stats.memoryLimitBytes;
  if (row.lease_expires_at === null || row.lease_expires_at - now < LEASE_MS - LEASE_RENEW_AFTER_MS) set.lease_expires_at = now + LEASE_MS;
  if (!Object.keys(set).length) return null;
  set.state = state;
  set.updated_at = now;
  const columns = Object.keys(set);
  return db.prepare(`UPDATE runs SET ${columns.map((column) => `${column} = ?`).join(", ")}
    WHERE id = ? AND machine_id = ? AND state = ?`).bind(...columns.map((column) => set[column]), row.id, row.machine_id, row.state);
}

/**
 * What the claim answer tells the agent to run (§4.2): `secretEnv` holds the
 * opened `vault:` values (`values`, by secret name), only ever in this
 * answer; `local:` names the agent resolves from its own env file.
 */
export function claimOf(run, job, leaseExpiresAt, values = {}) {
  const extra = parse(run.parameters_json, []) ?? [];
  const localEnv = Object.entries(job.secretEnv ?? {})
    .filter(([, reference]) => reference.startsWith("local:"))
    .map(([name, reference]) => ({ name, from: reference.slice(6) }));
  const secretEnv = Object.fromEntries(Object.entries(job.secretEnv ?? {})
    .filter(([, reference]) => reference.startsWith("vault:") && typeof values[reference.slice(6)] === "string")
    .map(([name, reference]) => [name, values[reference.slice(6)]]));
  return {
    run: { id: run.id, jobId: run.job_id, attempt: run.attempt, source: run.source, dueAt: run.due_at, leaseExpiresAt },
    spec: {
      image: job.image,
      entrypoint: job.entrypoint,
      args: [...job.args, ...extra],
      env: job.env,
      secretEnv,
      localEnv,
      resources: job.resources,
      runSeconds: job.timeouts.runSeconds,
      network: job.network,
      report: job.report,
      ...(job.registryAuth && values[job.registryAuth.slice(6)] ? { registryAuth: parseRegistryAuth(values[job.registryAuth.slice(6)]) } : {}),
    },
  };
}

/**
 * Which due runs this machine takes now: those its placement allows and
 * whose job is runnable (manual runs go ahead even when the job or
 * everything is paused), by priority then age, while they fit what is free.
 * Also returns when a preference window that held a run back ends.
 */
export function chooseClaims({ due, jobs, machine, machines, free, globalPause, now, secrets = new Map() }) {
  const options = [];
  const events = [];
  for (const run of due) {
    const job = jobs.get(run.job_id);
    if (!job) continue;
    if (run.source !== "manual" && (!job.enabled || job.paused || globalPause)) continue;
    if (claimBlockers(job, secrets).length || secretsRefused(job, machine, secrets).length) continue;
    const refusal = placementRefusal(job, { preferredUntil: run.preferred_until }, machine, { machines, now });
    if (refusal === "preferred") events.push(run.preferred_until);
    if (refusal) continue;
    options.push({ run, job });
  }
  options.sort((a, b) => (b.job.policy?.priority ?? 0) - (a.job.policy?.priority ?? 0) || a.run.due_at - b.run.due_at);
  const chosen = [];
  let left = free;
  for (const option of options) {
    if (!fits(option.job.resources, left)) continue;
    chosen.push(option);
    left = subtract(left, option.job.resources);
  }
  return { chosen, events };
}

/**
 * The jobs whose runs this machine could take, whatever its free capacity:
 * `any` for every run, `manual` for manual runs only (which ignore pauses).
 */
function possibleJobs(jobs, machine, globalPause, secrets) {
  const any = [];
  const manual = [];
  for (const job of jobs.values()) {
    if (claimBlockers(job, secrets).length || secretsRefused(job, machine, secrets).length) continue;
    if (!labelsMatch(job.placement?.requireLabels, machine.labels)) continue;
    manual.push(job.id);
    if (job.enabled && !job.paused && !globalPause) any.push(job.id);
  }
  return { any, manual };
}

const VM_HISTORY_MS = 24 * 3_600_000;
const VM_HISTORY_MAX = 48;

/**
 * When the machine's VM last changed state (`vmSince`) and when it ran over
 * the last 24 hours (`vmHistory`: `[{from, to}]`, `to` null while it runs),
 * from the states its syncs report, stamped with the server's time (§4.4: the
 * dashboard measures VM uptime per machine). Only a change of state changes
 * these, and a change of state already writes the row, so this adds no writes.
 */
export function vmTimeline(previous, vm, now) {
  const before = previous?.vm?.state ?? null;
  const after = vm?.state ?? null;
  let history = Array.isArray(previous?.vmHistory) ? previous.vmHistory : [];
  if (before === after) return previous?.vmSince === undefined ? {} : { vmSince: previous.vmSince, vmHistory: history };
  if (before === "running") history = history.map((span) => (span.to === null ? { ...span, to: now } : span));
  if (after === "running") history = [...history, { from: now, to: null }];
  history = history.filter((span) => span.to === null || span.to > now - VM_HISTORY_MS).slice(-VM_HISTORY_MAX);
  return { vmSince: now, vmHistory: history };
}

/** The machine's row after this sync, as a statement, or null when nothing worth writing changed. */
function machineStatement(db, row, request, { now, ip, rotation }) {
  // Free disk moves all the time; storing it would write the row on every sync.
  const { diskMiB, ...free } = request.machine.free;
  const previous = parse(row.facts_json, {});
  const facts = { ...previous, vm: request.machine.vm, free, ...vmTimeline(previous, request.machine.vm, now) };
  const health = { ...request.machine.health, localDrain: request.machine.drain };
  const skew = request.agentTime === null ? null : Math.round(request.agentTime - now);
  const factsJson = JSON.stringify(facts);
  const healthJson = JSON.stringify(health);
  const changed = factsJson !== row.facts_json || healthJson !== row.health_json || (request.agentVersion ?? row.agent_version) !== row.agent_version
    || (ip ?? row.last_ip) !== row.last_ip || (skew !== null && (row.clock_skew_ms === null || Math.abs(skew - row.clock_skew_ms) > 1000));
  const stale = row.last_seen_at === null || now - row.last_seen_at >= LAST_SEEN_WRITE_MS;
  if (!changed && !stale && !rotation) return null;
  return db.prepare(`UPDATE machines SET facts_json = ?, health_json = ?, agent_version = ?, last_seen_at = ?, last_ip = ?, clock_skew_ms = ?,
      credential_next_hash = COALESCE(?, credential_next_hash) WHERE id = ?`)
    .bind(factsJson, healthJson, request.agentVersion ?? row.agent_version, now, ip ?? row.last_ip, skew ?? row.clock_skew_ms,
      rotation?.hash ?? null, row.id);
}

/**
 * The claims' answers, each with the vault secrets its job names, opened for
 * this machine (§5). A claimed run whose secret cannot be given (deleted
 * since the claim was decided, not for these labels, or not opening) is
 * failed at once with the reason, never started without it.
 */
async function withSecrets(db, env, machine, claimed, now) {
  const names = [...new Set(claimed.flatMap(({ job }) => vaultNames(job)))];
  if (!names.length) return claimed.map(({ run, job, lease }) => claimOf(run, job, lease));
  const { values, refused } = await openSecretsFor(db, env, names, machine.labels);
  const why = new Map(refused.map((entry) => [entry.name, entry.reason]));
  // A registry credential that is not {server, username, password} JSON is refused like a missing one.
  for (const { job } of claimed) {
    const name = job.registryAuth?.slice(6);
    if (name && name in values && !parseRegistryAuth(values[name])) why.set(name, "is not a registry credential ({server, username, password} JSON)");
  }
  const claims = [];
  const failures = [];
  for (const { run, job, lease } of claimed) {
    const missing = vaultNames(job).filter((name) => why.has(name));
    if (!missing.length) {
      claims.push(claimOf(run, job, lease, values));
      continue;
    }
    const error = `vault: ${missing.map((name) => `${name} ${why.get(name)}`).join("; ")}`;
    console.error(JSON.stringify({ event: "claim_secret_refused", run: run.id, job: run.job_id, machine: machine.id, error }));
    failures.push(db.prepare(`UPDATE runs SET state = 'failed', outcome = 'failed', error = ?1, finished_at = ?2, lease_expires_at = NULL,
        updated_at = ?2 WHERE id = ?3 AND state = 'claimed' AND machine_id = ?4`).bind(error, now, run.id, machine.id));
  }
  if (failures.length) {
    const failed = claimed.filter(({ run, job }) => vaultNames(job).some((name) => why.has(name))).map(({ run }) => ({ run: run.id, job: run.job_id }));
    await db.batch([...failures, db.prepare(failedRunsStateSql()).bind(now, JSON.stringify(failed))]);
  }
  return claims;
}

export async function sync(db, request, { machine: row, rotated, now, ip, env = {} }) {
  const reportedIds = request.runs.map((run) => run.id);
  const [settingRows, runRows, scheduleRows, dueRows, machineRows] = (await db.batch([
    db.prepare("SELECT key, value_json FROM settings WHERE key IN ('jobs_version', 'global_pause', 'secrets_version')"),
    db.prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE id IN (SELECT value FROM json_each(?1))
      UNION SELECT ${RUN_COLUMNS} FROM runs WHERE machine_id = ?2 AND state IN (${ACTIVE_SQL})`).bind(JSON.stringify(reportedIds), row.id),
    db.prepare("SELECT job_id, next_due_at FROM schedule_state WHERE next_due_at IS NOT NULL AND next_due_at <= ?").bind(now + UPCOMING_MS),
    dueRunsQuery(db, now),
    db.prepare("SELECT id, name, labels_json, drain, last_seen_at, health_json, revoked_at FROM machines WHERE revoked_at IS NULL"),
  ])).map((result) => result.results);
  const settings = Object.fromEntries(settingRows.map((setting) => [setting.key, parse(setting.value_json, null)]));
  const globalPause = settings.global_pause === true;
  const jobs = await jobsAt(db, String(settings.jobs_version ?? 0));
  const secrets = await secretsAt(db, String(settings.secrets_version ?? 0));
  const machine = machineFromRow(row);
  const machines = machineRows.map(machineFromRow);

  const writes = [];
  const cancel = [];
  const byId = new Map(runRows.map((run) => [run.id, run]));
  const reported = new Map(request.runs.map((run) => [run.id, run]));
  // 1. The runs the agent reports: progress for active ones; cancel for any the server has finished or never gave it.
  for (const report of request.runs) {
    const run = byId.get(report.id);
    if (!run || run.machine_id !== row.id) {
      cancel.push(report.id);
      continue;
    }
    if (run.state === "lost") {
      // Its lease ran out; a late completion is still welcome (recovered), so it is not cancelled.
      if (report.logTail) writes.push(logTailStatement(db, run.id, report.logTail, { now }));
      continue;
    }
    if (!ACTIVE.has(run.state)) {
      cancel.push(report.id);
      continue;
    }
    const progress = progressStatement(db, run, report, now);
    if (progress) writes.push(progress);
    if (report.logTail) writes.push(logTailStatement(db, run.id, report.logTail, { now }));
  }
  // 2. A run claimed for this machine that its agent does not mention: the answer carrying the claim never arrived. Send it again.
  const holding = runRows.filter((run) => run.machine_id === row.id && ACTIVE.has(run.state) && !cancel.includes(run.id));
  const resend = holding.filter((run) => run.state === "claimed" && !reported.has(run.id) && run.claimed_at < now && jobs.has(run.job_id));
  for (const run of resend) {
    const progress = progressStatement(db, run, null, now);
    if (progress) writes.push(progress);
  }

  // 3. Claims.
  let claimable = [];
  const events = [];
  let free = effectiveFree(request.machine.free, machine.capacity, holding.map((run) => jobs.get(run.job_id)?.resources ?? {}));
  // A run sent again is not in what the agent counts as taken yet.
  for (const run of resend) free = subtract(free, jobs.get(run.job_id)?.resources ?? {});
  const mayClaim = request.claim && !machine.drain && !request.machine.drain && unhealthyReason(request.machine.health) === null && fits({}, free);
  if (mayClaim) {
    let due = dueRows;
    const dueJobs = scheduleRows.filter((state) => state.next_due_at <= now).map((state) => state.job_id);
    if (dueJobs.length) {
      // Lazy materialisation (§3.2): a slot that has come is created here if the cron has not yet; both are idempotent.
      const materialised = await materialiseAll(db, now, { jobIds: dueJobs });
      if (materialised.created) due = (await dueRunsQuery(db, now).all()).results;
    }
    let choice = chooseClaims({ due, jobs, machine, machines, free, globalPause, now, secrets });
    if (!choice.chosen.length && due.length === CLAIM_SCAN) {
      // The oldest 20 were all for others (blocked, paused, wrong labels): look again among the jobs this machine could take.
      const possible = possibleJobs(jobs, machine, globalPause, secrets);
      due = (await db.prepare(`SELECT ${RUN_COLUMNS} FROM runs r WHERE r.state = 'due' AND r.due_at <= ?1
          AND (r.job_id IN (SELECT value FROM json_each(?2)) OR (r.source = 'manual' AND r.job_id IN (SELECT value FROM json_each(?3))))
          AND NOT EXISTS (SELECT 1 FROM runs a WHERE a.job_id = r.job_id AND a.state IN (${ACTIVE_SQL}))
        ORDER BY r.due_at LIMIT ${CLAIM_SCAN}`).bind(now, JSON.stringify(possible.any), JSON.stringify(possible.manual)).all()).results;
      choice = chooseClaims({ due, jobs, machine, machines, free, globalPause, now, secrets });
    }
    claimable = choice.chosen;
    events.push(...choice.events);
  }
  const leaseExpiresAt = now + LEASE_MS;
  const claimIndex = [];
  for (const { run, job } of claimable) {
    claimIndex.push(writes.length);
    writes.push(db.prepare(`UPDATE runs SET state = 'claimed', machine_id = ?1, lease_expires_at = ?2, claimed_at = ?3, job_revision = ?4,
        image_ref = ?5, memory_limit_bytes = ?6, updated_at = ?3
      WHERE id = ?7 AND state = 'due' AND NOT EXISTS (SELECT 1 FROM runs a WHERE a.job_id = ?8 AND a.state IN (${ACTIVE_SQL}))`)
      .bind(row.id, leaseExpiresAt, now, job.revision, job.image, job.resources.memoryMiB * 1048576, run.id, run.job_id));
  }

  // 4. The machine's own row: health, facts, last seen (throttled), and a credential rotation when one is due.
  let rotateCredential = null;
  let rotation = null;
  if (!rotated && rotationDue(row, now)) {
    rotateCredential = { credential: newCredential(row.id) };
    rotation = { hash: await sha256Hex(rotateCredential.credential) };
  }
  const machineWrite = machineStatement(db, row, request, { now, ip, rotation });
  if (machineWrite) writes.push(machineWrite);
  if (ip && row.last_ip && ip !== row.last_ip) {
    writes.push(auditStatement(db, { at: now, actor: `machine:${row.id}`, action: "machine.new-ip", target: row.id, before: { ip: row.last_ip }, after: { ip } }));
  }

  const results = writes.length ? await db.batch(writes) : [];
  const won = claimable.filter((_, index) => results[claimIndex[index]].meta.changes === 1);
  const claims = await withSecrets(db, env, machine, [
    ...resend.map((run) => ({ run, job: jobs.get(run.job_id), lease: Math.max(run.lease_expires_at ?? 0, leaseExpiresAt) })),
    ...won.map(({ run, job }) => ({ run, job, lease: leaseExpiresAt })),
  ], now);

  // 5. What is coming for this machine, and when to sync next.
  const upcoming = [];
  for (const state of scheduleRows) {
    if (state.next_due_at <= now) continue;
    const job = jobs.get(state.job_id);
    if (!job || !job.enabled || job.paused || globalPause || claimBlockers(job, secrets).length) continue;
    if (secretsRefused(job, machine, secrets).length) continue;
    if (!labelsMatch(job.placement?.requireLabels, machine.labels)) continue;
    const preferred = (job.placement?.preferMachines ?? []).includes(machine.name);
    const others = job.placement?.preferMachines?.length && !preferred;
    // A slot another machine is preferred for: this one takes it only if that one cannot, so it does not pre-warm for it (§4.4).
    upcoming.push({ jobId: job.id, dueAt: state.next_due_at, cpus: job.resources.cpus, memoryMiB: job.resources.memoryMiB, preferred,
      ...(others ? { preferredElsewhere: true } : {}) });
    events.push(others ? preferredUntil(job, state.next_due_at) : state.next_due_at);
  }
  upcoming.sort((a, b) => a.dueAt - b.dueAt);
  const busy = claims.length > 0 || holding.length > 0 || request.runs.some((run) => !cancel.includes(run.id));
  return {
    serverTime: now,
    nextSyncInMs: nextSyncDelay({ busy, events, now }),
    claims,
    cancel,
    upcoming,
    config: AGENT_CONFIG,
    update: null,
    provisioningTasks: [],
    rotateCredential,
  };
}

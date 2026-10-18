// The Cloudflare Containers executor. The minute cron (and the dashboard's
// Run now and Cancel, through hc-core's `Dispatcher` entrypoint) calls
// `dispatchCloudflare`, which checks the runs already going and starts the
// ones that are due; it never waits out a run. Each run is a Durable Object
// (container-do.mjs) whose alarm keeps the container alive for the run,
// renews the run's lease while the container answers, keeps the dashboard's
// log tail current, and settles the run through `recordContainerStop`: the
// same `runs` row, log and reports an agent's completion writes. Secrets are
// handed to the container and are not written to D1.

import {
  CLOUDFLARE_LEASE_MS, CLOUDFLARE_MACHINE_ID, CLOUDFLARE_MACHINE_NAME, CLOUDFLARE_RUNTIME, CONTAINER_INCLUDED, CONTAINER_PRICES,
  DEFAULT_GUARD, INSTANCE_BINDINGS, INSTANCE_TYPES, containerCommand, deployedInstanceTypes, estimateContainerCost,
  executorLabels, exitCodeFromError, imageDigest, imagesMatch, interpretExit, localSecretNames, normaliseGuard, selectInstanceType, startIsTransient,
  targetsCloudflare,
} from "../../src/core/cloudflare.mjs";
import { boundLines, extractError } from "../../src/core/logs.mjs";
import { claimBlockers, secretsRefused } from "../../src/core/placement.mjs";
import { FINAL_TAIL, MAX_ERROR_DETAIL, MAX_LINE_CHARS } from "../../src/core/protocol.mjs";
import { createRedactor, redactValue, secretForms } from "../../src/core/redact.mjs";
import { parseReports, runOutcome } from "../../src/core/reports.mjs";
import { vaultNames } from "../../src/core/vault.mjs";
import { complete } from "./complete.mjs";
import { ACTIVE_SQL, bumpMachinesVersion, readSettings } from "./db.mjs";
import { iso, json } from "./http.mjs";
import { jobsAt } from "./jobcache.mjs";
import { openSecretsFor, secretsAt } from "./secrets.mjs";
import { logTailStatement } from "./sync.mjs";

const MACHINE = { id: CLOUDFLARE_MACHINE_ID };
const USAGE_WINDOW_MS = 30 * 86_400_000;
const DUE_SCAN = 20;

function parse(text, fallback = null) {
  try {
    return text === null || text === undefined ? fallback : JSON.parse(text);
  } catch {
    return fallback;
  }
}

function randomHex(bytes = 32) {
  const buffer = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buffer].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeError(error) {
  return String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 300);
}

function stubFor(binding, name) {
  if (typeof binding.getByName === "function") return binding.getByName(name);
  return binding.get(binding.idFromName(name));
}

async function currentJobs(db) {
  const row = await db.prepare("SELECT value_json FROM settings WHERE key = 'jobs_version'").first();
  return jobsAt(db, String(parse(row?.value_json, 0)));
}

/** The real starter: one Durable Object, named for the run, per start. Answers the image the container runs, when it says. */
export function starterFromEnv(env) {
  return {
    async start(spec) {
      const binding = env[spec.binding];
      if (!binding) throw new Error(`instance type ${spec.instanceType} is not deployed (binding ${spec.binding} is missing on hc-core)`);
      return stubFor(binding, spec.runId).startRun(spec);
    },
  };
}

/** The values a run's output is redacted of: its vault secrets, opened again (a restarted Durable Object no longer holds them). */
export async function secretValuesForJob(env, jobId) {
  const job = (await currentJobs(env.DB)).get(jobId);
  const names = job ? vaultNames(job) : [];
  if (!names.length) return [];
  try {
    const opened = await openSecretsFor(env.DB, env, names, executorLabels((await loadGuard(env.DB)).labels));
    return Object.values(opened.values).filter((value) => typeof value === "string");
  } catch (error) {
    console.error(JSON.stringify({ event: "container_redaction_secrets_error", job: jobId, error: safeError(error) }));
    return [];
  }
}

function redactedLines(lines, secretValues) {
  const redact = createRedactor(secretForms(secretValues ?? []));
  return (lines ?? []).map((line) => {
    const text = redact(line);
    return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)} …[line cut]` : text;
  });
}

function tailFrom(probe, secretValues, bounds) {
  const lines = redactedLines(probe?.tailLines, secretValues);
  const { lines: kept, truncated } = boundLines(lines, bounds);
  const linesTotal = probe?.linesTotal ?? lines.length;
  return {
    lines,
    tail: {
      text: kept.join("\n"),
      bytesTotal: probe?.bytesTotal ?? kept.join("\n").length,
      linesTotal,
      truncated: truncated || linesTotal > kept.length,
    },
  };
}

/** The statement that stores a running (or, with `final`, a closing) log tail from a probe. */
export function runningTail(db, runId, probe, secretValues, now, bounds, { final = false } = {}) {
  return logTailStatement(db, runId, tailFrom(probe, secretValues, bounds ?? FINAL_TAIL).tail, { now, final });
}

/**
 * Settles a container run through the same completion as an agent: exit
 * code, outcome from the job's reports, error and detail from its output,
 * the final log tail. `lost` does not settle: destroying a container the
 * lease already gave up on must not record a SIGKILL as the run's result.
 */
export async function recordContainerStop(db, runId, details, now) {
  if (details.stopReason === "lost") return { ignored: true, reason: "lost" };
  const run = await db.prepare("SELECT * FROM runs WHERE id = ?").bind(runId).first();
  if (!run || run.machine_id !== CLOUDFLARE_MACHINE_ID) return { ignored: true, reason: "not-ours" };
  const job = (await currentJobs(db)).get(run.job_id) ?? null;
  const prior = parse(run.metrics_json, {}) ?? {};
  const peakMemoryBytes = details.peakMemoryBytes ?? run.peak_memory_bytes ?? null;
  const interpreted = details.failed
    ? { failed: true, timedOut: false, oomKilled: false, exitCode: null, cancelled: false }
    : interpretExit({
      exitCode: details.exitCode ?? null,
      peakMemoryBytes,
      memoryLimitBytes: run.memory_limit_bytes,
      stopReason: details.stopReason ?? null,
    });
  const { lines, tail } = details.probe ? tailFrom(details.probe, details.secretValues, FINAL_TAIL) : { lines: [], tail: null };
  const redact = createRedactor(secretForms(details.secretValues ?? []));
  const reports = details.probe ? redactValue(parseReports(redactedLines(details.probe.reportLines, details.secretValues).join("\n")), redact) : [];
  let error = details.error ?? null;
  let errorDetail = null;
  if (!error && !interpreted.cancelled) {
    const outcome = runOutcome({ ...interpreted, reports, report: job?.report });
    if (outcome === "failed") {
      ({ error, errorDetail } = extractError(lines, {
        reports, oomKilled: interpreted.oomKilled, memoryLimitBytes: run.memory_limit_bytes, timedOut: interpreted.timedOut,
        runSeconds: job?.timeouts?.runSeconds ?? null, exitCode: interpreted.exitCode, maxDetail: MAX_ERROR_DETAIL,
      }));
    }
  }
  const startedAt = run.started_at;
  const container = prior.instanceType ? {
    instanceType: prior.instanceType,
    ...(prior.vcpu !== undefined ? { vcpu: prior.vcpu } : {}),
    ...(prior.memoryMiB !== undefined ? { memoryMiB: prior.memoryMiB } : {}),
    ...(prior.diskMiB !== undefined ? { diskMiB: prior.diskMiB } : {}),
    ...(typeof startedAt === "number" ? { containerSeconds: Math.max(0, Math.round((now - startedAt) / 1000)) } : {}),
  } : {};
  const record = {
    exitCode: interpreted.exitCode,
    oomKilled: interpreted.oomKilled,
    timedOut: interpreted.timedOut,
    failed: interpreted.failed,
    cancelled: interpreted.cancelled,
    error,
    errorDetail,
    reports,
    ...(tail ? { logTail: tail } : {}),
    stats: {
      peakMemoryBytes,
      memoryLimitBytes: run.memory_limit_bytes,
      avgCpuPct: null,
      peakCpuPct: null,
      cpuSeconds: details.cpuSeconds ?? null,
      samples: peakMemoryBytes || details.cpuSeconds ? 1 : 0,
    },
    durations: {
      durationMs: typeof startedAt === "number" ? Math.max(0, now - startedAt) : null,
      vmWaitMs: null,
      pullMs: null,
    },
    image: { ref: run.image_ref, digest: run.image_digest },
    container,
  };
  return complete(db, runId, record, { machine: MACHINE, now });
}

/** Container-seconds over the last 30 days, including runs still going, and the list-price upper bound. */
export async function containerUsage(db, now, guard = DEFAULT_GUARD) {
  const since = now - USAGE_WINDOW_MS;
  const [finished, active] = await db.batch([
    db.prepare(`SELECT metrics_json, started_at, finished_at FROM runs
      WHERE machine_id = ?1 AND finished_at IS NOT NULL AND finished_at >= ?2 AND metrics_json IS NOT NULL`).bind(CLOUDFLARE_MACHINE_ID, since),
    db.prepare(`SELECT metrics_json, started_at FROM runs
      WHERE machine_id = ?1 AND state IN (${ACTIVE_SQL}) AND started_at IS NOT NULL AND metrics_json IS NOT NULL`).bind(CLOUDFLARE_MACHINE_ID),
  ]);
  const byInstanceType = {};
  const add = (metricsText, seconds) => {
    const metrics = parse(metricsText, {});
    if (!metrics?.instanceType || seconds <= 0) return;
    byInstanceType[metrics.instanceType] = (byInstanceType[metrics.instanceType] ?? 0) + seconds;
  };
  for (const row of finished.results) add(row.metrics_json, Number(parse(row.metrics_json, {})?.containerSeconds) || Math.max(0, Math.round(((row.finished_at ?? now) - (row.started_at ?? row.finished_at)) / 1000)));
  let activeRuns = 0;
  for (const row of active.results) {
    activeRuns += 1;
    add(row.metrics_json, Math.max(0, Math.round((now - row.started_at) / 1000)));
  }
  return {
    machineId: CLOUDFLARE_MACHINE_ID,
    machine: CLOUDFLARE_MACHINE_NAME,
    windowDays: 30,
    since: iso(since),
    byInstanceType,
    active: activeRuns,
    maxConcurrent: guard.maxConcurrent,
    maxRunSeconds: guard.maxRunSeconds,
    included: CONTAINER_INCLUDED,
    prices: CONTAINER_PRICES,
    ...estimateContainerCost(byInstanceType),
  };
}

async function loadGuard(db) {
  const stored = await readSettings(db, ["cloudflare"]);
  return normaliseGuard(stored.cloudflare ?? {});
}

function capacityOf(deployed, guard) {
  const largest = INSTANCE_TYPES[deployed.at(-1) ?? "basic"];
  return { cpus: largest.vcpu, memoryMiB: largest.memoryMiB, diskMiB: largest.diskMiB, maxRuns: guard.maxConcurrent };
}

/** Creates the virtual machine the first time a job targets it. A revoked row stays revoked. */
async function ensureExecutor(db, now, guard, deployed) {
  const existing = await db.prepare("SELECT id, revoked_at, drain, last_seen_at, facts_json, capacity_json, labels_json FROM machines WHERE id = ?").bind(CLOUDFLARE_MACHINE_ID).first();
  if (existing) return existing;
  const named = await db.prepare("SELECT id FROM machines WHERE name = ?").bind(CLOUDFLARE_MACHINE_NAME).first();
  if (named) {
    console.error(JSON.stringify({ event: "cloudflare_executor_name_taken", machine: named.id }));
    return { error: `a machine is already named ${CLOUDFLARE_MACHINE_NAME}` };
  }
  const capacity = capacityOf(deployed, guard);
  const inserted = await db.batch([
    db.prepare(`INSERT INTO machines (id, name, labels_json, capabilities, capacity_json, facts_json, health_json, agent_version,
        credential_hash, credential_issued_at, drain, enrolled_at)
      VALUES (?1, ?2, ?3, '', ?4, '{}', '{"docker":"ok"}', NULL, ?5, ?6, 0, ?6)
      ON CONFLICT DO NOTHING`).bind(
      CLOUDFLARE_MACHINE_ID, CLOUDFLARE_MACHINE_NAME, JSON.stringify(executorLabels(guard.labels)), JSON.stringify(capacity), randomHex(32), now,
    ),
    bumpMachinesVersion(db),
  ]);
  if (inserted[0].meta.changes !== 1) return db.prepare("SELECT id, revoked_at, drain, last_seen_at, facts_json, capacity_json, labels_json FROM machines WHERE id = ?").bind(CLOUDFLARE_MACHINE_ID).first();
  return {
    id: CLOUDFLARE_MACHINE_ID, revoked_at: null, drain: 0, last_seen_at: null, facts_json: "{}", capacity_json: JSON.stringify(capacity),
    labels_json: JSON.stringify(executorLabels(guard.labels)),
  };
}

/** What the dashboard's machine page shows for the executor: the deployed image and sizes, the guard, and the 30-day cost. */
async function touchExecutor(db, row, now, guard, usage, { deployed, image, source }) {
  const facts = {
    runtime: "cloudflare-containers", os: "linux", arch: "amd64",
    image: image || null,
    imageDigest: imageDigest(image),
    imageSource: source || null,
    instanceTypes: deployed,
    containerSeconds30d: usage.containerSeconds,
    estimatedUsd30d: Number(usage.estimatedUsd.toFixed(6)),
    maxConcurrent: guard.maxConcurrent,
    maxRunSeconds: guard.maxRunSeconds,
  };
  const factsJson = JSON.stringify(facts);
  const capacityJson = JSON.stringify(capacityOf(deployed, guard));
  const labelsJson = JSON.stringify(executorLabels(guard.labels));
  const stale = row.last_seen_at === null || now - row.last_seen_at >= 60_000;
  const relabelled = labelsJson !== (row.labels_json ?? labelsJson);
  if (!stale && !relabelled && factsJson === row.facts_json && capacityJson === (row.capacity_json ?? "")) return;
  // A change of labels (settings.cloudflare.labels) is a change of machines: dashboards are told.
  await db.batch([
    db.prepare(`UPDATE machines SET facts_json = ?1, capacity_json = ?2, labels_json = ?5, health_json = '{"docker":"ok"}', last_seen_at = ?3
      WHERE id = ?4 AND revoked_at IS NULL`).bind(factsJson, capacityJson, now, CLOUDFLARE_MACHINE_ID, labelsJson),
    ...(relabelled ? [bumpMachinesVersion(db)] : []),
  ]);
}

async function stampContainerSeconds(db) {
  await db.prepare(`UPDATE runs SET metrics_json = json_set(metrics_json, '$.containerSeconds', MAX(0, (finished_at - started_at) / 1000))
    WHERE machine_id = ?1 AND finished_at IS NOT NULL AND started_at IS NOT NULL
      AND json_extract(metrics_json, '$.instanceType') IS NOT NULL
      AND json_extract(metrics_json, '$.containerSeconds') IS NULL`).bind(CLOUDFLARE_MACHINE_ID).run();
}

/** How long after a run ends elsewhere (cancelled, timed out, lost) its object is still asked to check, so its container goes at once. */
const ENDED_CHECK_MS = 30 * 60_000;

/**
 * Asks the Durable Object of each run going, and of each run that ended
 * elsewhere in the last half hour, to check its container. The object
 * renews the lease only when the container answers, so nothing here renews
 * one: a run whose container is gone is marked lost by `expireLeases`. An
 * ended run's object destroys its container (a cancel takes effect at once,
 * and the instance is free for the next run).
 */
async function checkActive(env, db, now) {
  const { results } = await db.prepare(`SELECT id, metrics_json FROM runs WHERE machine_id = ?1
    AND (state IN (${ACTIVE_SQL}) OR (state IN ('cancelled', 'timed-out', 'lost') AND updated_at >= ?2))`)
    .bind(CLOUDFLARE_MACHINE_ID, now - ENDED_CHECK_MS).all();
  await Promise.all(results.map(async (run) => {
    const instanceType = parse(run.metrics_json, {})?.instanceType ?? "basic";
    const binding = env[INSTANCE_BINDINGS[instanceType] ?? ""];
    if (!binding) return;
    try {
      await stubFor(binding, run.id).tick();
    } catch (error) {
      console.error(JSON.stringify({ event: "container_tick_error", run: run.id, error: safeError(error) }));
    }
  }));
}

async function failRun(db, runId, error, now) {
  await recordContainerStop(db, runId, { failed: true, error }, now);
}

async function claimRun(db, run, job, selected, image, now) {
  const metrics = { instanceType: selected.name, memoryMiB: selected.memoryMiB, diskMiB: selected.diskMiB };
  if (typeof selected.vcpu === "number") metrics.vcpu = selected.vcpu;
  const result = await db.prepare(`UPDATE runs SET state = 'claimed', machine_id = ?1, lease_expires_at = ?2, claimed_at = ?3,
      job_revision = ?4, image_ref = ?5, image_digest = ?6, memory_limit_bytes = ?7, metrics_json = ?8, updated_at = ?3
    WHERE id = ?9 AND state = 'due'
      AND NOT EXISTS (SELECT 1 FROM runs a WHERE a.job_id = ?10 AND a.state IN (${ACTIVE_SQL}))`)
    .bind(
      CLOUDFLARE_MACHINE_ID, now + CLOUDFLARE_LEASE_MS, now, job.revision, job.image, imageDigest(image) ?? imageDigest(job.image),
      selected.memoryMiB * 1048576, JSON.stringify(metrics), run.id, run.job_id,
    ).run();
  return result.meta.changes === 1;
}

/** A start that may work in a later minute (no instance free yet): the claim is undone and the run waits again. */
async function unclaim(db, runId, now) {
  await db.prepare(`UPDATE runs SET state = 'due', machine_id = NULL, lease_expires_at = NULL, claimed_at = NULL, started_at = NULL,
      image_ref = NULL, image_digest = NULL, memory_limit_bytes = NULL, metrics_json = NULL, updated_at = ?1
    WHERE id = ?2 AND state IN ('claimed', 'running') AND machine_id = ?3`).bind(now, runId, CLOUDFLARE_MACHINE_ID).run();
}

function secretEnv(job, values) {
  return Object.fromEntries(Object.entries(job.secretEnv ?? {})
    .filter(([, reference]) => reference.startsWith("vault:") && typeof values[reference.slice(6)] === "string")
    .map(([name, reference]) => [name, values[reference.slice(6)]]));
}

/** Why this run cannot start on Cloudflare at all (it is claimed and failed so the schedule moves on), or an empty list. */
function startProblems(job, selected, guard, image, source) {
  const problems = [];
  if (!selected.ok) problems.push(selected.error);
  if (job.timeouts.runSeconds > guard.maxRunSeconds) {
    problems.push(`timeouts.runSeconds ${job.timeouts.runSeconds} exceeds the Cloudflare guard of ${guard.maxRunSeconds}s`);
  }
  const local = localSecretNames(job);
  if (local.length) problems.push(`local: secrets are not available on Cloudflare Containers (${local.join(", ")}); use vault: secrets`);
  if (!image) problems.push("no Cloudflare container image is deployed: run cloud/scripts/set-container-image.sh, then deploy hc-core");
  else if (!imagesMatch(job.image, image, source)) problems.push(`job image ${job.image} is not the image deployed on Cloudflare (${image})`);
  if (!containerCommand(job, [])) problems.push("a Cloudflare job needs an entrypoint: the image's own entrypoint cannot be wrapped to read its output");
  return problems;
}

/**
 * One pass: check the runs going, then start what is due, up to the guard.
 * No-ops (one indexed read) when no job targets `runtime=cloudflare-container`,
 * so a deployment that never uses this executor does not gain a machine row.
 */
export async function dispatchCloudflare(env, now, options = {}) {
  const db = env.DB;
  const labelled = await db.prepare("SELECT id FROM jobs WHERE json_extract(placement_json, '$.requireLabels.runtime') = ? LIMIT 1")
    .bind(CLOUDFLARE_RUNTIME).first();
  if (!labelled) return { jobs: 0 };
  const summary = { jobs: 1, started: 0, failed: 0, leftDue: 0 };
  const deployed = options.deployed ?? (options.starter ? ["basic"] : deployedInstanceTypes(env));
  const image = options.image ?? env.HC_CONTAINER_IMAGE ?? "";
  const source = options.source ?? env.HC_CONTAINER_SOURCE ?? "";
  const guard = await loadGuard(db);
  const row = await ensureExecutor(db, now, guard, deployed);
  if (row?.error) return { ...summary, error: row.error };
  if (row?.revoked_at) return { ...summary, revoked: true };
  await stampContainerSeconds(db);
  await checkActive(env, db, now);
  const usage = () => containerUsage(db, now, guard);
  if (row?.drain === 1) {
    await touchExecutor(db, row, now, guard, await usage(), { deployed, image, source });
    return { ...summary, drained: true };
  }
  const [versionRow, secretsRow, pauseRow] = (await db.batch([
    db.prepare("SELECT value_json FROM settings WHERE key = 'jobs_version'"),
    db.prepare("SELECT value_json FROM settings WHERE key = 'secrets_version'"),
    db.prepare("SELECT value_json FROM settings WHERE key = 'global_pause'"),
  ])).map((result) => result.results[0] ?? null);
  const jobs = await jobsAt(db, String(parse(versionRow?.value_json, 0)));
  const secrets = await secretsAt(db, String(parse(secretsRow?.value_json, 0)));
  const globalPause = parse(pauseRow?.value_json) === true;
  const active = await db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE machine_id = ? AND state IN (${ACTIVE_SQL})`).bind(CLOUDFLARE_MACHINE_ID).first();
  let room = guard.maxConcurrent - Number(active?.n ?? 0);
  const due = (await db.prepare(`SELECT id, job_id, source, due_at, parameters_json FROM runs
    WHERE state = 'due' AND due_at <= ?1
      AND job_id IN (SELECT id FROM jobs WHERE json_extract(placement_json, '$.requireLabels.runtime') = ?2)
      AND NOT EXISTS (SELECT 1 FROM runs a WHERE a.job_id = runs.job_id AND a.state IN (${ACTIVE_SQL}))
    ORDER BY due_at LIMIT ${DUE_SCAN}`).bind(now, CLOUDFLARE_RUNTIME).all()).results;
  const candidates = due
    .map((run) => ({ run, job: jobs.get(run.job_id) }))
    .filter((entry) => entry.job && targetsCloudflare(entry.job))
    .sort((a, b) => (b.job.policy?.priority ?? 0) - (a.job.policy?.priority ?? 0) || a.run.due_at - b.run.due_at);
  const starter = options.starter ?? starterFromEnv(env);
  const labels = executorLabels(guard.labels);
  for (const { run, job } of candidates) {
    if (run.source !== "manual" && (!job.enabled || job.paused || globalPause)) continue;
    if (claimBlockers(job, secrets).length || secretsRefused(job, { labels }, secrets).length) {
      summary.leftDue += 1;
      continue;
    }
    if (room <= 0) {
      summary.leftDue += 1;
      continue;
    }
    const selected = selectInstanceType(job.resources, deployed);
    const problems = startProblems(job, selected, guard, image, source);
    const held = selected.ok ? selected : { name: job.resources.instanceType ?? "basic", vcpu: null, memoryMiB: job.resources.memoryMiB, diskMiB: job.resources.diskMiB };
    if (!await claimRun(db, run, job, held, image, now)) continue;
    if (problems.length) {
      await failRun(db, run.id, problems[0], now);
      summary.failed += 1;
      continue;
    }
    let values = {};
    if (vaultNames(job).length) {
      const opened = await openSecretsFor(db, env, vaultNames(job), labels);
      if (opened.refused.length) {
        await failRun(db, run.id, `vault: ${opened.refused.map((entry) => `${entry.name} ${entry.reason}`).join("; ")}`, now);
        summary.failed += 1;
        continue;
      }
      values = opened.values;
    }
    const extra = parse(run.parameters_json, []) ?? [];
    const command = containerCommand(job, Array.isArray(extra) ? extra.filter((item) => typeof item === "string") : []);
    const spec = {
      runId: run.id,
      jobId: job.id,
      binding: selected.binding,
      instanceType: selected.name,
      // The object settles a run at its own deadline; timeOutRuns' grace after it is the backstop when the object cannot.
      deadlineAt: now + job.timeouts.runSeconds * 1000,
      memoryLimitBytes: selected.memoryMiB * 1048576,
      env: { ...job.env, ...secretEnv(job, values) },
      secretValues: Object.values(values).filter((value) => typeof value === "string"),
      enableInternet: job.network !== "none",
      command,
    };
    try {
      await db.prepare("UPDATE runs SET started_at = ?1 WHERE id = ?2 AND started_at IS NULL AND machine_id = ?3").bind(now, run.id, CLOUDFLARE_MACHINE_ID).run();
      const started = await starter.start(spec);
      const digest = started?.digest ?? null;
      const running = await db.prepare(`UPDATE runs SET state = 'running', updated_at = ?1, image_digest = COALESCE(?4, image_digest)
        WHERE id = ?2 AND state = 'claimed' AND machine_id = ?3`).bind(now, run.id, CLOUDFLARE_MACHINE_ID, digest).run();
      if (running.meta.changes === 1) summary.started += 1;
      room -= 1;
    } catch (error) {
      if (startIsTransient(error)) {
        // No instance free yet (a container that was just cancelled or timed out may still be going): wait for a later minute.
        await unclaim(db, run.id, now);
        summary.leftDue += 1;
        room = 0;
        continue;
      }
      const exitCode = exitCodeFromError(error);
      if (exitCode !== null) await recordContainerStop(db, run.id, { exitCode }, now);
      else await failRun(db, run.id, safeError(error), now);
      summary.failed += 1;
    }
  }
  await touchExecutor(db, row, now, guard, await usage(), { deployed, image, source });
  return summary;
}

/** GET /v1/containers: container-seconds and the list-price upper bound. Viewer. */
export async function getContainers({ db, now }) {
  const guard = await loadGuard(db);
  return json(200, await containerUsage(db, now, guard));
}

// The Cloudflare Containers executor. The minute cron calls
// `dispatchCloudflare` and returns: it never waits out a run. Each run is a
// Durable Object (`HcContainerBasic`) whose alarm keeps the container alive
// for the run, then `recordContainerStop` writes the same `runs` row an
// agent's completion does. Secrets are handed to the container and are not
// written to D1.

import {
  CLOUDFLARE_LEASE_MS, CLOUDFLARE_MACHINE_ID, CLOUDFLARE_MACHINE_NAME, CLOUDFLARE_RUNTIME, CONTAINER_INCLUDED, CONTAINER_PRICES,
  DEFAULT_GUARD, EXECUTOR_LABELS, INSTANCE_BINDINGS, TIMEOUT_GRACE_MS, containerCommand, estimateContainerCost, exitCodeFromError,
  imageDigest, imagesMatch, interpretExit, localSecretNames, normaliseGuard, selectInstanceType, targetsCloudflare,
} from "../../src/core/cloudflare.mjs";
import { claimBlockers, secretsRefused } from "../../src/core/placement.mjs";
import { vaultNames } from "../../src/core/vault.mjs";
import { complete } from "./complete.mjs";
import { ACTIVE_SQL, bumpMachinesVersion, readSettings } from "./db.mjs";
import { iso, json } from "./http.mjs";
import { jobsAt } from "./jobcache.mjs";
import { openSecretsFor, secretsAt } from "./secrets.mjs";

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

/** The real starter: one Durable Object, named for the run, per start. */
export function starterFromEnv(env) {
  return {
    async start(spec) {
      const binding = env[spec.binding];
      if (!binding) throw new Error(`instance type ${spec.instanceType} is not deployed (binding ${spec.binding} is missing on hc-core)`);
      await stubFor(binding, spec.runId).startRun(spec);
    },
  };
}

/**
 * Settles a container run through the same completion as an agent. `lost`
 * does not settle: destroying a container the lease already gave up on must
 * not record a SIGKILL as the run's result. A later natural exit (no stop
 * reason) still completes and is recovered.
 */
export async function recordContainerStop(db, runId, details, now) {
  if (details.stopReason === "lost") return { ignored: true, reason: "lost" };
  const run = await db.prepare("SELECT * FROM runs WHERE id = ?").bind(runId).first();
  if (!run || run.machine_id !== CLOUDFLARE_MACHINE_ID) return { ignored: true, reason: "not-ours" };
  const prior = parse(run.metrics_json, {}) ?? {};
  const interpreted = details.failed
    ? { failed: true, timedOut: false, oomKilled: false, exitCode: null, cancelled: false }
    : interpretExit({
      exitCode: details.exitCode ?? null,
      peakMemoryBytes: details.peakMemoryBytes ?? run.peak_memory_bytes,
      memoryLimitBytes: run.memory_limit_bytes,
      stopReason: details.stopReason ?? null,
    });
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
    error: details.error ?? null,
    reports: [],
    stats: {
      peakMemoryBytes: details.peakMemoryBytes ?? null,
      memoryLimitBytes: run.memory_limit_bytes,
      avgCpuPct: null,
      peakCpuPct: null,
      cpuSeconds: details.cpuSeconds ?? null,
      samples: details.peakMemoryBytes || details.cpuSeconds ? 1 : 0,
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

/** Creates the virtual machine the first time a job targets it. A revoked row stays revoked. */
async function ensureExecutor(db, now, guard) {
  const existing = await db.prepare("SELECT id, revoked_at, drain, last_seen_at, facts_json, capacity_json FROM machines WHERE id = ?").bind(CLOUDFLARE_MACHINE_ID).first();
  if (existing) return existing;
  const named = await db.prepare("SELECT id FROM machines WHERE name = ?").bind(CLOUDFLARE_MACHINE_NAME).first();
  if (named) {
    console.error(JSON.stringify({ event: "cloudflare_executor_name_taken", machine: named.id }));
    return { error: `a machine is already named ${CLOUDFLARE_MACHINE_NAME}` };
  }
  const capacity = { cpus: 0.25, memoryMiB: 1024, diskMiB: 4096, maxRuns: guard.maxConcurrent };
  const inserted = await db.batch([
    db.prepare(`INSERT INTO machines (id, name, labels_json, capabilities, capacity_json, facts_json, health_json, agent_version,
        credential_hash, credential_issued_at, drain, enrolled_at)
      VALUES (?1, ?2, ?3, '', ?4, '{}', '{"docker":"ok"}', NULL, ?5, ?6, 0, ?6)`).bind(
      CLOUDFLARE_MACHINE_ID, CLOUDFLARE_MACHINE_NAME, JSON.stringify(EXECUTOR_LABELS), JSON.stringify(capacity), randomHex(32), now,
    ),
    bumpMachinesVersion(db),
  ]);
  if (inserted[0].meta.changes !== 1) return db.prepare("SELECT id, revoked_at, drain, last_seen_at, facts_json, capacity_json FROM machines WHERE id = ?").bind(CLOUDFLARE_MACHINE_ID).first();
  return { id: CLOUDFLARE_MACHINE_ID, revoked_at: null, drain: 0, last_seen_at: null, facts_json: "{}", capacity_json: JSON.stringify(capacity) };
}

async function touchExecutor(db, row, now, guard, usage) {
  const facts = {
    runtime: "cloudflare-containers", os: "linux", arch: "amd64",
    containerSeconds30d: usage.containerSeconds,
    estimatedUsd30d: Number(usage.estimatedUsd.toFixed(6)),
    maxConcurrent: guard.maxConcurrent,
    maxRunSeconds: guard.maxRunSeconds,
  };
  const capacity = { cpus: 0.25, memoryMiB: 1024, diskMiB: 4096, maxRuns: guard.maxConcurrent };
  const factsJson = JSON.stringify(facts);
  const capacityJson = JSON.stringify(capacity);
  const stale = row.last_seen_at === null || now - row.last_seen_at >= 60_000;
  if (!stale && factsJson === row.facts_json && capacityJson === (row.capacity_json ?? "")) return;
  await db.prepare(`UPDATE machines SET facts_json = ?1, capacity_json = ?2, health_json = '{"docker":"ok"}', last_seen_at = ?3
    WHERE id = ?4 AND revoked_at IS NULL`).bind(factsJson, capacityJson, now, CLOUDFLARE_MACHINE_ID).run();
}

async function stampContainerSeconds(db) {
  await db.prepare(`UPDATE runs SET metrics_json = json_set(metrics_json, '$.containerSeconds', MAX(0, (finished_at - started_at) / 1000))
    WHERE machine_id = ?1 AND finished_at IS NOT NULL AND started_at IS NOT NULL
      AND json_extract(metrics_json, '$.instanceType') IS NOT NULL
      AND json_extract(metrics_json, '$.containerSeconds') IS NULL`).bind(CLOUDFLARE_MACHINE_ID).run();
}

async function renewLeases(db, now) {
  await db.prepare(`UPDATE runs SET lease_expires_at = ?1
    WHERE machine_id = ?2 AND state IN (${ACTIVE_SQL})
      AND (started_at IS NULL OR started_at + COALESCE((SELECT json_extract(j.timeouts_json, '$.runSeconds') FROM jobs j WHERE j.id = runs.job_id), 0) * 1000 + ${TIMEOUT_GRACE_MS} >= ?3)`)
    .bind(now + CLOUDFLARE_LEASE_MS, CLOUDFLARE_MACHINE_ID, now).run();
}

async function tickActive(env, db) {
  const { results } = await db.prepare(`SELECT id, metrics_json FROM runs WHERE machine_id = ? AND state IN (${ACTIVE_SQL})`).bind(CLOUDFLARE_MACHINE_ID).all();
  for (const run of results) {
    const instanceType = parse(run.metrics_json, {})?.instanceType ?? "basic";
    const binding = env[INSTANCE_BINDINGS[instanceType] ?? ""];
    if (!binding) continue;
    try {
      await stubFor(binding, run.id).tick();
    } catch (error) {
      console.error(JSON.stringify({ event: "container_tick_error", run: run.id, error: safeError(error) }));
    }
  }
}

async function failRun(db, runId, error, now) {
  await recordContainerStop(db, runId, { failed: true, error }, now);
}

async function claimRun(db, run, job, selected, now) {
  const metrics = {
    instanceType: selected.name, memoryMiB: selected.memoryMiB, diskMiB: selected.diskMiB,
  };
  if (typeof selected.vcpu === "number") metrics.vcpu = selected.vcpu;
  const metricsJson = JSON.stringify(metrics);
  const result = await db.prepare(`UPDATE runs SET state = 'claimed', machine_id = ?1, lease_expires_at = ?2, claimed_at = ?3,
      job_revision = ?4, image_ref = ?5, image_digest = ?6, memory_limit_bytes = ?7, metrics_json = ?8, updated_at = ?3
    WHERE id = ?9 AND state = 'due'
      AND NOT EXISTS (SELECT 1 FROM runs a WHERE a.job_id = ?10 AND a.state IN (${ACTIVE_SQL}))`)
    .bind(
      CLOUDFLARE_MACHINE_ID, now + CLOUDFLARE_LEASE_MS, now, job.revision, job.image, imageDigest(job.image),
      selected.memoryMiB * 1048576, metricsJson, run.id, run.job_id,
    ).run();
  return result.meta.changes === 1;
}

function secretEnv(job, values) {
  return Object.fromEntries(Object.entries(job.secretEnv ?? {})
    .filter(([, reference]) => reference.startsWith("vault:") && typeof values[reference.slice(6)] === "string")
    .map(([name, reference]) => [name, values[reference.slice(6)]]));
}

/**
 * One cron pass. No-ops (one indexed read) when no job targets
 * `runtime=cloudflare-container`, so a deployment that never uses this
 * executor does not gain a machine row.
 */
export async function dispatchCloudflare(env, now, options = {}) {
  const db = env.DB;
  const labelled = await db.prepare("SELECT id FROM jobs WHERE json_extract(placement_json, '$.requireLabels.runtime') = ? LIMIT 1")
    .bind(CLOUDFLARE_RUNTIME).first();
  if (!labelled) return { jobs: 0 };
  const summary = { jobs: 1, started: 0, failed: 0, leftDue: 0 };
  const guard = await loadGuard(db);
  const row = await ensureExecutor(db, now, guard);
  if (row?.error) return { ...summary, error: row.error };
  if (row?.revoked_at) return { ...summary, revoked: true };
  await stampContainerSeconds(db);
  await renewLeases(db, now);
  if (!options.starter) await tickActive(env, db);
  const usage = () => containerUsage(db, now, guard);
  if (row?.drain === 1) {
    await touchExecutor(db, row, now, guard, await usage());
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
  const deployed = options.image ?? env.HC_CONTAINER_IMAGE ?? "";
  const starter = options.starter ?? starterFromEnv(env);
  const labels = EXECUTOR_LABELS;
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
    const selected = selectInstanceType(job.resources);
    const problems = [];
    if (!selected.ok) problems.push(selected.error);
    if (job.timeouts.runSeconds > guard.maxRunSeconds) {
      problems.push(`timeouts.runSeconds ${job.timeouts.runSeconds} exceeds the Cloudflare guard of ${guard.maxRunSeconds}s`);
    }
    const local = localSecretNames(job);
    if (local.length) problems.push(`local: secrets are not available on Cloudflare Containers (${local.join(", ")}); use vault: secrets`);
    if (!deployed) problems.push("Cloudflare container image is not configured: set the HC_CONTAINER_IMAGE secret to the registry.cloudflare.com digest deployed with hc-core");
    else if (!imagesMatch(job.image, deployed)) problems.push("job image does not match the deployed Cloudflare container image (push the digest, then set the job image and HC_CONTAINER_IMAGE to it)");
    if (!options.starter && selected.ok && !env[selected.binding]) {
      problems.push(`instance type ${selected.name} is not deployed (binding ${selected.binding} is missing on hc-core)`);
    }
    const held = selected.ok ? selected : {
      name: typeof job.resources.instanceType === "string" ? job.resources.instanceType : "basic",
      vcpu: null,
      memoryMiB: job.resources.memoryMiB,
      diskMiB: job.resources.diskMiB,
    };
    const claimed = await claimRun(db, run, job, held, now);
    if (!claimed) continue;
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
    const entrypoint = containerCommand(job, Array.isArray(extra) ? extra.filter((item) => typeof item === "string") : []);
    const spec = {
      runId: run.id,
      binding: selected.binding,
      instanceType: selected.name,
      deadlineAt: now + job.timeouts.runSeconds * 1000 + TIMEOUT_GRACE_MS,
      memoryLimitBytes: selected.memoryMiB * 1048576,
      env: { ...job.env, ...secretEnv(job, values) },
      enableInternet: job.network !== "none",
      ...(entrypoint ? { entrypoint } : {}),
    };
    try {
      await db.prepare("UPDATE runs SET started_at = ?1 WHERE id = ?2 AND started_at IS NULL AND machine_id = ?3").bind(now, run.id, CLOUDFLARE_MACHINE_ID).run();
      await starter.start(spec);
      const running = await db.prepare(`UPDATE runs SET state = 'running', updated_at = ?1 WHERE id = ?2 AND state = 'claimed' AND machine_id = ?3`)
        .bind(now, run.id, CLOUDFLARE_MACHINE_ID).run();
      if (running.meta.changes === 1) summary.started += 1;
      room -= 1;
    } catch (error) {
      const exitCode = exitCodeFromError(error);
      if (exitCode !== null) await recordContainerStop(db, run.id, { exitCode }, now);
      else await failRun(db, run.id, safeError(error), now);
      summary.failed += 1;
    }
  }
  await touchExecutor(db, row, now, guard, await usage());
  return summary;
}

/** GET /v1/containers: container-seconds and the list-price upper bound. Viewer. */
export async function getContainers({ db, now }) {
  const guard = await loadGuard(db);
  return json(200, await containerUsage(db, now, guard));
}

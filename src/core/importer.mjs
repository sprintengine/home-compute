// Importing a v1 `home-compute.json` job set into the hosted control plane
// (§8 of docs/hosted-control-plane.md): each v1 job becomes a hosted job
// definition, a preset adds what the v1 format cannot say (secret references,
// plain env values, placement, policy), and a plan says per job what an
// import would create or change. Imports are explicit and diffed; a field
// edited in the dashboard since the last import is kept unless forced.

import { ENV_NAME, JOB_ID, jobDifferences, jobEnvironmentNames, normaliseJob, validateReport, validateSchedule } from "./job.mjs";

const SECRET_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const TEMPLATE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
const DEFAULT_QUEUE_SECONDS = 3_600;
const DEFAULT_TOTAL_SECONDS = 7_200;

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * A preset, checked: `{id, secrets: {ENV: secret-name}, env: {ENV: value},
 * placement, policy, network, variables: {NAME: value}}`. `variables` fill
 * `${NAME}` in v1 images (Wingfoil's `${WINGFOIL_IMAGE}`); `--image` on the
 * command line overrides them.
 */
export function validatePreset(preset) {
  if (preset === undefined || preset === null) return null;
  if (!isObject(preset)) throw new Error("The preset must be an object");
  if (!JOB_ID.test(preset.id ?? "")) throw new Error(`Invalid preset id ${JSON.stringify(preset.id)}`);
  const known = new Set(["$comment", "id", "secrets", "env", "placement", "policy", "network", "variables"]);
  const unknown = Object.keys(preset).filter((key) => !known.has(key));
  if (unknown.length) throw new Error(`Unknown preset field ${unknown.join(", ")}`);
  const names = (value, description, check) => {
    if (value === undefined) return {};
    if (!isObject(value)) throw new Error(`preset.${description} must be an object`);
    for (const [name, item] of Object.entries(value)) {
      if (!ENV_NAME.test(name)) throw new Error(`preset.${description}: invalid name ${JSON.stringify(name)}`);
      check(name, item);
    }
    return { ...value };
  };
  const secrets = names(preset.secrets, "secrets", (name, secret) => {
    if (typeof secret !== "string" || !SECRET_NAME.test(secret)) throw new Error(`preset.secrets.${name} must be a secret name`);
  });
  const env = names(preset.env, "env", (name, value) => {
    if (typeof value !== "string") throw new Error(`preset.env.${name} must be a string`);
    if (name in secrets) throw new Error(`preset: ${name} cannot be both a secret and a plain value`);
  });
  const variables = names(preset.variables, "variables", (name, value) => {
    if (typeof value !== "string" || !value.trim()) throw new Error(`preset.variables.${name} must be a non-empty string`);
  });
  // Placement and policy are checked as part of each job they end up in.
  for (const key of ["placement", "policy"]) {
    if (preset[key] !== undefined && !isObject(preset[key])) throw new Error(`preset.${key} must be an object`);
  }
  return { id: preset.id, secrets, env, variables, placement: preset.placement ?? {}, policy: preset.policy ?? {}, network: preset.network };
}

/** Bacalhau's CPU string ("1", "0.5", "500m") as a number of CPUs. */
export function parseCpus(value) {
  const match = String(value ?? "1").trim().match(/^(\d+(?:\.\d+)?)(m?)$/);
  if (!match) throw new Error(`Invalid CPU amount ${JSON.stringify(value)}`);
  return Number(match[1]) / (match[2] ? 1000 : 1);
}

/** Bacalhau's size string ("512Mb", "1Gb", "2GiB") in MiB. */
export function parseMiB(value) {
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*([KMGT])i?b?$/i);
  if (!match) throw new Error(`Invalid size ${JSON.stringify(value)}`);
  const factor = { K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024 }[match[2].toUpperCase()];
  return Math.max(1, Math.round(Number(match[1]) * factor));
}

function resolveImage(image, variables, id) {
  return image.replace(TEMPLATE, (_, name) => {
    if (!variables[name]) throw new Error(`${id}.task.image needs ${name}: pass --image or set it in the preset's variables`);
    return variables[name];
  });
}

/**
 * The hosted definition of one v1 job, and warnings about what did not carry
 * over. Each environment name the job declares becomes, in order: a vault
 * reference when the preset maps it to a secret, a plain value when the
 * preset gives one, `local:<NAME>` (resolved from the agent's own env file)
 * when the job requires it, and is otherwise left out with a warning.
 * Bacalhau's queue/total timeouts become a run timeout of total − queue.
 */
export function jobFromV1(v1, { preset = null, variables = {} } = {}) {
  if (!isObject(v1) || !isObject(v1.task)) throw new Error("Each job must be an object with a task");
  const id = v1.id;
  if (!JOB_ID.test(id ?? "")) throw new Error(`Invalid job id ${JSON.stringify(id)}`);
  validateSchedule(v1.schedule, `${id}.schedule`);
  validateReport(v1.task.report, `${id}.task.report`);
  const warnings = [];
  const task = v1.task;
  const env = {};
  const secretEnv = {};
  const required = new Set(task.requiredEnv ?? []);
  const omitted = [];
  for (const name of jobEnvironmentNames(v1)) {
    if (preset?.secrets[name]) secretEnv[name] = `vault:${preset.secrets[name]}`;
    else if (preset?.env[name] !== undefined) env[name] = preset.env[name];
    else if (required.has(name)) {
      secretEnv[name] = `local:${name}`;
      warnings.push(`${name} is required but not in the preset: the agent must have it in its own env file`);
    } else omitted.push(name);
  }
  if (omitted.length) warnings.push(`optional ${omitted.join(", ")} not set by the preset, so not passed`);

  const timeouts = task.timeouts ?? {};
  const queueSeconds = timeouts.queueSeconds ?? DEFAULT_QUEUE_SECONDS;
  const totalSeconds = timeouts.totalSeconds ?? DEFAULT_TOTAL_SECONDS;
  const policy = { ...(preset?.policy ?? {}) };
  const networkType = String(task.network?.type ?? "Full").toLowerCase();
  if (task.network?.domains) warnings.push("network.domains is not supported; the job gets the bridge network");
  if (task.resources?.gpu && Number(task.resources.gpu) > 0) warnings.push("GPUs are not supported; resources.gpu was dropped");
  if (v1.constraints) warnings.push("Bacalhau constraints were dropped; use placement.requireLabels");
  if (v1.namespace) warnings.push("the Bacalhau namespace was dropped");

  const job = normaliseJob({
    id,
    description: v1.description,
    enabled: v1.enabled !== false,
    image: resolveImage(task.image, variables, id),
    entrypoint: task.entrypoint ?? null,
    args: (task.parameters ?? []).map(String),
    env,
    secretEnv,
    resources: {
      cpus: parseCpus(task.resources?.cpu ?? "1"),
      memoryMiB: parseMiB(task.resources?.memory ?? "2Gb"),
      diskMiB: parseMiB(task.resources?.disk ?? "2Gb"),
    },
    timeouts: {
      runSeconds: totalSeconds > queueSeconds ? totalSeconds - queueSeconds : totalSeconds,
      maxLatenessSeconds: policy.catchUp === "none" ? queueSeconds : null,
    },
    schedule: v1.schedule,
    placement: preset?.placement ?? {},
    policy,
    report: task.report ?? null,
    network: networkType === "none" ? "none" : (preset?.network ?? "bridge"),
    labels: v1.labels ?? {},
  });
  return { job, warnings };
}

/**
 * What importing `incoming` (normalised definitions) would do, job by job:
 *
 * - `create`: a job the control plane does not have.
 * - `update`: fields that differ and may be overwritten.
 * - `kept`: fields that differ but were edited since the last import (they
 *   differ from `baseline`, what that import wrote); kept unless `force`.
 * - `unchanged`: nothing differs.
 *
 * `next` is the definition to write. Jobs the control plane has but the file
 * does not are listed in `notInFile` and never deleted.
 */
export function planImport({ incoming, existing = {}, baseline = {}, force = false }) {
  const seen = new Set();
  const jobs = incoming.map((job) => {
    if (seen.has(job.id)) throw new Error(`Duplicate job id ${job.id}`);
    seen.add(job.id);
    const current = existing[job.id];
    if (!current) return { id: job.id, action: "create", changes: jobDifferences(null, job), kept: [], next: job };
    const before = baseline[job.id];
    const changes = [];
    const kept = [];
    const next = { ...current };
    for (const difference of jobDifferences(current, job)) {
      const edited = before && JSON.stringify(before[difference.field] ?? null) !== JSON.stringify(current[difference.field] ?? null);
      if (edited && !force) {
        kept.push({ ...difference, reason: "edited since the last import" });
      } else {
        changes.push(difference);
        next[difference.field] = job[difference.field];
      }
    }
    const action = changes.length ? "update" : kept.length ? "kept" : "unchanged";
    return { id: job.id, action, changes, kept, next };
  });
  return {
    jobs,
    notInFile: Object.keys(existing).filter((id) => !seen.has(id)).sort(),
    summary: Object.fromEntries(["create", "update", "kept", "unchanged"].map((action) => [action, jobs.filter((job) => job.action === action).length])),
  };
}

// Which machine may claim which run (§3.3 and §3.5 of
// docs/hosted-control-plane.md), and when an agent should next sync (§4.2).
// Pure, so hc-core decides and the snapshot explains with the same rules.

import {
  OFFLINE_MS, SYNC_BUSY_MS, SYNC_IDLE_MS, SYNC_MIN_MS, SYNC_SLOT_MARGIN_MS,
} from "./protocol.mjs";
import { vaultNames } from "./vault.mjs";

const DEFAULT_PREFER_WAIT_SECONDS = 300;

/** Whether `labels` has every required label with the same value. */
export function labelsMatch(required, labels) {
  return Object.entries(required ?? {}).every(([key, value]) => labels?.[key] === value);
}

/** Whether a run needing `resources` fits in `free` (`{cpus, memoryMiB, diskMiB, runs}`); absent figures do not limit. */
export function fits(resources, free) {
  if (!free) return false;
  if (free.runs !== undefined && free.runs !== null && free.runs < 1) return false;
  for (const key of ["cpus", "memoryMiB", "diskMiB"]) {
    const available = free[key];
    if (available !== undefined && available !== null && (resources?.[key] ?? 0) > available) return false;
  }
  return true;
}

/** `free` after a run needing `resources` starts. */
export function subtract(free, resources) {
  const next = { ...free };
  for (const key of ["cpus", "memoryMiB", "diskMiB"]) {
    if (typeof next[key] === "number") next[key] = Math.round((next[key] - (resources?.[key] ?? 0)) * 1000) / 1000;
  }
  if (typeof next.runs === "number") next.runs -= 1;
  return next;
}

/**
 * What a machine may take: what its agent says is free, capped by what the
 * dashboard allows it (`caps`, if any) less what its active runs hold.
 */
export function effectiveFree(reported, caps, holding = []) {
  const free = { ...(reported ?? {}) };
  if (!caps || !Object.keys(caps).length) return free;
  const used = { cpus: 0, memoryMiB: 0, diskMiB: 0, runs: holding.length };
  for (const resources of holding) for (const key of ["cpus", "memoryMiB", "diskMiB"]) used[key] += resources?.[key] ?? 0;
  for (const [key, capKey] of [["cpus", "cpus"], ["memoryMiB", "memoryMiB"], ["diskMiB", "diskMiB"], ["runs", "maxRuns"]]) {
    if (typeof caps[capKey] !== "number") continue;
    const allowed = caps[capKey] - used[key];
    free[key] = typeof free[key] === "number" ? Math.min(free[key], allowed) : allowed;
  }
  return free;
}

/** Why a machine is not healthy enough to be given work, or null. */
export function unhealthyReason(health) {
  if (!health) return null;
  if (health.vm === "failed") return "its VM failed to start";
  if (health.docker && health.docker !== "ok") return `docker is ${health.docker}`;
  return null;
}

/**
 * Whether a machine can take work now: enrolled and not revoked, synced
 * recently, not draining (from the dashboard or on the machine itself) and
 * healthy. `machine`: `{lastSeenAt, drain, health, revokedAt}`.
 */
export function machineAvailable(machine, now) {
  if (!machine || machine.revokedAt) return false;
  if (machine.lastSeenAt === null || machine.lastSeenAt === undefined || now - machine.lastSeenAt > OFFLINE_MS) return false;
  if (machine.drain || machine.health?.localDrain) return false;
  return unhealthyReason(machine.health) === null;
}

const vaultNamesOf = vaultNames;

/**
 * Why no machine may claim a job's runs at all, whatever its placement: a
 * `vault:` secret it names that the vault does not hold (§5). `secrets` maps
 * the vault's secret names to `{allowedLabels}` (the `secrets` table, without
 * values). A run is never started without a secret it names.
 */
export function claimBlockers(job, secrets = new Map()) {
  const missing = vaultNamesOf(job).filter((name) => !secrets.has(name));
  return missing.length ? [`needs vault secrets that are not set: ${missing.join(", ")}`] : [];
}

/**
 * The job's vault secrets this machine may not receive: a secret goes only to
 * machines whose labels match its `allowedLabels` (§5), so a job needing one
 * is not claimed by any other machine.
 */
export function secretsRefused(job, machine, secrets = new Map()) {
  return vaultNamesOf(job).filter((name) => secrets.has(name) && !labelsMatch(secrets.get(name).allowedLabels, machine?.labels));
}

/** When a due run's preferred machines stop having it to themselves (§3.5). */
export function preferredUntil(job, dueAt) {
  if (!job?.placement?.preferMachines?.length) return null;
  return dueAt + (job.placement.preferWaitSeconds ?? DEFAULT_PREFER_WAIT_SECONDS) * 1000;
}

/**
 * Why `machine` may not claim `run` of `job` now, or null when it may.
 * Placement only; capacity is `fits`. Until `run.preferredUntil` only a
 * preferred machine may claim, unless every preferred machine (in
 * `machines`) is offline, draining or unhealthy, or could never take the
 * job's labels.
 */
export function placementRefusal(job, run, machine, { machines = [], now }) {
  const required = job?.placement?.requireLabels;
  if (!labelsMatch(required, machine.labels)) return "labels";
  const preferred = job?.placement?.preferMachines ?? [];
  if (!preferred.length || preferred.includes(machine.name)) return null;
  if (run.preferredUntil === null || run.preferredUntil === undefined || now >= run.preferredUntil) return null;
  const waiting = machines.some((other) => preferred.includes(other.name) && other.id !== machine.id
    && labelsMatch(required, other.labels) && machineAvailable(other, now));
  return waiting ? "preferred" : null;
}

/**
 * The interval the server sets (§4.2): 10 s while the machine has work;
 * otherwise 30 s, or 2 s after the next moment it could be given something
 * (`events`, epoch ms: an upcoming slot, the end of another machine's
 * preference window), whichever is sooner. Events already past are left out:
 * a run this machine could not take then is not worth polling for faster.
 */
export function nextSyncDelay({ busy, events = [], now }) {
  if (busy) return SYNC_BUSY_MS;
  const next = events.filter((at) => typeof at === "number" && at > now).sort((a, b) => a - b)[0];
  if (next === undefined) return SYNC_IDLE_MS;
  return Math.max(SYNC_MIN_MS, Math.min(SYNC_IDLE_MS, next - now + SYNC_SLOT_MARGIN_MS));
}

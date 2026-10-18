// Cloudflare Containers as an executor. Pure: no `node:` imports, no I/O.
// hc-core claims runs whose placement requires `runtime=cloudflare-container`,
// starts one container per run, and writes the same `runs` rows a machine does.
//
// Instance sizes and prices are Cloudflare's published figures (Containers
// limits, updated 2026-10-12; pricing, 2026-10-05). `basic` is the cheap
// default. It is a default-scheduling-policy size: one image per container
// class, chosen at deploy, not per run.

export const CLOUDFLARE_RUNTIME = "cloudflare-container";
/** 26 alphanumeric characters after `m_`, so it matches the dashboard's machine route. */
export const CLOUDFLARE_MACHINE_ID = "m_cloudflarecontainer0000000";
export const CLOUDFLARE_MACHINE_NAME = "cloudflare";

/** The same grace `timeOutRuns` adds after `timeouts.runSeconds`. */
export const TIMEOUT_GRACE_MS = 300_000;
/** Two agent leases. One missed minute must not mark a live container `lost`. */
export const CLOUDFLARE_LEASE_MS = 180_000;
/** Product cap. A container class alarm keeps the Durable Object awake in short slices; this is the longest run we will start. */
export const ABSOLUTE_MAX_RUN_SECONDS = 1200;
export const DEFAULT_GUARD = { maxConcurrent: 1, maxRunSeconds: ABSOLUTE_MAX_RUN_SECONDS };

/**
 * Provisioned shape of each instance type. `diskMiB` treats Cloudflare's
 * "4 GB" as 4096 MiB. `vcpu` is what the run must fit inside, not a promise
 * of exclusive CPU (Cloudflare bills active CPU, and these sizes share a core).
 */
export const INSTANCE_TYPES = {
  lite: { vcpu: 1 / 16, memoryMiB: 256, diskMiB: 2048, diskGB: 2, memoryGiB: 0.25 },
  basic: { vcpu: 0.25, memoryMiB: 1024, diskMiB: 4096, diskGB: 4, memoryGiB: 1 },
  "standard-1": { vcpu: 0.5, memoryMiB: 4096, diskMiB: 8192, diskGB: 8, memoryGiB: 4 },
  "standard-2": { vcpu: 1, memoryMiB: 6144, diskMiB: 12288, diskGB: 12, memoryGiB: 6 },
  "standard-3": { vcpu: 2, memoryMiB: 8192, diskMiB: 16384, diskGB: 16, memoryGiB: 8 },
  "standard-4": { vcpu: 4, memoryMiB: 12288, diskMiB: 20480, diskGB: 20, memoryGiB: 12 },
};

/** Worker binding for each type. Only `HC_CONTAINER_BASIC` ships in wrangler until the owner adds another. */
export const INSTANCE_BINDINGS = {
  lite: "HC_CONTAINER_LITE",
  basic: "HC_CONTAINER_BASIC",
  "standard-1": "HC_CONTAINER_STANDARD_1",
  "standard-2": "HC_CONTAINER_STANDARD_2",
  "standard-3": "HC_CONTAINER_STANDARD_3",
  "standard-4": "HC_CONTAINER_STANDARD_4",
};

/** Workers Paid list prices, per second, after the included allotment. vCPU is active CPU; we price provisioned CPU as an upper bound. */
export const CONTAINER_PRICES = {
  memoryUsdPerGiBSecond: 0.0000025,
  vcpuUsdPerSecond: 0.00002,
  diskUsdPerGBSecond: 0.00000007,
};

/** Included each month on Workers Paid. Not subtracted: other Workers on the account share them. */
export const CONTAINER_INCLUDED = {
  memoryGiBHours: 25,
  vcpuMinutes: 375,
  diskGBHours: 200,
};

export const EXECUTOR_LABELS = { arch: "amd64", os: "linux", runtime: CLOUDFLARE_RUNTIME, site: "cloudflare" };

const TERMINAL_STATES = new Set(["succeeded", "failed", "timed-out", "cancelled", "skipped"]);

export function targetsCloudflare(job) {
  return job?.placement?.requireLabels?.runtime === CLOUDFLARE_RUNTIME;
}

/**
 * The instance type a job asked for (`resources.instanceType`, else `basic`).
 * Fails closed when the job's CPU, memory or disk do not fit that type: a
 * job left at the defaults (1 CPU, 2 GiB) must not be silently moved onto a
 * larger, more expensive size.
 */
export function selectInstanceType(resources) {
  const name = resources?.instanceType ?? "basic";
  const type = INSTANCE_TYPES[name];
  if (!type) {
    return { ok: false, error: `resources.instanceType ${JSON.stringify(name)} is unknown; use ${Object.keys(INSTANCE_TYPES).join(", ")}` };
  }
  const cpus = resources?.cpus ?? 1;
  const memoryMiB = resources?.memoryMiB ?? 2048;
  const diskMiB = resources?.diskMiB ?? 2048;
  if (cpus > type.vcpu + 1e-9) {
    return { ok: false, error: `resources.cpus ${cpus} exceeds the ${name} instance (${type.vcpu} vCPU). Set instanceType and resources that fit; the run is not moved to a larger size.` };
  }
  if (memoryMiB > type.memoryMiB) {
    return { ok: false, error: `resources.memoryMiB ${memoryMiB} exceeds the ${name} instance (${type.memoryMiB} MiB).` };
  }
  if (diskMiB > type.diskMiB) {
    return { ok: false, error: `resources.diskMiB ${diskMiB} exceeds the ${name} instance (${type.diskMiB} MiB).` };
  }
  return { ok: true, name, binding: INSTANCE_BINDINGS[name], ...type };
}

/** `sha256:<64 hex>` from an `image@sha256:…` reference, or null. */
export function imageDigest(ref) {
  const match = typeof ref === "string" && ref.match(/@sha256:([0-9a-f]{64})$/i);
  return match ? `sha256:${match[1].toLowerCase()}` : null;
}

/**
 * A job may name the deployed image exactly, or any reference with the same
 * digest (the ghcr name and the Cloudflare registry name of one push).
 */
export function imagesMatch(jobImage, deployed) {
  if (typeof jobImage !== "string" || typeof deployed !== "string" || !deployed) return false;
  if (jobImage === deployed) return true;
  const left = imageDigest(jobImage);
  const right = imageDigest(deployed);
  return Boolean(left && right && left === right);
}

/** What the container runs. Cloudflare has one `entrypoint` field and no separate command, so args replace the image entrypoint when set. Empty means the image default. */
export function containerCommand(job, extra = []) {
  const parts = [...(job?.entrypoint ?? []), ...(job?.args ?? []), ...extra];
  return parts.length ? parts : null;
}

export function localSecretNames(job) {
  return Object.entries(job?.secretEnv ?? {})
    .filter(([, reference]) => typeof reference === "string" && reference.startsWith("local:"))
    .map(([name]) => name);
}

/** `{maxConcurrent, maxRunSeconds}` with the defaults filled in. Throws on a value outside the guard. */
export function normaliseGuard(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const maxConcurrent = source.maxConcurrent ?? DEFAULT_GUARD.maxConcurrent;
  const maxRunSeconds = source.maxRunSeconds ?? DEFAULT_GUARD.maxRunSeconds;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 20) {
    throw new Error("cloudflare.maxConcurrent must be a whole number from 1 to 20");
  }
  if (!Number.isInteger(maxRunSeconds) || maxRunSeconds < 30 || maxRunSeconds > ABSOLUTE_MAX_RUN_SECONDS) {
    throw new Error(`cloudflare.maxRunSeconds must be a whole number from 30 to ${ABSOLUTE_MAX_RUN_SECONDS}`);
  }
  return { maxConcurrent, maxRunSeconds };
}

/**
 * What a container exit means for the run row. Timeout wins over exit 137:
 * we SIGKILL at the deadline, and that signal is not evidence of an OOM.
 * Otherwise exit 137, or a cgroup peak at the instance memory limit, is OOM.
 */
export function interpretExit({ exitCode = null, peakMemoryBytes = null, memoryLimitBytes = null, stopReason = null } = {}) {
  if (stopReason === "timeout") return { timedOut: true, oomKilled: false, exitCode, failed: false, cancelled: false };
  if (stopReason === "cancel") return { timedOut: false, oomKilled: false, exitCode, failed: false, cancelled: true };
  const numeric = typeof exitCode === "number";
  const oom = exitCode === 137 || (
    typeof peakMemoryBytes === "number" && typeof memoryLimitBytes === "number" && memoryLimitBytes > 0 && peakMemoryBytes >= memoryLimitBytes
  );
  return { timedOut: false, oomKilled: oom, exitCode: numeric ? exitCode : null, failed: !numeric, cancelled: false };
}

/** An exit code mentioned by the Containers SDK when the process ended during start, or null. */
export function exitCodeFromError(error) {
  const match = String(error?.message ?? error).match(/exit code:?\s*(-?\d+)/i);
  return match ? Number(match[1]) : null;
}

/** `memory.peak` and `cpu.stat` text from a best-effort cgroup read. Missing fields are omitted. */
export function parseCgroup(text) {
  const result = {};
  if (typeof text !== "string" || !text) return result;
  const memory = text.match(/memory\.peak\s+(\d+)/);
  if (memory) result.peakMemoryBytes = Number(memory[1]);
  const usage = text.match(/usage_usec\s+(\d+)/);
  if (usage) result.cpuMicroseconds = Number(usage[1]);
  return result;
}

/**
 * What the Durable Object should do on a tick. `lost` destroys the container
 * and does not complete the run (a SIGKILL must not become a fake OOM that
 * races the retry). A natural exit while `lost` is not this case: that path
 * has no stop reason and still completes, recovered.
 */
export function containerWatch({ state, deadlineAt }, now) {
  if (state === "lost") return { action: "destroy", stopReason: "lost", complete: false };
  if (state === "cancelled") return { action: "destroy", stopReason: "cancel", complete: false };
  if (TERMINAL_STATES.has(state)) return { action: "destroy", complete: false };
  if (typeof deadlineAt === "number" && now >= deadlineAt) return { action: "timeout", stopReason: "timeout", complete: true };
  return { action: "renew", leaseExpiresAt: now + CLOUDFLARE_LEASE_MS };
}

/**
 * List-price upper bound for provisioned memory, provisioned vCPU and disk.
 * `secondsByType` is `{basic: seconds}` or `[{instanceType, seconds}]`.
 * Included allotments are not subtracted. vCPU is priced as if the whole
 * provisioned vCPU were active; Cloudflare bills active CPU only.
 */
export function estimateContainerCost(secondsByType) {
  const entries = Array.isArray(secondsByType)
    ? secondsByType
    : Object.entries(secondsByType ?? {}).map(([instanceType, seconds]) => ({ instanceType, seconds }));
  let containerSeconds = 0;
  let memoryGiBSeconds = 0;
  let vcpuSeconds = 0;
  let diskGBSeconds = 0;
  for (const entry of entries) {
    const type = INSTANCE_TYPES[entry.instanceType];
    const seconds = Number(entry.seconds) || 0;
    if (!type || seconds <= 0) continue;
    containerSeconds += seconds;
    memoryGiBSeconds += type.memoryGiB * seconds;
    vcpuSeconds += type.vcpu * seconds;
    diskGBSeconds += type.diskGB * seconds;
  }
  const estimatedUsd = memoryGiBSeconds * CONTAINER_PRICES.memoryUsdPerGiBSecond
    + vcpuSeconds * CONTAINER_PRICES.vcpuUsdPerSecond
    + diskGBSeconds * CONTAINER_PRICES.diskUsdPerGBSecond;
  return {
    containerSeconds,
    memoryGiBSeconds,
    vcpuSeconds,
    diskGBSeconds,
    estimatedUsd,
    beforeIncludedAllotment: true,
    note: "Upper bound before the Workers Paid allotment. vCPU is priced as provisioned; Cloudflare bills active CPU only. Memory and disk are provisioned for the whole run.",
  };
}

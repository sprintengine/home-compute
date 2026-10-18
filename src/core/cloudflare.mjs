// Cloudflare Containers as an executor. Pure: no `node:` imports, no I/O.
// hc-core claims runs whose placement requires `runtime=cloudflare-container`,
// starts one container per run, and writes the same `runs` rows a machine does.
//
// Instance sizes and prices are Cloudflare's published figures (Containers
// limits and pricing, October 2026). Below one vCPU there are only the named
// sizes `lite` and `basic`; a custom size starts at 1 vCPU and 3 GiB. Each
// size is a container class of its own (one image, one instance type), and a
// run goes to the smallest deployed class its memory and disk fit.

export const CLOUDFLARE_RUNTIME = "cloudflare-container";
/** 26 alphanumeric characters after `m_`, so it matches the dashboard's machine route. */
export const CLOUDFLARE_MACHINE_ID = "m_cloudflarecontainer0000000";
export const CLOUDFLARE_MACHINE_NAME = "cloudflare";

/** The same grace `timeOutRuns` adds after `timeouts.runSeconds`. */
export const TIMEOUT_GRACE_MS = 300_000;
/** Renewed by the run's Durable Object on every check (each cron minute and each alarm), and only while the container answers. */
export const CLOUDFLARE_LEASE_MS = 180_000;
/** Product cap. A container class alarm keeps the Durable Object awake in short slices; this is the longest run we will start. */
export const ABSOLUTE_MAX_RUN_SECONDS = 1200;
export const DEFAULT_GUARD = { maxConcurrent: 1, maxRunSeconds: ABSOLUTE_MAX_RUN_SECONDS };
/** How long a finished container waits for hc-core to read its result before it exits on its own. */
export const RESULT_HOLD_SECONDS = 300;

/**
 * Provisioned shape of each instance type, smallest first. `diskMiB` treats
 * Cloudflare's "4 GB" as 4096 MiB. `vcpu` is shared below one: Cloudflare
 * bills active CPU, so it is not used to choose a size.
 */
export const INSTANCE_TYPES = {
  lite: { vcpu: 1 / 16, memoryMiB: 256, diskMiB: 2048, diskGB: 2, memoryGiB: 0.25 },
  basic: { vcpu: 0.25, memoryMiB: 1024, diskMiB: 4096, diskGB: 4, memoryGiB: 1 },
  "standard-1": { vcpu: 0.5, memoryMiB: 4096, diskMiB: 8192, diskGB: 8, memoryGiB: 4 },
  "standard-2": { vcpu: 1, memoryMiB: 6144, diskMiB: 12288, diskGB: 12, memoryGiB: 6 },
  "standard-3": { vcpu: 2, memoryMiB: 8192, diskMiB: 16384, diskGB: 16, memoryGiB: 8 },
  "standard-4": { vcpu: 4, memoryMiB: 12288, diskMiB: 20480, diskGB: 20, memoryGiB: 12 },
};

/** Worker binding for each type. A type is deployed when hc-core has its binding (wrangler.core.jsonc). */
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

/** The instance types hc-core can start: those whose binding `env` has. */
export function deployedInstanceTypes(env) {
  return Object.keys(INSTANCE_TYPES).filter((name) => Boolean(env?.[INSTANCE_BINDINGS[name]]));
}

/**
 * The instance type for a job: `resources.instanceType` when it names one,
 * else the smallest deployed type that holds the job's memory and disk. CPU
 * does not choose: the sizes below one vCPU share a core and only active CPU
 * is billed, so a CPU-light job asking for "1" still runs on `basic`. Fails
 * closed when nothing deployed fits, rather than reaching for a bigger size.
 */
export function selectInstanceType(resources, deployed = ["basic"]) {
  const memoryMiB = resources?.memoryMiB ?? 2048;
  const diskMiB = resources?.diskMiB ?? 2048;
  const fits = (name) => memoryMiB <= INSTANCE_TYPES[name].memoryMiB && diskMiB <= INSTANCE_TYPES[name].diskMiB;
  const chosen = (name) => ({ ok: true, name, binding: INSTANCE_BINDINGS[name], ...INSTANCE_TYPES[name] });
  const named = resources?.instanceType;
  if (named !== undefined && named !== null) {
    if (!INSTANCE_TYPES[named]) {
      return { ok: false, error: `resources.instanceType ${JSON.stringify(named)} is unknown; use ${Object.keys(INSTANCE_TYPES).join(", ")}` };
    }
    if (!deployed.includes(named)) return { ok: false, error: `instance type ${named} is not deployed on hc-core (deployed: ${deployed.join(", ") || "none"})` };
    if (!fits(named)) {
      const type = INSTANCE_TYPES[named];
      return { ok: false, error: `the job's ${memoryMiB} MiB memory and ${diskMiB} MiB disk do not fit ${named} (${type.memoryMiB} MiB, ${type.diskMiB} MiB)` };
    }
    return chosen(named);
  }
  const name = Object.keys(INSTANCE_TYPES).find((candidate) => deployed.includes(candidate) && fits(candidate));
  if (!name) {
    return { ok: false, error: `no deployed instance type holds ${memoryMiB} MiB memory and ${diskMiB} MiB disk (deployed: ${deployed.join(", ") || "none"}); lower the job's resources or deploy a larger class` };
  }
  return chosen(name);
}

/** `sha256:<64 hex>` from an `image@sha256:…` reference, or null. */
export function imageDigest(ref) {
  const match = typeof ref === "string" && ref.match(/@sha256:([0-9a-f]{64})$/i);
  return match ? `sha256:${match[1].toLowerCase()}` : null;
}

/** An image reference's last path segment, without registry, tag or digest: `wingfoil-forecast`. */
export function imageRepository(ref) {
  if (typeof ref !== "string" || !ref) return null;
  const path = ref.replace(/@sha256:[0-9a-f]+$/i, "");
  const last = path.slice(path.lastIndexOf("/") + 1);
  return last.replace(/:[^:]*$/, "").toLowerCase() || null;
}

/**
 * Whether a job may run on the deployed image. A job that pins a digest must
 * name the deployed one. A job that names a tag (`…/wingfoil-forecast:production`)
 * runs whatever version of that repository is deployed: Cloudflare cannot
 * pull the tag itself, so the deploy is what moves it.
 */
export function imagesMatch(jobImage, deployed) {
  if (typeof jobImage !== "string" || typeof deployed !== "string" || !deployed) return false;
  if (jobImage === deployed) return true;
  const wanted = imageDigest(jobImage);
  if (wanted) return wanted === imageDigest(deployed);
  const repository = imageRepository(jobImage);
  return Boolean(repository && repository === imageRepository(deployed));
}

/** What the job runs: its entrypoint, args and the run's extra parameters. Empty means the image default, which the log wrapper cannot run. */
export function containerCommand(job, extra = []) {
  const parts = [...(job?.entrypoint ?? []), ...(job?.args ?? []), ...extra];
  return parts.length ? parts : null;
}

/** Where the wrapper keeps a run's output and exit code inside the container. */
export const RESULT_DIR = "/tmp/hc";

/**
 * The container's entrypoint: the job under `sh`, its output copied to
 * <dir>/log (and on to Workers Logs), its exit code written to <dir>/exit,
 * then a short hold so hc-core can read both before the container goes.
 * Needs `sh`, `tee`, `mkdir`, `mv` and `sleep` in the image.
 */
export function wrappedEntrypoint(command, holdSeconds = RESULT_HOLD_SECONDS, dir = RESULT_DIR) {
  const script = [
    "d=\"$1\"; shift",
    "mkdir -p \"$d\"",
    "{ \"$@\"; echo $? > \"$d/exit.part\"; mv \"$d/exit.part\" \"$d/exit\"; } 2>&1 | tee \"$d/log\"",
    `exec sleep ${Math.max(1, Math.round(holdSeconds))}`,
  ].join("; ");
  return ["sh", "-c", script, "hc-run", dir, ...command];
}

/** An exec that returns once the job has written its exit code. */
export function waitCommand(dir = RESULT_DIR) {
  return ["sh", "-c", "while [ ! -f \"$1/exit\" ]; do sleep 1; done", "hc-wait", dir];
}

/**
 * An exec that prints what hc-core reads about a run, in sections headed
 * `@@<nonce> <name>` so the job's own output cannot be mistaken for one.
 */
export function probeCommand(nonce, dir = RESULT_DIR) {
  const script = [
    "n=\"$1\"; d=\"$2\"",
    "echo \"@@$n exit\"; cat \"$d/exit\" 2>/dev/null",
    "echo \"@@$n memory\"; cat /sys/fs/cgroup/memory.peak 2>/dev/null",
    "echo \"@@$n cpu\"; grep usage_usec /sys/fs/cgroup/cpu.stat 2>/dev/null",
    "echo \"@@$n size\"; wc -c < \"$d/log\" 2>/dev/null; wc -l < \"$d/log\" 2>/dev/null",
    "echo \"@@$n reports\"; grep -E '^[[:space:]]*[{].*\"event\"[[:space:]]*:' \"$d/log\" 2>/dev/null | tail -n 50",
    "echo \"@@$n tail\"; tail -n 500 \"$d/log\" 2>/dev/null",
    "true",
  ].join("; ");
  return ["sh", "-c", script, "hc-probe", nonce, dir];
}

/** The probe's output as numbers and lines. A field the probe could not read is null. */
export function parseProbe(text, nonce) {
  const sections = {};
  let current = null;
  const marker = `@@${nonce} `;
  for (const line of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    if (line.startsWith(marker)) {
      current = line.slice(marker.length).trim();
      sections[current] = [];
    } else if (current) {
      sections[current].push(line);
    }
  }
  const number = (name, index = 0) => {
    const value = (sections[name] ?? []).map((line) => line.trim()).filter(Boolean)[index];
    return value !== undefined && /^-?\d+$/.test(value) ? Number(value) : null;
  };
  const cpu = (sections.cpu ?? []).join("\n").match(/usage_usec\s+(\d+)/);
  const lines = (name) => {
    const kept = [...(sections[name] ?? [])];
    while (kept.length && kept.at(-1) === "") kept.pop();
    return kept;
  };
  return {
    exitCode: number("exit"),
    peakMemoryBytes: number("memory"),
    cpuMicroseconds: cpu ? Number(cpu[1]) : null,
    bytesTotal: number("size", 0),
    linesTotal: number("size", 1),
    reportLines: lines("reports"),
    tailLines: lines("tail"),
  };
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
 * What a container exit means for the run row. Timeout and cancel win: we
 * kill at the deadline, and that signal is not evidence of an OOM. Otherwise
 * exit 137 is OOM, and so is a failing exit with the cgroup peak at the
 * limit. A clean exit is never OOM: page cache counts towards the peak.
 */
export function interpretExit({ exitCode = null, peakMemoryBytes = null, memoryLimitBytes = null, stopReason = null } = {}) {
  if (stopReason === "timeout") return { timedOut: true, oomKilled: false, exitCode, failed: false, cancelled: false };
  if (stopReason === "cancel") return { timedOut: false, oomKilled: false, exitCode, failed: false, cancelled: true };
  const numeric = typeof exitCode === "number";
  const atLimit = typeof peakMemoryBytes === "number" && typeof memoryLimitBytes === "number" && memoryLimitBytes > 0
    && peakMemoryBytes >= memoryLimitBytes;
  const oom = exitCode === 137 || (numeric && exitCode !== 0 && atLimit);
  return { timedOut: false, oomKilled: oom, exitCode: numeric ? exitCode : null, failed: !numeric, cancelled: false };
}

/** An exit code mentioned by the Containers SDK when the process ended during start, or null. */
export function exitCodeFromError(error) {
  const match = String(error?.message ?? error).match(/exit code:?\s*(-?\d+)/i);
  return match ? Number(match[1]) : null;
}

/** A start that failed for want of capacity, which a later minute may have: the run goes back to `due`. */
export function startIsTransient(error) {
  return /no container instance that can be provided|too many containers per second|max(imum)?[ _]instances|capacity/i
    .test(String(error?.message ?? error));
}

/**
 * What the run's Durable Object does on a check, from the run row's state,
 * the deadline and whether the job has written its exit code:
 * - `stop` without `settle`: the row already ended (lost, cancelled,
 *   finished elsewhere); kill the container. A lost run is not completed
 *   here: its retry decides, and a SIGKILL must not become a fake OOM.
 * - `settle`: complete the row from the container (exit or timeout), then kill it.
 * - `renew`: still running; renew the lease and refresh the log tail.
 */
export function watchDecision({ state, deadlineAt, exitCode = null }, now) {
  if (state === "lost") return { action: "stop", stopReason: "lost", settle: false };
  if (state === "cancelled") return { action: "stop", stopReason: "cancel", settle: false, keepLog: true };
  if (TERMINAL_STATES.has(state)) return { action: "stop", settle: false, keepLog: true };
  if (typeof exitCode === "number") return { action: "settle", settle: true, stopReason: null };
  if (typeof deadlineAt === "number" && now >= deadlineAt) return { action: "settle", settle: true, stopReason: "timeout" };
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

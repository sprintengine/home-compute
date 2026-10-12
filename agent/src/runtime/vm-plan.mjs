// The VM's lifecycle on demand (§4.4), as pure decisions so every rule can
// be tested without a VM:
//
//  stopped ──(claim, or upcoming run within the pre-warm lead)──► starting ──► ready ──(no runs)──► idle
//     ▲                                                                                              │
//     └── stop ◄── idle ≥ idleStopSeconds AND nothing upcoming within keepWarmSeconds ◄──────────────┘
//
// Pre-warm starts the VM `bootSeconds + 10 s` before the first upcoming slot
// this machine would take. Size: memory = clamp(ceil(Σ GiB of the runs
// expected at once in the next 15 min, at most maxRuns of them) + 0.75 GiB,
// min, cap); CPUs = clamp(max of their CPUs, min, cap). A different size is
// applied only while the VM holds no containers (stop, then start).

export const SIZE_WINDOW_MS = 15 * 60_000;
export const PREWARM_MARGIN_MS = 10_000;
export const VM_OVERHEAD_MIB = 768;
/** Before a boot has been measured. */
export const DEFAULT_BOOT_SECONDS = 30;
/** A smaller VM is worth a restart only if it frees at least this much memory. */
export const SHRINK_MIN_MIB = 1024;
export const DEFAULT_VM_CONFIG = { idleStopSeconds: 300, keepWarmSeconds: 600 };

const GIB = 1024;

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

/** Upcoming slots this machine would take: not those another machine is preferred for. */
export function ownUpcoming(upcoming = [], now = Date.now()) {
  return (upcoming ?? []).filter((entry) => entry && typeof entry.dueAt === "number" && entry.dueAt > now - 60_000 && !entry.preferredElsewhere);
}

/**
 * The VM size for what is running and what is expected in the next 15
 * minutes. `runs`: active runs' resources; `upcoming`: the sync's list;
 * `caps`: the largest VM (`{cpus, memoryMiB}`); `min`: the smallest.
 */
export function planVmSize({ runs = [], upcoming = [], now = Date.now(), caps, min = { cpus: 2, memoryMiB: 2048 }, maxRuns = 2, windowMs = SIZE_WINDOW_MS }) {
  const plain = (entry) => ({ cpus: Number(entry?.cpus) || 0, memoryMiB: Number(entry?.memoryMiB) || 0 });
  // What runs now always counts; the largest expected runs fill the remaining run slots.
  const active = runs.map(plain);
  const ahead = ownUpcoming(upcoming, now).filter((entry) => entry.dueAt - now <= windowMs).map(plain)
    .sort((a, b) => b.memoryMiB - a.memoryMiB);
  const concurrent = [...active, ...ahead.slice(0, Math.max(0, maxRuns - active.length))];
  const sumMiB = concurrent.reduce((total, entry) => total + entry.memoryMiB, 0);
  const memoryMiB = sumMiB > 0 ? Math.ceil(sumMiB / GIB) * GIB + VM_OVERHEAD_MIB : 0;
  const cpus = Math.ceil(Math.max(0, ...concurrent.map((entry) => entry.cpus)));
  return {
    cpus: clamp(cpus, min.cpus, caps?.cpus ?? min.cpus),
    memoryMiB: clamp(memoryMiB, min.memoryMiB, caps?.memoryMiB ?? min.memoryMiB),
  };
}

/** Whether a VM of `size` can take a run needing `required` beside runs holding `held` memory. */
export function vmFits(size, required = {}, held = 0) {
  if (!size?.cpus || !size?.memoryMiB) return false;
  return (required.cpus ?? 0) <= size.cpus && (required.memoryMiB ?? 0) + held <= size.memoryMiB - VM_OVERHEAD_MIB;
}

/** The size to start (or resize) for a run: the plan, grown to fit the run and what else runs. */
export function sizeFor(plan, required = {}, held = 0, caps = null) {
  const needMiB = Math.ceil(((required.memoryMiB ?? 0) + held) / GIB) * GIB + VM_OVERHEAD_MIB;
  return {
    cpus: Math.min(Math.max(plan.cpus, Math.ceil(required.cpus ?? 0)), caps?.cpus ?? Infinity),
    memoryMiB: Math.min(Math.max(plan.memoryMiB, needMiB), caps?.memoryMiB ?? Infinity),
  };
}

/**
 * What to do with the VM now: `{action: "start" | "resize" | "stop" | "none",
 * size?, reason, wakeAt}`. `wakeAt` is when the decision may change without
 * anything else happening (null: only an event changes it).
 *
 * - `vm`: `{state: running|stopped|absent|starting|stopping|broken, cpus, memoryMiB}`;
 * - `busy`: a container runs or a claimed run is being started;
 * - `lastBusyAt`: when the VM last had work (or started);
 * - `config`: `{idleStopSeconds, keepWarmSeconds}` (0 idleStopSeconds: never stop);
 * - `desired`: planVmSize()'s answer; `mayStart`: false while start failures gate the machine.
 */
export function vmDecision({ now, vm, busy, lastBusyAt, upcoming = [], config = DEFAULT_VM_CONFIG, bootSeconds = DEFAULT_BOOT_SECONDS, desired, mayStart = true }) {
  const idleStopMs = (config?.idleStopSeconds ?? DEFAULT_VM_CONFIG.idleStopSeconds) * 1000;
  const keepWarmMs = (config?.keepWarmSeconds ?? DEFAULT_VM_CONFIG.keepWarmSeconds) * 1000;
  const leadMs = (bootSeconds ?? DEFAULT_BOOT_SECONDS) * 1000 + PREWARM_MARGIN_MS;
  const next = ownUpcoming(upcoming, now).filter((entry) => entry.dueAt > now).sort((a, b) => a.dueAt - b.dueAt)[0] ?? null;
  const state = vm?.state ?? "absent";

  if (state === "stopped" || state === "absent") {
    if (!next) return { action: "none", reason: "stopped, nothing upcoming", wakeAt: null };
    const startAt = next.dueAt - leadMs;
    if (now >= startAt) {
      if (!mayStart) return { action: "none", reason: "pre-warm held back: the VM failed to start", wakeAt: null };
      return { action: "start", size: desired, reason: `pre-warm for ${next.jobId} at ${new Date(next.dueAt).toISOString()}`, wakeAt: null };
    }
    return { action: "none", reason: `pre-warm for ${next.jobId} at ${new Date(startAt).toISOString()}`, wakeAt: startAt };
  }
  if (state !== "running") return { action: "none", reason: `the VM is ${state}`, wakeAt: now + 5_000 };
  if (busy) return { action: "none", reason: "busy", wakeAt: null };

  const current = { cpus: vm.cpus ?? 0, memoryMiB: vm.memoryMiB ?? 0 };
  const soon = next && next.dueAt - now <= keepWarmMs;
  if (desired && soon) {
    const grow = desired.memoryMiB > current.memoryMiB || desired.cpus > current.cpus;
    const shrink = current.memoryMiB - desired.memoryMiB >= SHRINK_MIN_MIB && desired.cpus <= current.cpus;
    // Shrinking costs a boot: only when that boot ends before the next slot.
    if (grow || (shrink && next.dueAt - now > leadMs + 5_000)) {
      if (!mayStart) return { action: "none", reason: "resize held back: the VM failed to start", wakeAt: null };
      return { action: "resize", size: desired, reason: `${grow ? "grow" : "shrink"} to ${desired.cpus} CPU / ${desired.memoryMiB} MiB for ${next.jobId}`, wakeAt: null };
    }
  }
  if (idleStopMs <= 0) return { action: "none", reason: "always on (idleStopSeconds 0)", wakeAt: null };
  if (soon) return { action: "none", reason: `kept warm for ${next.jobId}`, wakeAt: next.dueAt + 1_000 };
  const stopAt = (lastBusyAt ?? now) + idleStopMs;
  if (now >= stopAt) return { action: "stop", reason: `idle for ${Math.round((now - (lastBusyAt ?? now)) / 1000)} s`, wakeAt: null };
  const keepWarmEnds = next ? next.dueAt - keepWarmMs : Infinity;
  return { action: "none", reason: "idle", wakeAt: Math.min(stopAt, keepWarmEnds) };
}

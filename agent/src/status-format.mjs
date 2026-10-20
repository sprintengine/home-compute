// How `home-compute-agent status`, `history` and `watch` print the local
// status API's answers in a terminal: plain text, one fact per line, ✓ and ✗
// for passed and failed runs. Pure functions of the answers and the time.

const REASONS = {
  paused: "paused on this machine",
  draining: "draining before a restart",
  "drained-on-dashboard": "drained from the dashboard",
  revoked: "its credential was revoked",
  "upgrade-required": "the control plane needs a newer agent",
  "runtime-unreachable": "the container runtime does not answer",
  "runtime-failed": "the container runtime failed to start three times",
  full: "every run slot is in use",
};

export function reasonText(reason) {
  return REASONS[reason] ?? reason;
}

/** "42s", "4m 05s", "1h 03m". */
export function duration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "?";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
}

/** "812 MiB", "1.8 GiB". */
export function mebibytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return null;
  const mib = bytes / 1048576;
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GiB` : `${Math.round(mib)} MiB`;
}

/** "3 s ago", "in 12 s", "never". */
export function ago(isoTime, now = Date.now()) {
  if (!isoTime) return "never";
  const seconds = Math.round((now - Date.parse(isoTime)) / 1000);
  return seconds >= 0 ? `${seconds} s ago` : `in ${-seconds} s`;
}

/** "14:02" today, else "Oct 17 14:02", in local time. */
export function clockTime(isoTime, now = Date.now()) {
  if (!isoTime) return "--:--";
  const date = new Date(isoTime);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (new Date(now).toDateString() === date.toDateString()) return time;
  return `${date.toLocaleString("en", { month: "short" })} ${date.getDate()} ${time}`;
}

export function mark(entry) {
  return entry.passed === true ? "✓" : entry.passed === false ? "✗" : "–";
}

/** The run's outcome in a few words: "published harmonie 2026101806", "exit 1: HTTP 503", "cancelled". */
export function outcomeText(entry) {
  if (entry.outcome === "failed") {
    const why = entry.error ?? (entry.oomKilled ? "out of memory" : entry.timedOut ? "timed out" : null);
    const code = entry.exitCode !== null && entry.exitCode !== undefined ? `exit ${entry.exitCode}` : null;
    return [code, why].filter(Boolean).join(": ") || "failed";
  }
  if (entry.outcome === "published" && entry.published?.length) {
    return `published ${entry.published.map((item) => [item.key, item.run].filter(Boolean).join(" ")).join(", ")}`;
  }
  return entry.outcome ?? "unknown";
}

/** One history line: `✗ harmonie      13:00   12s  exit 1: HTTP 503`. */
export function historyLine(entry, { now = Date.now(), width = 100 } = {}) {
  const line = `${mark(entry)} ${String(entry.job ?? "?").padEnd(14)} ${clockTime(entry.finishedAt, now).padStart(12)} ${duration(entry.durationMs).padStart(7)}  ${outcomeText(entry).replace(/\s+/g, " ")}`;
  return line.length > width ? `${line.slice(0, width - 1)}…` : line;
}

/** A run in hand: `gfs (r_…) running 4m 05s · CPU 52% · 812 MiB of 3 GiB`. */
export function currentLine(run) {
  const parts = [`${run.job} (${run.id}) ${run.phase} ${duration(run.runningMs ?? run.elapsedMs)}`];
  if (typeof run.cpuPct === "number") parts.push(`CPU ${Math.round(run.cpuPct)}%`);
  const memory = mebibytes(run.memoryBytes ?? run.peakMemoryBytes);
  if (memory) parts.push(`${memory}${run.memoryLimitBytes ? ` of ${mebibytes(run.memoryLimitBytes)}` : ""}`);
  return parts.join(" · ");
}

/** What `status` prints for a running agent, and `watch` redraws. */
export function formatStatus(live, history = [], { now = Date.now(), recent = 5 } = {}) {
  const lines = [`${live.name} (${live.machineId}) → ${live.server}`];
  lines.push(`connection: ${live.connection}; last sync ${ago(live.lastSyncAt, now)}; next ${ago(live.nextSyncAt, now)}; clock skew ${live.clockSkewMs ?? "?"} ms`);
  const reasons = (live.notClaimingBecause ?? []).filter((reason) => reason !== "full");
  if (reasons.length) {
    const since = live.paused && live.pausedAt ? ` since ${clockTime(live.pausedAt, now)}` : "";
    lines.push(`taking jobs: no (${reasons.map(reasonText).join("; ")}${since})`);
  } else {
    lines.push(`taking jobs: yes${(live.notClaimingBecause ?? []).includes("full") ? " (every run slot is in use)" : ""}`);
  }
  const runtime = live.runtime ?? {};
  lines.push(`runtime ${runtime.kind}: ${runtime.ok ? "ok" : `not ok (${runtime.lastError})`}`);
  const vm = runtime.vm;
  if (vm) {
    const size = vm.state === "running" ? ` ${vm.cpus} CPU ${vm.memoryMiB} MiB` : "";
    lines.push(`vm ${vm.profile ?? vm.kind}: ${vm.state}${size}; boot ${vm.bootSeconds ?? "?"} s${runtime.lifecycle ? `; ${runtime.lifecycle.reason}` : ""}`);
  }
  if (live.lastError) lines.push(`last error: ${live.lastError}`);
  const current = live.current ?? [];
  if (current.length) for (const run of current) lines.push(`now: ${currentLine(run)}`);
  else lines.push("now: nothing running");
  for (const run of (live.runs ?? []).filter((entry) => entry.waitingToReport)) lines.push(`run ${run.id} ${run.job}: finished, result waiting to send`);
  if (history.length) {
    lines.push("recent:");
    for (const entry of history.slice(0, recent)) lines.push(`  ${historyLine(entry, { now })}`);
  }
  const upcoming = (live.upcoming ?? []).map((entry) => `${entry.jobId} at ${new Date(entry.dueAt).toISOString()}`).join(", ") || "none";
  lines.push(`outbox: ${live.outbox}; upcoming: ${upcoming}`);
  return lines.join("\n");
}

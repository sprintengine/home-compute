// The dashboard's pure logic: formatting, schedules in UTC and Irish time,
// what needs attention, sparkline and timeline geometry, install commands.
// No DOM and no fetch here, so `node --test` imports it as it is
// (test/dashboard-lib.test.mjs).

/** The owner's local time, shown beside every UTC schedule (§7). */
export const LOCAL_ZONE = "Europe/Dublin";
export const LOCAL_NAME = "Irish time";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const WAITING_TOO_LONG_MS = 10 * MINUTE;

// ---------- Formatting

export function pad(value) {
  return String(value).padStart(2, "0");
}

export function parseTime(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? time : null;
}

/** "in 12 min", "3 h ago", "just now". */
export function relative(value, now = Date.now()) {
  const time = parseTime(value);
  if (time === null) return "never";
  const seconds = Math.round((time - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return seconds >= 0 ? "now" : "just now";
  let text;
  if (abs < 3600) text = `${Math.round(abs / 60)} min`;
  else if (abs < 86_400) text = `${Math.round(abs / 360) / 10} h`.replace(".0 h", " h");
  else text = `${Math.round(abs / 86_400)} d`;
  return seconds >= 0 ? `in ${text}` : `${text} ago`;
}

/** Seconds as "42s", "3m 05s", "1h 02m". */
export function duration(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "—";
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${pad(total % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`;
}

/** MiB as "410 MiB" or "1.5 GiB". */
export function mib(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value >= 1024) return `${Number((value / 1024).toFixed(value % 1024 === 0 ? 0 : 1))} GiB`;
  return `${Math.round(value)} MiB`;
}

export function bytes(value) {
  if (typeof value !== "number") return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

/** "2026101112" (a model run) as "11 Oct 12Z". */
export function modelRun(run) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})$/.exec(String(run ?? ""));
  if (!match) return run ? String(run) : "—";
  const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  return `${date.getUTCDate()} ${date.toLocaleString("en", { month: "short", timeZone: "UTC" })} ${match[4]}Z`;
}

/** A clock time in `zone` (default UTC): "08:20". */
export function clockIn(time, zone = "UTC") {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(time));
  const value = (type) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("hour")}:${value("minute")}`;
}

/** The offset of `zone` from UTC at `time`, in whole minutes (Irish summer time: 60). */
export function zoneOffsetMinutes(time, zone = LOCAL_ZONE) {
  const [hours, minutes] = clockIn(time, zone).split(":").map(Number);
  const utc = new Date(time);
  let offset = hours * 60 + minutes - (utc.getUTCHours() * 60 + utc.getUTCMinutes());
  if (offset > 12 * 60) offset -= DAY / MINUTE;
  if (offset < -12 * 60) offset += DAY / MINUTE;
  return offset;
}

/** "08:20 UTC · 09:20 Irish time", or just UTC when the two agree (Irish winter time is UTC). */
export function bothClocks(time) {
  const utc = clockIn(time, "UTC");
  const local = clockIn(time, LOCAL_ZONE);
  return utc === local ? `${utc} UTC` : `${utc} UTC · ${local} ${LOCAL_NAME}`;
}

// ---------- Schedules

/** An `at` schedule's slots in a UTC day, `[{hour, minute}]`, sorted. */
export function slotTimes(at) {
  const hours = at?.hours ?? Array.from({ length: 24 }, (_, hour) => hour);
  const minutes = at?.minutes ?? [0];
  return hours.flatMap((hour) => minutes.map((minute) => ({ hour, minute })))
    .sort((a, b) => a.hour - b.hour || a.minute - b.minute);
}

/** A schedule in UTC words: "Daily at 08:20, 10:20 UTC", "Hourly at :05 UTC", "Every 6h after the last run". */
export function scheduleText(schedule) {
  if (!schedule) return "No schedule";
  if (schedule.every) return `Every ${schedule.every} after the last run`;
  const at = schedule.at ?? {};
  const minutes = at.minutes ?? [0];
  if (!at.hours) return `Hourly at ${minutes.map((minute) => `:${pad(minute)}`).join(", ")} UTC`;
  const times = slotTimes(at).map(({ hour, minute }) => `${pad(hour)}:${pad(minute)}`);
  return `${times.length > 8 ? `${times.length} times a day: ` : "Daily at "}${times.join(", ")} UTC`;
}

/**
 * The same slots in Irish time today ("09:20, 11:20 Irish time"), or null
 * when there is nothing to add: an hourly or interval job, or a day when
 * Irish time is UTC.
 */
export function localScheduleText(schedule, now = Date.now()) {
  if (!schedule?.at?.hours) return null;
  const day = Math.floor(now / DAY) * DAY;
  const slots = slotTimes(schedule.at).map(({ hour, minute }) => day + hour * HOUR + minute * MINUTE);
  if (slots.every((slot) => zoneOffsetMinutes(slot) === 0)) return null;
  const times = slots.map((slot) => clockIn(slot, LOCAL_ZONE));
  return `${times.length > 8 ? `${times.slice(0, 8).join(", ")}…` : times.join(", ")} ${LOCAL_NAME}`;
}

/** The schedule with its Irish time beside it, for one line. */
export function scheduleLine(schedule, now = Date.now()) {
  const local = localScheduleText(schedule, now);
  return local ? `${scheduleText(schedule)} · ${local}` : scheduleText(schedule);
}

/**
 * Every job on a 24-hour UTC grid: `hourly` jobs (every hour, at their
 * minutes), `daily` rows (`slots[hour]` = minutes in that hour), `interval`
 * jobs, and `off` (disabled) ones folded apart.
 */
export function timetableModel(jobs) {
  const model = { hourly: [], daily: [], interval: [], unscheduled: [], off: [] };
  for (const job of jobs) {
    if (job.configuredEnabled === false || job.enabled === false && !job.paused) {
      model.off.push(job);
      continue;
    }
    const schedule = job.schedule;
    if (!schedule) model.unscheduled.push(job);
    else if (schedule.every) model.interval.push(job);
    else if (!schedule.at?.hours) model.hourly.push({ job, minutes: schedule.at?.minutes ?? [0] });
    else {
      const slots = Array.from({ length: 24 }, () => []);
      for (const { hour, minute } of slotTimes(schedule.at)) slots[hour].push(minute);
      model.daily.push({ job, slots });
    }
  }
  const byFirst = (row) => slotTimes(row.job.schedule.at)[0];
  model.daily.sort((a, b) => byFirst(a).hour - byFirst(b).hour || byFirst(a).minute - byFirst(b).minute || a.job.id.localeCompare(b.job.id));
  model.hourly.sort((a, b) => a.minutes[0] - b.minutes[0] || a.job.id.localeCompare(b.job.id));
  return model;
}

/** The daily slots of every job by UTC hour, for the phone's vertical list: `[{hour, entries: [{job, minute}]}]`. */
export function slotsByHour(model) {
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, entries: [] }));
  for (const row of model.daily) {
    row.slots.forEach((minutes, hour) => minutes.forEach((minute) => hours[hour].entries.push({ job: row.job, minute })));
  }
  for (const entry of hours) entry.entries.sort((a, b) => a.minute - b.minute || a.job.id.localeCompare(b.job.id));
  return hours.filter((entry) => entry.entries.length);
}

/** The Irish clock hour of each UTC hour today: `[0..23] → "01"`. */
export function localHours(now = Date.now()) {
  const day = Math.floor(now / DAY) * DAY;
  return Array.from({ length: 24 }, (_, hour) => clockIn(day + hour * HOUR, LOCAL_ZONE).slice(0, 2));
}

// ---------- Jobs and runs

export function jobState(job) {
  if (job.running) {
    const live = String(job.phase ?? job.liveState ?? job.activeState ?? "").toLowerCase();
    return ["due", "queued", "pending"].includes(live) ? "queued" : "running";
  }
  if (job.paused) return "paused";
  if (job.configuredEnabled === false) return "off";
  return "idle";
}

/** The peak memory a run used, in MiB: the workload's own figure when it reported one (§4.6), else the sampled peak. */
export function peakMiB(run) {
  const metrics = run?.metrics ?? {};
  if (typeof metrics.peakRssBytes === "number") return Math.round(metrics.peakRssBytes / 1048576);
  if (typeof metrics.peakMemoryMb === "number") return metrics.peakMemoryMb;
  if (typeof run?.stats?.peakMemoryBytes === "number") return Math.round(run.stats.peakMemoryBytes / 1048576);
  return null;
}

/** "peak 410 MiB over 20 runs; limit 1 GiB", from the runs that measured a peak. */
export function memoryHint(runs, limitMiB) {
  const peaks = (runs ?? []).map(peakMiB).filter((value) => typeof value === "number");
  const limit = typeof limitMiB === "number" ? `limit ${mib(limitMiB)}` : null;
  if (!peaks.length) return { peak: null, count: 0, text: ["no peak measured yet", limit].filter(Boolean).join("; ") };
  const peak = Math.max(...peaks);
  return { peak, count: peaks.length, text: [`peak ${mib(peak)} over ${peaks.length} run${peaks.length === 1 ? "" : "s"}`, limit].filter(Boolean).join("; ") };
}

/** Memory sizes the picker offers, in MiB, plus the current one if it is not among them. */
export function memoryChoices(current) {
  const sizes = [256, 512, 768, 1024, 1536, 2048, 3072, 4096, 6144, 8192];
  if (typeof current === "number" && !sizes.includes(current)) sizes.push(current);
  return sizes.sort((a, b) => a - b);
}

/** A run's phases, due → claimed → VM → pull → run → report, each with its start and how long it took. */
export function phaseSteps(run) {
  const at = (field) => parseTime(run?.[field]);
  const steps = [
    { key: "due", label: "Due", start: at("submittedAt") },
    { key: "claimed", label: "Claimed", start: at("claimedAt") },
    { key: "vm", label: "VM", start: at("vmStartedAt") },
    { key: "pull", label: "Pull", start: at("pullStartedAt") },
    { key: "run", label: "Run", start: at("startedAt") },
    { key: "report", label: "Report", start: at("reportingAt") },
  ];
  const finished = at("finishedAt");
  return steps.map((step, index) => {
    const end = steps.slice(index + 1).find((later) => later.start !== null)?.start ?? finished;
    let seconds = step.start !== null && end !== null && end >= step.start ? (end - step.start) / 1000 : null;
    // The agent's own measurements are exact where the server's receipt times are not (§3.1).
    if (step.key === "vm" && typeof run.vmWaitSeconds === "number") seconds = run.vmWaitSeconds;
    if (step.key === "pull" && typeof run.pullSeconds === "number") seconds = run.pullSeconds;
    if (step.key === "run" && typeof run.durationSeconds === "number") seconds = run.durationSeconds;
    const skipped = step.start === null && ["vm", "pull"].includes(step.key) && at("startedAt") !== null;
    return { ...step, seconds: skipped && !seconds ? null : seconds, skipped };
  });
}

export const PHASE_LABELS = {
  due: "Waiting", claimed: "Claimed", "starting-vm": "Starting VM", pulling: "Pulling", running: "Running", reporting: "Reporting",
  succeeded: "Succeeded", failed: "Failed", "timed-out": "Timed out", cancelled: "Cancelled", skipped: "Skipped", lost: "Lost",
};

export const TERMINAL_PHASES = new Set(["succeeded", "failed", "timed-out", "cancelled", "skipped"]);

/** A run's phase in hosted words, or its local controller state. */
export function phaseOf(run) {
  if (run?.phase) return run.phase;
  const state = String(run?.state ?? "").toLowerCase();
  return { queued: "due", pending: "claimed", completed: "succeeded" }[state] ?? state;
}

/** Bars for a duration sparkline: one per finished run, oldest left, height by duration. */
export function sparkBars(durations, { width = 120, height = 28, gap = 2 } = {}) {
  const runs = (durations ?? []).filter((entry) => typeof entry.seconds === "number");
  if (!runs.length) return [];
  const longest = Math.max(...runs.map((entry) => entry.seconds), 1);
  const slot = width / Math.max(runs.length, 8);
  const barWidth = Math.max(2, slot - gap);
  return runs.map((entry, index) => {
    const barHeight = Math.max(2, Math.round((entry.seconds / longest) * (height - 2)));
    return {
      x: Math.round(index * slot * 10) / 10, y: height - barHeight, width: Math.round(barWidth * 10) / 10, height: barHeight,
      failed: entry.outcome === "failed", seconds: entry.seconds, at: entry.at, id: entry.id,
    };
  });
}

/** One line about a job's recent durations, for people and screen readers. */
export function sparkSummary(durations) {
  const runs = (durations ?? []).filter((entry) => typeof entry.seconds === "number");
  if (!runs.length) return "No finished runs yet";
  const sorted = runs.map((entry) => entry.seconds).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const failed = runs.filter((entry) => entry.outcome === "failed").length;
  return `${runs.length} recent run${runs.length === 1 ? "" : "s"}, median ${duration(median)}, longest ${duration(sorted.at(-1))}${failed ? `, ${failed} failed` : ""}`;
}

// ---------- Machines

export const MACHINE_STATUS = {
  online: { label: "Online", tone: "good", icon: "●" },
  offline: { label: "Offline", tone: "critical", icon: "○" },
  draining: { label: "Draining", tone: "warning", icon: "◐" },
  unhealthy: { label: "Unhealthy", tone: "critical", icon: "✕" },
  revoked: { label: "Revoked", tone: "off", icon: "⊘" },
};

/** The VM in words: "running · 2 CPU 2 GiB · up 14 min", "stopped", or "no VM (Docker host)". */
export function vmText(machine, now = Date.now()) {
  const vm = machine?.vm;
  if (!vm?.state) return "No VM: Docker on the host";
  const parts = [vm.state];
  if (vm.state === "running" && vm.cpus) parts.push(`${vm.cpus} CPU ${mib(vm.memoryMiB)}`);
  const since = parseTime(machine.vmSince);
  if (since !== null) parts.push(`${vm.state === "running" ? "up" : "since"} ${vm.state === "running" ? relative(since, now).replace(" ago", "") : relative(since, now)}`);
  return parts.join(" · ");
}

/**
 * How long the VM ran within the last `windowMs`: the spans hc-core
 * recorded, clipped to the window; an open span ends now, or at the
 * machine's last sync when it went quiet.
 */
export function vmUptime(machine, now = Date.now(), windowMs = DAY) {
  const start = now - windowMs;
  const lastSeen = parseTime(machine?.lastSeenAt) ?? now;
  const spans = (machine?.vmHistory ?? []).map((span) => ({
    from: Math.max(start, parseTime(span.from) ?? start),
    to: Math.min(now, parseTime(span.to) ?? (machine.status === "offline" ? lastSeen : now)),
  })).filter((span) => span.to > span.from);
  const ms = spans.reduce((sum, span) => sum + span.to - span.from, 0);
  return { spans, ms, fraction: ms / windowMs };
}

/** Caps in words: "4 CPU · 6 GiB · 2 runs", or "agent's own figures". */
export function capsText(caps) {
  const parts = [];
  if (typeof caps?.cpus === "number") parts.push(`${caps.cpus} CPU`);
  if (typeof caps?.memoryMiB === "number") parts.push(mib(caps.memoryMiB));
  if (typeof caps?.diskMiB === "number") parts.push(`${mib(caps.diskMiB)} disk`);
  if (typeof caps?.maxRuns === "number") parts.push(`${caps.maxRuns} run${caps.maxRuns === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : "no caps: the agent's own figures";
}

// ---------- Attention

/**
 * What needs a look, most serious first: failed last runs, lost runs, runs
 * waiting more than ten minutes (with why), machines offline or unhealthy
 * (a failed VM says so), clock skew, agents needing an update, and jobs
 * blocked on secrets (folded into one line per reason).
 */
export function attentionItems(snapshot, now = Date.now()) {
  const items = [];
  const jobs = snapshot?.jobs ?? [];
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  for (const job of jobs) {
    if (jobState(job) === "off") continue;
    if (job.lastOutcome === "failed" || /fail|timed/i.test(job.lastFinishedState ?? "") && !job.lastOutcome) {
      items.push({
        kind: "failed", tone: "critical", icon: "✕", title: `${job.id}: last run failed`,
        detail: [job.lastError, job.lastFinishedAt ? relative(job.lastFinishedAt, now) : null].filter(Boolean).join(" · "),
        href: job.lastFinishedJobId ? runHref(job.lastFinishedJobId) : jobHref(job.id),
      });
    }
  }
  for (const run of snapshot?.lostRuns ?? []) {
    const job = jobById.get(run.job);
    const settled = job && parseTime(job.lastFinishedAt) !== null && parseTime(job.lastFinishedAt) > (parseTime(run.submittedAt) ?? 0);
    if (settled) continue;
    items.push({
      kind: "lost", tone: "critical", icon: "?", title: `${run.job}: run lost`,
      detail: `${run.machineName ?? "its machine"} stopped syncing; no later run has finished · due ${relative(run.submittedAt, now)}`,
      href: runHref(run.id),
    });
  }
  const blocked = new Map();
  for (const run of snapshot?.activeRuns ?? []) {
    if (phaseOf(run) !== "due") continue;
    const job = jobById.get(run.job);
    if (job?.blocked) continue;
    const waited = now - (parseTime(run.submittedAt) ?? now);
    if (waited < WAITING_TOO_LONG_MS) continue;
    items.push({ kind: "waiting", tone: "warning", icon: "◷", title: `${run.job}: waiting ${Math.round(waited / MINUTE)} min`, detail: (run.waiting ?? "").replace(/^waiting \d+ min: /, ""), href: runHref(run.id) });
  }
  for (const machine of snapshot?.machines ?? []) {
    const href = machineHref(machine.id);
    if (machine.status === "offline") {
      items.push({ kind: "offline", tone: "critical", icon: "○", title: `${machine.name} is offline`, detail: `last seen ${relative(machine.lastSeenAt, now)}`, href });
    } else if (machine.status === "unhealthy" || machine.health?.vm === "failed") {
      const vmFailed = machine.health?.vm === "failed";
      items.push({
        kind: vmFailed ? "vm-failed" : "unhealthy", tone: "critical", icon: "✕",
        title: vmFailed ? `${machine.name}: VM failed to start` : `${machine.name} is unhealthy`,
        detail: vmFailed ? machine.health?.lastError ?? "three starts in a row failed" : [machine.unhealthy, machine.health?.lastError].filter(Boolean).join(" · "), href,
      });
    }
    if (machine.clockSkewWarning) {
      items.push({ kind: "skew", tone: "warning", icon: "◷", title: `${machine.name}: clock ${Math.round(Math.abs(machine.clockSkewMs) / 1000)} s ${machine.clockSkewMs > 0 ? "ahead" : "behind"}`, detail: "slots and leases use the server's clock; fix the machine's time sync", href });
    }
    if (machine.updateAvailable) {
      items.push({ kind: "update", tone: "warning", icon: "↑", title: `${machine.name}: agent ${machine.agentVersion} needs an update`, detail: `to ${machine.desiredAgentVersion}`, href });
    }
  }
  for (const job of jobs) {
    if (!job.blocked || jobState(job) === "off") continue;
    if (!blocked.has(job.blocked)) blocked.set(job.blocked, []);
    blocked.get(job.blocked).push(job.id);
  }
  for (const [reason, ids] of blocked) {
    items.push({
      kind: "blocked", tone: "warning", icon: "⊘", title: `${ids.length} job${ids.length === 1 ? "" : "s"} blocked`,
      detail: `${reason.replace(/^needs/, "Need")} · ${ids.join(", ")}`, href: ids.length === 1 ? jobHref(ids[0]) : "#/timetable",
    });
  }
  const order = { critical: 0, warning: 1 };
  return items.sort((a, b) => order[a.tone] - order[b.tone]);
}

// ---------- Forms

/** "arch=arm64, site=home" (or one per line) as `{arch: "arm64", site: "home"}`; throws on a malformed pair. */
export function parseLabels(text) {
  const labels = {};
  for (const part of String(text ?? "").split(/[,\n]+/).map((item) => item.trim()).filter(Boolean)) {
    const match = /^([^=\s]+)\s*=\s*(\S+)$/.exec(part);
    if (!match) throw new Error(`"${part}" is not key=value`);
    labels[match[1]] = match[2];
  }
  return labels;
}

export function labelsText(labels) {
  return Object.entries(labels ?? {}).map(([key, value]) => `${key}=${value}`).join(", ");
}

/** Extra arguments as typed: split on spaces, with "double" or 'single' quotes keeping a space in one argument. */
export function parseArgs(text) {
  const args = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of String(text ?? "").matchAll(pattern)) args.push(match[1] ?? match[2] ?? match[3]);
  return args;
}

/** The image a tag job would pin to (`repo@sha256:…`) from a run's recorded digest, or null. */
export function pinnedImage(image, digest) {
  if (typeof image !== "string" || image.includes("@") || typeof digest !== "string") return null;
  if (/^[^@\s]+@sha256:[0-9a-f]{64}$/.test(digest)) return digest;
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) return null;
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  const repository = colon > slash ? image.slice(0, colon) : image;
  // A local image (no registry host) has an image id, not a registry digest.
  if (!repository.includes("/") || !/[.:]/.test(repository.split("/")[0]) && repository.split("/")[0] !== "localhost") return null;
  return `${repository}@${digest}`;
}

// ---------- Install commands (agent/README.md, "Install by hand")

/**
 * The copy-paste commands that install the agent on a Mac or a Linux box and
 * enrol it with a join token, in three steps each: install, enrol, start the
 * service. The token is never in them: the enrol step (one line, pasted on
 * its own so the prompt does not swallow the next command) asks for it
 * without echo and hands it to the agent on stdin, so it is in no command
 * line and no shell history.
 */
export function installCommands(server, { allowImages = "ghcr.io/sprintengine/*" } = {}) {
  const url = server || "<hc-core URL>";
  const ask = "printf 'Join token: '; read -rs HC_JOIN_TOKEN; echo; printf '%s' \"$HC_JOIN_TOKEN\" |";
  const mac = '"$HOME/Library/Application Support/home-compute"';
  const macAgent = `${mac.slice(0, -1)}/node/bin/node" ${mac.slice(0, -1)}/agent/current/home-compute-agent.mjs"`;
  const linuxAgent = "/opt/home-compute/node/bin/node /opt/home-compute/agent/current/home-compute-agent.mjs";
  return {
    macos: [
      { title: "Install", text: [
        "# Needs Homebrew, Node 22+ and git.",
        "brew install colima docker",
        "git clone https://github.com/sprintengine/home-compute.git ~/home-compute",
        "cd ~/home-compute && npm ci && npm run build:agent",
        `mkdir -p ${mac.slice(0, -1)}/agent/current" ${mac.slice(0, -1)}/node/bin" ~/Library/Logs/home-compute`,
        `cp agent/dist/home-compute-agent.mjs ${mac.slice(0, -1)}/agent/current/"`,
        `ln -sf "$(command -v node)" ${mac.slice(0, -1)}/node/bin/node"`,
      ].join("\n") },
      { title: "Enrol: paste this line on its own, then the token when asked", text:
        `${ask} ${macAgent} enrol --server ${url} --join-token-stdin --runtime colima --allow-images '${allowImages}'; unset HC_JOIN_TOKEN` },
      { title: "Check, then start the service", text: [
        `${macAgent} doctor --start-vm`,
        "cd ~/home-compute && sed \"s|@HOME@|$HOME|g\" agent/service/dev.homecompute.agent.plist > ~/Library/LaunchAgents/dev.homecompute.agent.plist",
        "launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.homecompute.agent.plist",
      ].join("\n") },
    ],
    linux: [
      { title: "Install", text: [
        "# Needs Docker Engine, git, sudo and Node 22+ installed for every user (not through nvm).",
        "git clone https://github.com/sprintengine/home-compute.git ~/home-compute",
        "cd ~/home-compute && npm ci && npm run build:agent",
        "sudo install -d /opt/home-compute/agent/current /opt/home-compute/node/bin",
        "sudo install -m 0644 agent/dist/home-compute-agent.mjs /opt/home-compute/agent/current/",
        'sudo ln -sf "$(command -v node)" /opt/home-compute/node/bin/node',
        "sudo useradd --system --home-dir /etc/home-compute --shell /usr/sbin/nologin hcagent && sudo usermod -aG docker hcagent",
        "sudo install -d -m 0700 -o hcagent -g hcagent /etc/home-compute",
      ].join("\n") },
      { title: "Enrol: paste this line on its own, then the token when asked", text:
        `${ask} sudo -u hcagent ${linuxAgent} enrol --state-dir /etc/home-compute --server ${url} --join-token-stdin --runtime docker --allow-images '${allowImages}'; unset HC_JOIN_TOKEN` },
      { title: "Check, then start the service", text: [
        `sudo -u hcagent ${linuxAgent} doctor --state-dir /etc/home-compute`,
        `sudo -u hcagent /opt/home-compute/node/bin/node -e 'const fs=require("fs"),f="/etc/home-compute/config.json",c=JSON.parse(fs.readFileSync(f,"utf8"));c.docker={...c.docker,cgroupParent:"home-compute.slice"};fs.writeFileSync(f,JSON.stringify(c,null,2)+"\\n")'`,
        "cd ~/home-compute && sudo cp agent/service/home-compute-agent.service agent/service/home-compute.slice /etc/systemd/system/",
        'sudo sed -i "s/@MEMORY_MAX@/6G/" /etc/systemd/system/home-compute.slice   # the most the jobs may use together',
        "sudo systemctl daemon-reload && sudo systemctl enable --now home-compute-agent",
      ].join("\n") },
    ],
  };
}

// ---------- Routes

export function jobHref(id) {
  return `#/job/${encodeURIComponent(id)}`;
}

export function runHref(id) {
  return `#/run/${encodeURIComponent(id)}`;
}

export function machineHref(id) {
  return `#/machine/${encodeURIComponent(id)}`;
}

/** The page a hash names: `{page, id?}`. Old run links (`#/job/<id>/run/<run>`) still work. */
export function parseRoute(hash) {
  const parts = String(hash ?? "").replace(/^#\/?/, "").split("/").filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  if (parts[0] === "job" && parts[1] && parts[2] === "run" && parts[3]) return { page: "run", id: parts[3], job: parts[1] };
  if (parts[0] === "job" && parts[1]) return { page: "job", id: parts[1] };
  if (parts[0] === "run" && parts[1]) return { page: "run", id: parts[1] };
  if (parts[0] === "machine" && parts[1]) return { page: "machine", id: parts[1] };
  if (parts[0] === "machines" && parts[1] === "add") return { page: "add-machine" };
  if (["machines", "timetable", "settings", "audit"].includes(parts[0])) return { page: parts[0] };
  return { page: "overview" };
}

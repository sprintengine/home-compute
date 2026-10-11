// The dashboard's pure logic (dashboard/lib.js): schedules in UTC with Irish
// time beside them, what needs attention, the timetable grid, sparklines,
// phases, VM uptime, forms and the install commands a join token comes with.
import assert from "node:assert/strict";
import test from "node:test";
import {
  attentionItems, bothClocks, installCommands, localScheduleText, memoryHint, parseArgs, parseLabels, parseRoute, peakMiB, phaseSteps,
  pinnedImage, scheduleLine, scheduleText, slotsByHour, sparkBars, sparkSummary, timetableModel, vmUptime, zoneOffsetMinutes,
} from "../dashboard/lib.js";

const SUMMER = Date.UTC(2026, 6, 1, 12); // Irish summer time: UTC+1
const WINTER = Date.UTC(2026, 11, 1, 12); // Irish standard time: UTC

test("schedules read in UTC with Irish time beside them, only when it differs", () => {
  const schedule = { at: { hours: [8, 10], minutes: [20] } };
  assert.equal(scheduleText(schedule), "Daily at 08:20, 10:20 UTC");
  assert.equal(localScheduleText(schedule, SUMMER), "09:20, 11:20 Irish time");
  assert.equal(localScheduleText(schedule, WINTER), null, "Irish winter time is UTC");
  assert.equal(scheduleLine(schedule, SUMMER), "Daily at 08:20, 10:20 UTC · 09:20, 11:20 Irish time");
  assert.equal(scheduleText({ at: { minutes: [5] } }), "Hourly at :05 UTC");
  assert.equal(localScheduleText({ at: { minutes: [5] } }, SUMMER), null, "an hourly job is the same minutes in Ireland");
  assert.equal(scheduleText({ every: "6h" }), "Every 6h after the last run");
  assert.equal(localScheduleText({ at: { hours: [23], minutes: [30] } }, SUMMER), "00:30 Irish time", "it wraps past midnight");
  assert.equal(zoneOffsetMinutes(SUMMER), 60);
  assert.equal(zoneOffsetMinutes(WINTER), 0);
  assert.equal(bothClocks(SUMMER), "12:00 UTC · 13:00 Irish time");
  assert.equal(bothClocks(WINTER), "12:00 UTC");
});

test("the timetable groups hourly, daily, interval and switched-off jobs", () => {
  const jobs = [
    { id: "blend", schedule: { at: { minutes: [5] } }, enabled: true },
    { id: "ecmwf", schedule: { at: { hours: [8, 10], minutes: [20] } }, enabled: true },
    { id: "harmonie", schedule: { at: { hours: [7, 12], minutes: [0] } }, enabled: false, paused: true },
    { id: "tides", schedule: { every: "6h" }, enabled: true },
    { id: "aifs", schedule: { at: { hours: [0], minutes: [25] } }, enabled: false, configuredEnabled: false },
    { id: "adhoc", schedule: null, enabled: true },
  ];
  const model = timetableModel(jobs);
  assert.deepEqual(model.hourly.map((row) => [row.job.id, row.minutes]), [["blend", [5]]]);
  assert.deepEqual(model.daily.map((row) => row.job.id), ["harmonie", "ecmwf"], "ordered by first slot; a paused job stays on the grid");
  assert.deepEqual(model.daily[1].slots[8], [20]);
  assert.deepEqual(model.interval.map((job) => job.id), ["tides"]);
  assert.deepEqual(model.off.map((job) => job.id), ["aifs"]);
  assert.deepEqual(model.unscheduled.map((job) => job.id), ["adhoc"]);
  assert.deepEqual(slotsByHour(model).map(({ hour, entries }) => [hour, entries.map((entry) => `${entry.job.id}:${entry.minute}`)]),
    [[7, ["harmonie:0"]], [8, ["ecmwf:20"]], [10, ["ecmwf:20"]], [12, ["harmonie:0"]]]);
});

test("attention: failed and lost runs, long waits with why, machines, updates and blocked jobs folded", () => {
  const now = Date.UTC(2026, 9, 11, 12);
  const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();
  const snapshot = {
    jobs: [
      { id: "flaky", configuredEnabled: true, lastOutcome: "failed", lastError: "OSError: disk full", lastFinishedAt: ago(5), lastFinishedJobId: "r_1" },
      { id: "off", configuredEnabled: false, lastOutcome: "failed" },
      { id: "backup", configuredEnabled: true, lastFinishedAt: ago(600) },
      { id: "settled", configuredEnabled: true, lastFinishedAt: ago(10) },
      { id: "ecmwf", configuredEnabled: true, blocked: "needs vault secrets, which arrive in M5: r2" },
      { id: "gfs", configuredEnabled: true, blocked: "needs vault secrets, which arrive in M5: r2" },
      { id: "render", configuredEnabled: true, running: true, phase: "due" },
      { id: "quick", configuredEnabled: true },
    ],
    lostRuns: [
      { id: "r_lost", job: "backup", phase: "lost", submittedAt: ago(300), machineName: "old-box" },
      { id: "r_old", job: "settled", phase: "lost", submittedAt: ago(60) },
    ],
    activeRuns: [
      { id: "r_wait", job: "render", phase: "due", submittedAt: ago(14), waiting: "waiting 14 min: no machine has labels gpu=yes" },
      { id: "r_new", job: "quick", phase: "due", submittedAt: ago(2), waiting: "waiting 2 min: preferred mac-mini busy" },
      { id: "r_blocked", job: "ecmwf", phase: "due", submittedAt: ago(90), waiting: "blocked: needs vault secrets" },
    ],
    machines: [
      { id: "m_1", name: "old-box", status: "offline", lastSeenAt: ago(180), updateAvailable: true, agentVersion: "0.1.0", desiredAgentVersion: "0.2.0" },
      { id: "m_2", name: "linux-1", status: "unhealthy", unhealthy: "its VM failed to start", health: { vm: "failed", lastError: "colima: exit 1" }, clockSkewWarning: true, clockSkewMs: 42_000 },
      { id: "m_3", name: "mac-mini", status: "online", health: { docker: "ok" } },
    ],
  };
  const items = attentionItems(snapshot, now);
  assert.deepEqual(items.map((item) => [item.kind, item.title]), [
    ["failed", "flaky: last run failed"],
    ["lost", "backup: run lost"],
    ["offline", "old-box is offline"],
    ["vm-failed", "linux-1: VM failed to start"],
    ["waiting", "render: waiting 14 min"],
    ["update", "old-box: agent 0.1.0 needs an update"],
    ["skew", "linux-1: clock 42 s ahead"],
    ["blocked", "2 jobs blocked"],
  ]);
  assert.equal(items.find((item) => item.kind === "waiting").detail, "no machine has labels gpu=yes");
  assert.equal(items.find((item) => item.kind === "vm-failed").detail, "colima: exit 1");
  assert.equal(items.find((item) => item.kind === "failed").href, "#/run/r_1");
  assert.match(items.find((item) => item.kind === "blocked").detail, /ecmwf, gfs$/);
  assert.deepEqual(attentionItems({ jobs: [], machines: [] }, now), []);
});

test("peak memory prefers the workload's own figure; the resources hint sums up the history", () => {
  assert.equal(peakMiB({ metrics: { peakMemoryMb: 300, peakRssBytes: 420 * 1048576 } }), 420);
  assert.equal(peakMiB({ metrics: { peakMemoryMb: 300 } }), 300);
  assert.equal(peakMiB({ stats: { peakMemoryBytes: 100 * 1048576 } }), 100);
  assert.equal(peakMiB({}), null);
  assert.equal(memoryHint([{ metrics: { peakMemoryMb: 410 } }, { metrics: { peakMemoryMb: 380 } }, {}], 1024).text, "peak 410 MiB over 2 runs; limit 1 GiB");
  assert.equal(memoryHint([], 512).text, "no peak measured yet; limit 512 MiB");
});

test("sparkline bars: one per finished run, the longest full height, failures marked", () => {
  const durations = [{ seconds: 30, outcome: "published" }, { seconds: 60, outcome: "failed" }, { seconds: null }, { seconds: 15, outcome: "completed" }];
  const bars = sparkBars(durations, { width: 120, height: 30 });
  assert.equal(bars.length, 3);
  assert.deepEqual(bars.map((bar) => bar.height), [14, 28, 7]);
  assert.ok(bars.every((bar) => bar.y + bar.height === 30), "anchored to the baseline");
  assert.deepEqual(bars.map((bar) => bar.failed), [false, true, false]);
  assert.equal(sparkSummary(durations), "3 recent runs, median 30s, longest 1m 00s, 1 failed");
  assert.deepEqual(sparkBars([]), []);
});

test("a run's phases with their durations, the agent's measurements first", () => {
  const at = (seconds) => new Date(Date.UTC(2026, 9, 11, 8, 20, seconds)).toISOString();
  const steps = phaseSteps({
    submittedAt: at(0), claimedAt: at(3), vmStartedAt: at(4), startedAt: at(30), reportingAt: at(50), finishedAt: at(51),
    vmWaitSeconds: 25.5, durationSeconds: 20,
  });
  assert.deepEqual(steps.map((step) => [step.key, step.seconds, step.skipped]), [
    ["due", 3, false], ["claimed", 1, false], ["vm", 25.5, false], ["pull", null, true], ["run", 20, false], ["report", 1, false],
  ]);
});

test("VM uptime over a day, from the spans hc-core keeps", () => {
  const now = Date.UTC(2026, 9, 11, 12);
  const hours = (count) => new Date(now - count * 3_600_000).toISOString();
  const machine = { status: "online", vmHistory: [{ from: hours(30), to: hours(20) }, { from: hours(6), to: hours(4) }, { from: hours(1), to: null }] };
  const uptime = vmUptime(machine, now);
  assert.equal(uptime.ms, (4 + 2 + 1) * 3_600_000, "clipped to the window; the open span runs to now");
  assert.equal(Math.round(uptime.fraction * 1000) / 1000, 0.292);
  const quiet = vmUptime({ ...machine, status: "offline", lastSeenAt: hours(0.5) }, now);
  assert.equal(quiet.ms, 6.5 * 3_600_000, "an offline machine's open span ends at its last sync");
});

test("forms: labels, extra arguments and pinning a tag to its digest", () => {
  assert.deepEqual(parseLabels("arch=arm64, site = home\ngpu=no"), { arch: "arm64", site: "home", gpu: "no" });
  assert.deepEqual(parseLabels(""), {});
  assert.throws(() => parseLabels("arch"), /not key=value/);
  assert.deepEqual(parseArgs(`--models ecmwf --note "two words" 'x y'`), ["--models", "ecmwf", "--note", "two words", "x y"]);
  const digest = `sha256:${"a".repeat(64)}`;
  assert.equal(pinnedImage("ghcr.io/sprintengine/wingfoil-forecast:production", digest), `ghcr.io/sprintengine/wingfoil-forecast@${digest}`);
  assert.equal(pinnedImage("localhost:5000/app", digest), `localhost:5000/app@${digest}`);
  assert.equal(pinnedImage("ghcr.io/x/y@sha256:abc", digest), null, "already pinned");
  assert.equal(pinnedImage("wingfoil-forecast:local", digest), null, "a local image has an image id, not a registry digest");
  assert.equal(pinnedImage("ghcr.io/x/y:1", "not-a-digest"), null);
});

test("install commands never carry the token and enrol from stdin, one step on its own", () => {
  const commands = installCommands("https://hc-core.example.workers.dev");
  for (const os of ["macos", "linux"]) {
    const [install, enrol, service] = commands[os];
    assert.doesNotMatch(install.text + service.text, /hcj_|join-token/);
    assert.equal(enrol.text.split("\n").length, 1, "the enrol step is one line, so its prompt reads the token and nothing else");
    assert.match(enrol.text, /read -rs HC_JOIN_TOKEN/);
    assert.match(enrol.text, /enrol .*--server https:\/\/hc-core\.example\.workers\.dev --join-token-stdin/);
    assert.match(enrol.text, /unset HC_JOIN_TOKEN$/);
  }
  assert.match(commands.macos[1].text, /--runtime colima/);
  assert.match(commands.macos[2].text, /launchctl bootstrap gui\/\$\(id -u\)/);
  assert.match(commands.linux[1].text, /sudo -u hcagent .* --state-dir \/etc\/home-compute/);
  assert.match(commands.linux[2].text, /systemctl enable --now home-compute-agent/);
  assert.match(installCommands(null).linux[1].text, /--server <hc-core URL>/);
});

test("routes, old run links included", () => {
  assert.deepEqual(parseRoute("#/"), { page: "overview" });
  assert.deepEqual(parseRoute("#/job/gfs-wave"), { page: "job", id: "gfs-wave" });
  assert.deepEqual(parseRoute("#/job/gfs/run/r_1"), { page: "run", id: "r_1", job: "gfs" });
  assert.deepEqual(parseRoute("#/run/r_2"), { page: "run", id: "r_2" });
  assert.deepEqual(parseRoute("#/machines/add"), { page: "add-machine" });
  assert.deepEqual(parseRoute("#/machine/m_1"), { page: "machine", id: "m_1" });
  assert.deepEqual(parseRoute("#/audit"), { page: "audit" });
  assert.deepEqual(parseRoute("#/nonsense"), { page: "overview" });
});

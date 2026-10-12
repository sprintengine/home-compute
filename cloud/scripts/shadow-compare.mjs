#!/usr/bin/env node
// Shadow mode's check (docs/hosted-control-plane.md §9, phase 0): over a
// window (48 hours by default), does the hosted timetable record exactly the
// slots the live Bacalhau-era controller submitted?
//
// - Hosted: every `source = 'schedule'` run whose slot falls in the window,
//   read from the deployed D1 with `wrangler d1 execute --remote` (read-only).
// - Live: the controller's per-job history files (`state/history/<job>.json`,
//   `source: "schedule"`, `submittedAt`) and `bacalhau job list` (job name
//   `<job>-<yyyymmdd>t<hhmmss>z`, label `home-compute.job`, creation time).
//   Only those three fields are read from Bacalhau: its job specs carry the
//   workload's environment, secrets included, and nothing else is kept.
//
// The controller's history keeps 50 runs per job, so each run adds what it
// sees to a ledger (`--state-dir`, default ~/Library/Application
// Support/home-compute/shadow) and the comparison reads the ledger. Run it
// hourly (a LaunchAgent, see docs/deploy.md); once the window has passed it
// writes the final report, and with `--pr` comments it on that pull request
// once.
//
//   node cloud/scripts/shadow-compare.mjs --start 2026-10-12T15:50:00Z [--hours 48]
//     [--controller-state ../wingfoil/deploy/home-compute/state] [--pr sprintengine/home-compute#2]

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { nextSlot } from "../../src/core/schedule.mjs";

const run = promisify(execFile);
const HOUR = 3_600_000;
const MINUTE = 60_000;
/** A controller submission counts for the slot it follows by at most this much (its poll interval plus margin). */
const MATCH_WINDOW_MS = 10 * MINUTE;
const CLOUD = path.resolve(import.meta.dirname, "..");

function parseArgs(argv) {
  const options = {
    hours: 48,
    controllerState: path.resolve(CLOUD, "../../wingfoil/deploy/home-compute/state"),
    stateDir: path.join(os.homedir(), "Library/Application Support/home-compute/shadow"),
    bacalhau: path.join(os.homedir(), ".local/bin/bacalhau"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => argv[++index];
    if (arg === "--start") options.start = Date.parse(value());
    else if (arg === "--hours") options.hours = Number(value());
    else if (arg === "--controller-state") options.controllerState = path.resolve(value());
    else if (arg === "--state-dir") options.stateDir = path.resolve(value());
    else if (arg === "--bacalhau") options.bacalhau = value();
    else if (arg === "--pr") options.pr = value();
    else if (arg === "--now") options.now = Date.parse(value());
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!Number.isFinite(options.start)) throw new Error("--start needs an ISO time (the first hosted slot after the import)");
  return options;
}

async function d1(sql) {
  const { stdout } = await run(path.join(CLOUD, "../node_modules/.bin/wrangler"),
    ["d1", "execute", "home-compute", "--remote", "-c", "wrangler.core.jsonc", "--json", "--command", sql],
    { cwd: CLOUD, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  return JSON.parse(stdout).flatMap((batch) => batch.results);
}

/** The controller's submissions in its history files: `{job, at, id, source, startedAt, finishedAt}`. */
async function historySubmissions(stateDir) {
  const directory = path.join(stateDir, "history");
  const found = [];
  for (const file of existsSync(directory) ? await readdir(directory) : []) {
    if (!file.endsWith(".json")) continue;
    const history = JSON.parse(await readFile(path.join(directory, file), "utf8"));
    for (const entry of history.runs ?? []) {
      if (!entry.submittedAt) continue;
      found.push({
        job: entry.job ?? history.job, at: Date.parse(entry.submittedAt), id: entry.id, source: entry.source ?? null,
        startedAt: entry.startedAt ? Date.parse(entry.startedAt) : null,
        finishedAt: entry.finishedAt ? Date.parse(entry.finishedAt) : null,
      });
    }
  }
  return found;
}

/** Bacalhau's jobs: name, job label and creation time only (the specs hold secrets; nothing else is read). */
async function bacalhauSubmissions(binary, since) {
  if (!existsSync(binary)) return [];
  let stdout;
  try {
    ({ stdout } = await run(binary, ["job", "list", "--limit", "2000", "--order-by", "created_at", "--order-reversed", "--output", "json"],
      { maxBuffer: 256 * 1024 * 1024 }));
  } catch {
    return [];
  }
  const found = [];
  for (const job of JSON.parse(stdout)) {
    const at = Math.floor(Number(job.CreateTime) / 1e6);
    const name = String(job.Name ?? "");
    const label = job.Labels?.["home-compute.job"];
    if (!label || at < since) continue;
    found.push({ job: label, at, id: String(job.ID ?? ""), name });
  }
  return found;
}

async function readLedger(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return { submissions: {} };
  }
}

async function writeAtomic(file, text) {
  await writeFile(`${file}.tmp`, text);
  await rename(`${file}.tmp`, file);
}

function slotsBetween(schedule, from, to) {
  if (!schedule?.at) return [];
  const slots = [];
  for (let slot = nextSlot(schedule.at, from - 1); slot <= to; slot = nextSlot(schedule.at, slot)) slots.push(slot);
  return slots;
}

const iso = (time) => new Date(time).toISOString().replace(".000Z", "Z");

export function compare({ jobs, hosted, submissions, start, end }) {
  const rows = [];
  const problems = [];
  for (const job of jobs) {
    if (!job.enabled || !job.schedule?.at) continue;
    const expected = slotsBetween(job.schedule, start, end);
    const hostedSlots = new Map(hosted.filter((row) => row.job_id === job.id).map((row) => [row.slot_at, row]));
    const live = submissions.filter((entry) => entry.job === job.id).sort((a, b) => a.at - b.at);
    let matched = 0;
    let coalesced = 0;
    const used = new Set();
    for (const slot of expected) {
      if (!hostedSlots.has(slot)) problems.push(`${job.id}: hosted has no row for the ${iso(slot)} slot`);
      const submission = live.find((entry) => !used.has(entry) && entry.at >= slot && entry.at < slot + MATCH_WINDOW_MS);
      if (submission) {
        used.add(submission);
        matched += 1;
        continue;
      }
      // The controller coalesces: a slot that comes while the job's previous run is still going is not submitted.
      const running = live.find((entry) => entry.at < slot && entry.startedAt !== null && (entry.finishedAt === null || entry.finishedAt > slot));
      if (running) {
        coalesced += 1;
        continue;
      }
      problems.push(`${job.id}: the controller submitted nothing for the ${iso(slot)} slot`);
    }
    for (const entry of live) {
      if (used.has(entry) || entry.at < start || entry.at > end + MATCH_WINDOW_MS) continue;
      problems.push(`${job.id}: the controller submitted at ${iso(entry.at)}, which is no hosted slot`);
    }
    for (const [slot] of hostedSlots) {
      if (slot >= start && slot <= end && !expected.includes(slot)) problems.push(`${job.id}: hosted recorded ${iso(slot)}, which the timetable does not have`);
    }
    rows.push({ job: job.id, expected: expected.length, hosted: expected.filter((slot) => hostedSlots.has(slot)).length, matched, coalesced });
  }
  return { rows, problems };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const now = options.now ?? Date.now();
  const start = options.start;
  const end = start + options.hours * HOUR;
  const until = Math.min(now - 2 * MINUTE, end);
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  const ledgerFile = path.join(options.stateDir, "ledger.json");
  const ledger = await readLedger(ledgerFile);
  // Keyed by the Bacalhau job id, which the history records too: Bacalhau says when, the history says why (schedule or manual) and how long.
  for (const entry of [...await bacalhauSubmissions(options.bacalhau, start - HOUR), ...await historySubmissions(options.controllerState)]) {
    if (entry.at < start - HOUR || !entry.id) continue;
    const previous = ledger.submissions[entry.id] ?? {};
    ledger.submissions[entry.id] = {
      job: entry.job, at: previous.at ?? entry.at, source: entry.source ?? previous.source ?? null,
      startedAt: entry.startedAt ?? previous.startedAt ?? null, finishedAt: entry.finishedAt ?? previous.finishedAt ?? null,
    };
  }
  await writeAtomic(ledgerFile, `${JSON.stringify(ledger)}\n`);

  const jobs = (await d1("SELECT id, enabled, paused, schedule_json FROM jobs ORDER BY id"))
    .map((row) => ({ id: row.id, enabled: row.enabled === 1, paused: row.paused === 1, schedule: JSON.parse(row.schedule_json ?? "null") }));
  const hosted = await d1(`SELECT job_id, slot_at, state, skip_reason FROM runs WHERE source = 'schedule' AND slot_at >= ${start} AND slot_at <= ${until}`);
  const scheduled = Object.values(ledger.submissions).filter((entry) => entry.source !== "manual");
  const result = compare({ jobs, hosted, submissions: scheduled, start, end: until });
  const done = until >= end;
  const lines = [
    `# Shadow comparison: hosted slots against the live controller`,
    "",
    `Window ${iso(start)} to ${iso(end)} (${options.hours} h); compared up to ${iso(until)}${done ? " — complete" : ` — ${((end - until) / HOUR).toFixed(1)} h to go`}.`,
    `Hosted rows that are not skipped (anything ran or waited hosted): ${hosted.filter((row) => row.state !== "skipped").length}.`,
    "",
    "| Job | Slots | Hosted recorded | Controller submitted | Coalesced by the controller |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...result.rows.map((row) => `| ${row.job} | ${row.expected} | ${row.hosted} | ${row.matched} | ${row.coalesced} |`),
    "",
    result.problems.length ? `## ${result.problems.length} difference(s)\n\n${result.problems.map((problem) => `- ${problem}`).join("\n")}` : "No differences.",
    "",
  ];
  const report = lines.join("\n");
  await writeAtomic(path.join(options.stateDir, done ? "final.md" : "latest.md"), report);
  process.stdout.write(report);
  const posted = path.join(options.stateDir, "posted");
  if (done && options.pr && !existsSync(posted)) {
    const [repo, number] = options.pr.split("#");
    await run("gh", ["pr", "comment", number, "--repo", repo, "--body-file", path.join(options.stateDir, "final.md")]);
    await writeFile(posted, `${new Date().toISOString()}\n`);
  }
  process.exitCode = result.problems.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
}

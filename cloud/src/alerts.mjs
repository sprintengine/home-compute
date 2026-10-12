// Alerts: what the owner must hear about without looking (pulled forward
// from M8). hc-core's cron calls `alertMinute` once a minute. It works out
// which problems exist now, opens, updates and resolves `alerts` rows to
// match, and sends one email for whatever changed, through the Email
// Routing `send_email` binding (ALERT_EMAIL) to a verified address
// (ALERT_EMAIL_TO, from ALERT_EMAIL_FROM on a zone with Email Routing).
// The dashboard shows the open ones on every page whether or not email works.
//
// The problems:
// - job-failing: a job's last two runs failed (`schedule_state.fail_streak`);
// - stale: a tracked output (`report.freshness`) older than its maxAgeHours,
//   from the newest `run` the job published here or, with a `url`, read from
//   the published pointer (every 15 minutes), so it works whichever system
//   ran the job. It waits for the first slot after the limit passed plus an
//   hour: a job that publishes every six hours and goes stale between two
//   slots is only a problem if the next slot does not fix it;
// - no-machine: no enrolled machine has synced for 10 minutes;
// - waiting: a run due more than 15 minutes ago that no machine has taken;
// - the cron itself: it writes `cron_last_tick` every minute; hc-core's
//   /health says 503 once that is 5 minutes old, which the dead-man check
//   outside Cloudflare (.github/workflows/deadman.yml) turns into an issue,
//   and the dashboard shows a banner. The cron cannot report its own absence.

import { newId } from "../../src/core/ids.mjs";
import { nextSlot } from "../../src/core/schedule.mjs";
import { parseDuration } from "../../src/core/job.mjs";
import { putSetting } from "./db.mjs";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const NO_MACHINE_MS = 10 * MINUTE;
export const WAITING_MS = 15 * MINUTE;
export const STALE_SLOT_GRACE_MS = HOUR;
export const CRON_STALE_MS = 5 * MINUTE;
const PROBE_EVERY_MINUTES = 15;
const PROBE_TIMEOUT_MS = 8_000;
const PROBE_MAX_BYTES = 512 * 1024;
const REMIND_MS = 24 * HOUR;
/** At most one email per 5 minutes: what changes meanwhile goes in the next. */
const EMAIL_GAP_MS = 5 * MINUTE;
const EMAIL_RETRY_MS = 10 * MINUTE;
const RESOLVED_KEEP_MS = 90 * 24 * HOUR;

function parse(text, fallback) {
  try {
    return text === null || text === undefined ? fallback : JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** A published `run` as epoch ms: `YYYYMMDDHH` (a model cycle or an observation hour, UTC) or an ISO time; else null. */
export function runTime(run) {
  if (run === null || run === undefined) return null;
  const text = String(run);
  const hour = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})$/);
  if (hour) {
    const time = Date.UTC(Number(hour[1]), Number(hour[2]) - 1, Number(hour[3]), Number(hour[4]));
    return Number.isFinite(time) ? time : null;
  }
  const time = Date.parse(text);
  return Number.isFinite(time) && /^\d{4}-\d{2}-\d{2}T/.test(text) ? time : null;
}

/**
 * When a stale output becomes worth an alert: the first slot of the job
 * after it crossed its limit, plus an hour for that run to publish. A job
 * without an `at` timetable gets its interval (or nothing) plus the hour.
 */
export function staleAlertAt(job, crossedAt) {
  const at = job.schedule?.at;
  if (at) return nextSlot(at, crossedAt - 1) + STALE_SLOT_GRACE_MS;
  let interval = 0;
  try {
    interval = job.schedule?.every ? parseDuration(job.schedule.every) : 0;
  } catch { /* none */ }
  return crossedAt + interval + STALE_SLOT_GRACE_MS;
}

const hours = (ms) => `${(ms / HOUR).toFixed(1)} h`;

/**
 * The problems that exist at `now`, by key. Pure: the rows come from D1 and
 * the probes from `settings.freshness_probes`.
 */
export function currentProblems({ jobs, machines, waiting, probes = {}, globalPause = false }, now) {
  const problems = new Map();
  const add = (key, kind, target, summary, detail = {}) => problems.set(key, { key, kind, target, summary, detail });
  for (const job of jobs) {
    if (!job.enabled) continue;
    if (!job.paused && !globalPause && job.failStreak >= 2) {
      add(`job-failing:${job.id}`, "job-failing", job.id, `${job.id} failed ${job.failStreak} times in a row`,
        { failStreak: job.failStreak, lastRunId: job.lastRunId, lastError: job.lastError ?? null });
    }
    for (const [value, freshness] of Object.entries(job.report?.freshness ?? {})) {
      const published = runTime(job.published?.[value]?.run) ?? (job.published?.[value]?.at ? Date.parse(job.published[value].at) : null);
      const probe = freshness.url ? probes[freshness.url] : null;
      const probed = runTime(probe?.run);
      const newest = Math.max(published ?? -Infinity, probed ?? -Infinity);
      if (!Number.isFinite(newest)) continue;
      const limit = freshness.maxAgeHours * HOUR;
      const crossedAt = newest + limit;
      if (now <= crossedAt || now < staleAlertAt(job, crossedAt)) continue;
      add(`stale:${job.id}:${value}`, "stale", `${job.id}:${value}`,
        `${value} is ${hours(now - newest)} old (limit ${freshness.maxAgeHours} h)`,
        { job: job.id, value, run: probe?.run ?? job.published?.[value]?.run ?? null, maxAgeHours: freshness.maxAgeHours,
          ageHours: Math.round((now - newest) / HOUR * 10) / 10, source: probed !== null && probed >= (published ?? -Infinity) ? freshness.url : "published" });
    }
  }
  const enrolled = machines.filter((machine) => !machine.revokedAt);
  if (enrolled.length) {
    const lastSeen = Math.max(...enrolled.map((machine) => machine.lastSeenAt ?? machine.enrolledAt ?? 0));
    if (now - lastSeen > NO_MACHINE_MS) {
      add("no-machine", "no-machine", null, `No machine online for ${Math.round((now - lastSeen) / MINUTE)} min`,
        { machines: enrolled.map((machine) => ({ name: machine.name, lastSeenAt: machine.lastSeenAt })) });
    }
  }
  const byJob = new Map();
  for (const run of waiting) if (!byJob.has(run.jobId) || run.dueAt < byJob.get(run.jobId).dueAt) byJob.set(run.jobId, run);
  for (const run of byJob.values()) {
    add(`waiting:${run.jobId}`, "waiting", run.jobId, `${run.jobId} has waited ${Math.round((now - run.dueAt) / MINUTE)} min for a machine`,
      { runId: run.id, dueAt: run.dueAt, source: run.source });
  }
  return problems;
}

// ---------- Freshness probes

/** The pointer URLs of every enabled job's tracked outputs. */
export function probeUrls(jobs) {
  return [...new Set(jobs.filter((job) => job.enabled).flatMap((job) => Object.values(job.report?.freshness ?? {})
    .map((entry) => entry.url).filter(Boolean)))].sort();
}

/** The `run` of a published JSON pointer: a top-level `run` field, read without parsing a large file whole. */
export function pointerRun(text) {
  if (text.length <= 64 * 1024) {
    try {
      const body = JSON.parse(text);
      return body && typeof body === "object" && body.run !== undefined ? String(body.run) : null;
    } catch {
      return null;
    }
  }
  const match = text.match(/"run"\s*:\s*"?([0-9TZ:.+-]{10,32})"?/);
  return match ? match[1] : null;
}

async function probe(url, fetcher) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetcher(url, { headers: { accept: "application/json", "cache-control": "no-cache" }, signal: controller.signal });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    const text = (await response.text()).slice(0, PROBE_MAX_BYTES);
    const run = pointerRun(text);
    return run ? { run } : { error: "no run field" };
  } catch (error) {
    return { error: error.name === "AbortError" ? "timed out" : String(error.message ?? error).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

/** Reads every pointer (at most 40), keeping the last good `run` when a read fails. */
export async function probeAll(urls, previous, now, fetcher) {
  const result = {};
  const answers = await Promise.all(urls.slice(0, 40).map((url) => probe(url, fetcher).then((answer) => [url, answer])));
  for (const [url, answer] of answers) {
    const before = previous?.[url] ?? {};
    result[url] = answer.run
      ? { run: answer.run, checkedAt: now }
      : { run: before.run ?? null, checkedAt: before.checkedAt ?? null, error: answer.error, failedAt: now };
  }
  return result;
}

// ---------- Email

/** An RFC 5322 message, plain text, UTF-8. Header values are ASCII (the subject is kept so). */
export function emailMessage({ from, to, subject, text, now, id }) {
  const domain = String(from).split("@")[1] ?? "home-compute.invalid";
  const clean = (value) => String(value).replace(/[\r\n]+/g, " ").replace(/[^\x20-\x7e]/g, "?");
  return [
    `From: Home Compute <${clean(from)}>`,
    `To: ${clean(to)}`,
    `Subject: ${clean(subject)}`,
    `Date: ${new Date(now).toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${clean(id)}@${clean(domain)}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "Auto-Submitted: auto-generated",
    "",
    String(text).replace(/\r?\n/g, "\r\n"),
    "",
  ].join("\r\n");
}

/** The email for these changes: newly opened, resolved, and (daily) still open. */
export function alertEmail({ opened, resolved, reminders, open, dashboardUrl, now }) {
  const parts = [];
  if (opened.length) parts.push(`${opened.length} new: ${opened.map((alert) => alert.summary).join("; ")}`);
  if (resolved.length) parts.push(`${resolved.length} resolved`);
  if (!opened.length && !resolved.length && reminders.length) parts.push(`${reminders.length} still open`);
  const subject = `[Home Compute] ${parts.join(", ")}`.slice(0, 180);
  const line = (alert) => `- ${alert.summary} (since ${new Date(alert.openedAt).toISOString().slice(0, 16).replace("T", " ")} UTC)`;
  const sections = [];
  if (opened.length) sections.push(["New problems:", ...opened.map(line)].join("\n"));
  if (resolved.length) sections.push(["Resolved:", ...resolved.map((alert) => `- ${alert.summary}`)].join("\n"));
  const still = open.filter((alert) => !opened.some((entry) => entry.key === alert.key));
  if (still.length) sections.push(["Still open:", ...still.map(line)].join("\n"));
  if (dashboardUrl) sections.push(`Dashboard: ${dashboardUrl}`);
  sections.push(`Sent by Home Compute's control plane at ${new Date(now).toISOString()}. You get one email when a problem starts, one when it ends, and a reminder each day it stays open.`);
  return { subject, text: sections.join("\n\n") };
}

/** Whether email can be sent, and why not. */
export function emailConfigured(env) {
  if (!env.ALERT_EMAIL) return "the send_email binding ALERT_EMAIL is missing";
  if (!env.ALERT_EMAIL_TO) return "ALERT_EMAIL_TO is not set";
  if (!env.ALERT_EMAIL_FROM) return "ALERT_EMAIL_FROM is not set";
  return null;
}

/** Sends through the binding; `send` is for tests. */
async function sendEmail(env, message, { from, to }, send) {
  if (send) return send({ from, to, raw: message });
  const { EmailMessage } = await import("cloudflare:email");
  return env.ALERT_EMAIL.send(new EmailMessage(from, to, message));
}

// ---------- The minute

function alertView(row) {
  return { id: row.id, key: row.key, kind: row.kind, target: row.target, summary: row.summary, openedAt: row.opened_at };
}

/**
 * One minute of alerting: the cron heartbeat, the pointer probes (every 15
 * minutes), opening and resolving alerts to match the problems, and the
 * email. Returns what it did. `fetcher` and `send` are for tests.
 */
export async function alertMinute(env, now, { fetcher = (...args) => fetch(...args), send } = {}) {
  const db = env.DB;
  const minute = Math.floor(now / MINUTE);
  const [jobRows, machineRows, waitingRows, settingRows, openRows] = (await db.batch([
    db.prepare(`SELECT j.id, j.enabled, j.paused, j.schedule_json, j.report_json, s.fail_streak, s.published_json, s.last_run_id
      FROM jobs j LEFT JOIN schedule_state s ON s.job_id = j.id`),
    db.prepare("SELECT id, name, last_seen_at, enrolled_at, revoked_at FROM machines WHERE revoked_at IS NULL"),
    db.prepare(`SELECT r.id, r.job_id, r.due_at, r.source FROM runs r JOIN jobs j ON j.id = r.job_id
      WHERE r.state = 'due' AND r.due_at < ?1 AND (r.source = 'manual' OR (j.enabled = 1 AND j.paused = 0
        AND COALESCE((SELECT value_json FROM settings WHERE key = 'global_pause'), 'false') != 'true'))
      ORDER BY r.due_at LIMIT 50`).bind(now - WAITING_MS),
    db.prepare("SELECT key, value_json FROM settings WHERE key IN ('global_pause', 'freshness_probes', 'alert_delivery')"),
    db.prepare("SELECT * FROM alerts WHERE resolved_at IS NULL OR resolve_notified_at IS NULL"),
  ])).map((result) => result.results);
  const settings = Object.fromEntries(settingRows.map((row) => [row.key, parse(row.value_json, null)]));
  const jobs = jobRows.map((row) => ({
    id: row.id, enabled: row.enabled === 1, paused: row.paused === 1, schedule: parse(row.schedule_json, null),
    report: parse(row.report_json, null), failStreak: row.fail_streak ?? 0, published: parse(row.published_json, {}) ?? {},
    lastRunId: row.last_run_id,
  }));
  const writes = [putSetting(db, "cron_last_tick", now)];

  let probes = settings.freshness_probes ?? {};
  let probed = 0;
  const urls = probeUrls(jobs);
  if (urls.length && (minute % PROBE_EVERY_MINUTES === 3 || urls.some((url) => !probes[url]))) {
    probes = await probeAll(urls, probes, now, fetcher);
    probed = urls.length;
    writes.push(putSetting(db, "freshness_probes", probes));
  }

  const problems = currentProblems({
    jobs,
    machines: machineRows.map((row) => ({ name: row.name, lastSeenAt: row.last_seen_at, enrolledAt: row.enrolled_at, revokedAt: row.revoked_at })),
    waiting: waitingRows.map((row) => ({ id: row.id, jobId: row.job_id, dueAt: row.due_at, source: row.source })),
    probes,
    globalPause: settings.global_pause === true,
  }, now);

  const open = openRows.filter((row) => row.resolved_at === null);
  const openKeys = new Set(open.map((row) => row.key));
  const opened = [];
  const changed = [];
  for (const problem of problems.values()) {
    if (openKeys.has(problem.key)) {
      const row = open.find((entry) => entry.key === problem.key);
      if (row.summary !== problem.summary) {
        changed.push({ id: row.id, summary: problem.summary, detail: JSON.stringify(problem.detail) });
        row.summary = problem.summary;
      }
      continue;
    }
    opened.push({ id: newId("a", now), ...problem, openedAt: now });
  }
  const resolvedNow = [];
  const closedNow = new Set();
  for (const row of open) {
    // A test alert resolves itself once its email has gone (or after an hour without one), quietly.
    const test = row.kind === "test";
    if (test ? row.notified_at === null && now - row.opened_at < HOUR : problems.has(row.key)) continue;
    closedNow.add(row);
    if (!test) resolvedNow.push(row);
  }
  // Each kind of change is one statement whatever the number of alerts (D1 allows 50 queries per invocation).
  if (opened.length) {
    writes.push(db.prepare(`INSERT INTO alerts (id, key, kind, target, summary, detail_json, opened_at, updated_at)
      SELECT value->>'id', value->>'key', value->>'kind', value->>'target', value->>'summary', value->>'detail', ?1, ?1
      FROM json_each(?2) WHERE true ON CONFLICT DO NOTHING`)
      .bind(now, JSON.stringify(opened.map((alert) => ({ ...alert, detail: JSON.stringify(alert.detail) })))));
  }
  if (changed.length) {
    writes.push(db.prepare(`UPDATE alerts SET
        summary = (SELECT value->>'summary' FROM json_each(?1) WHERE value->>'id' = alerts.id),
        detail_json = (SELECT value->>'detail' FROM json_each(?1) WHERE value->>'id' = alerts.id), updated_at = ?2
      WHERE id IN (SELECT value->>'id' FROM json_each(?1)) AND resolved_at IS NULL`).bind(JSON.stringify(changed), now));
  }
  if (closedNow.size) {
    const tests = [...closedNow].filter((row) => row.kind === "test").map((row) => row.id);
    writes.push(db.prepare(`UPDATE alerts SET resolved_at = ?1, updated_at = ?1,
        resolve_notified_at = CASE WHEN id IN (SELECT value FROM json_each(?3)) THEN ?1 ELSE resolve_notified_at END
      WHERE id IN (SELECT value FROM json_each(?2)) AND resolved_at IS NULL`)
      .bind(now, JSON.stringify([...closedNow].map((row) => row.id)), JSON.stringify(tests)));
  }
  if (minute % 60 === 41) writes.push(db.prepare("DELETE FROM alerts WHERE resolved_at IS NOT NULL AND resolved_at < ?").bind(now - RESOLVED_KEEP_MS));
  await db.batch(writes);

  // The email: new problems not yet told, resolved ones that were told, and daily reminders.
  const delivery = settings.alert_delivery ?? {};
  const stillOpen = [...open.filter((row) => !closedNow.has(row)).map(alertView), ...opened];
  const unsentOpen = [...open.filter((row) => row.notified_at === null && !closedNow.has(row)).map(alertView), ...opened];
  const resolvedRows = [...openRows.filter((row) => row.resolved_at !== null), ...resolvedNow];
  const resolvedTold = resolvedRows.filter((row) => row.notified_at !== null);
  const resolvedUntold = resolvedRows.filter((row) => row.notified_at === null);
  const reminders = open.filter((row) => !closedNow.has(row) && row.notified_at !== null && now - (row.reminded_at ?? row.notified_at) >= REMIND_MS);
  const summary = { probed, open: stillOpen.length, opened: opened.length, resolved: resolvedNow.length, emailed: false };
  const marks = [];
  // Opened and resolved before anyone was told: nothing to say.
  if (resolvedUntold.length) {
    marks.push(db.prepare("UPDATE alerts SET resolve_notified_at = ?1 WHERE id IN (SELECT value FROM json_each(?2))")
      .bind(now, JSON.stringify(resolvedUntold.map((row) => row.id))));
  }
  const due = unsentOpen.length || resolvedTold.length || reminders.length;
  const quiet = delivery.lastSentAt && now - delivery.lastSentAt < EMAIL_GAP_MS;
  const backingOff = delivery.lastErrorAt && now - delivery.lastErrorAt < EMAIL_RETRY_MS && (delivery.lastSentAt ?? 0) < delivery.lastErrorAt;
  if (due && !quiet && !backingOff) {
    const problem = emailConfigured(env);
    if (problem) {
      // A missing setting is checked again every minute: it is fixed by a deploy, not by waiting.
      if (delivery.error !== problem) marks.push(putSetting(db, "alert_delivery", { ...delivery, ok: false, error: problem }));
    } else {
      const content = alertEmail({ opened: unsentOpen, resolved: resolvedTold.map(alertView), reminders, open: stillOpen, dashboardUrl: env.DASHBOARD_URL, now });
      const message = emailMessage({ from: env.ALERT_EMAIL_FROM, to: env.ALERT_EMAIL_TO, ...content, now, id: newId("mail", now) });
      try {
        await sendEmail(env, message, { from: env.ALERT_EMAIL_FROM, to: env.ALERT_EMAIL_TO }, send);
        summary.emailed = true;
        const ids = (rows) => JSON.stringify(rows.map((row) => row.id));
        marks.push(
          db.prepare("UPDATE alerts SET notified_at = ?1 WHERE id IN (SELECT value FROM json_each(?2)) AND notified_at IS NULL").bind(now, ids(unsentOpen)),
          db.prepare("UPDATE alerts SET resolve_notified_at = ?1 WHERE id IN (SELECT value FROM json_each(?2))").bind(now, ids(resolvedTold)),
          db.prepare("UPDATE alerts SET reminded_at = ?1 WHERE id IN (SELECT value FROM json_each(?2))").bind(now, ids(reminders)),
          putSetting(db, "alert_delivery", { ok: true, lastSentAt: now, lastSubject: content.subject }),
        );
      } catch (error) {
        const message = String(error?.message ?? error).slice(0, 300);
        console.error(JSON.stringify({ event: "alert_email_failed", error: message }));
        marks.push(putSetting(db, "alert_delivery", { ...delivery, ok: false, error: message, lastErrorAt: now }));
      }
    }
  }
  if (marks.length) await db.batch(marks);
  return summary;
}

// ---------- Reading (hc-web)

/** Open alerts and the last day's resolved ones, the cron's last tick and how email is doing, for the snapshot and /v1/alerts. */
export async function alertState(db, now, { resolvedSince = now - 24 * HOUR } = {}) {
  const [rows, settingRows] = await db.batch([
    db.prepare(`SELECT id, key, kind, target, summary, detail_json, opened_at, updated_at, resolved_at, notified_at FROM alerts
      WHERE resolved_at IS NULL OR resolved_at >= ? ORDER BY opened_at DESC LIMIT 100`).bind(resolvedSince),
    db.prepare("SELECT key, value_json FROM settings WHERE key IN ('cron_last_tick', 'alert_delivery')"),
  ]);
  const settings = Object.fromEntries(settingRows.results.map((row) => [row.key, parse(row.value_json, null)]));
  const view = (row) => ({
    id: row.id, kind: row.kind, target: row.target, summary: row.summary, detail: parse(row.detail_json, {}),
    openedAt: new Date(row.opened_at).toISOString(), ...(row.resolved_at ? { resolvedAt: new Date(row.resolved_at).toISOString() } : {}),
    emailed: row.notified_at !== null,
  });
  const lastTick = typeof settings.cron_last_tick === "number" ? settings.cron_last_tick : null;
  const delivery = settings.alert_delivery ?? null;
  return {
    open: rows.results.filter((row) => row.resolved_at === null).map(view),
    resolved: rows.results.filter((row) => row.resolved_at !== null).map(view),
    cron: { lastTickAt: lastTick === null ? null : new Date(lastTick).toISOString(), stale: lastTick === null || now - lastTick > CRON_STALE_MS },
    email: delivery ? {
      ok: delivery.ok !== false,
      ...(delivery.error && delivery.ok === false ? { error: delivery.error } : {}),
      lastSentAt: delivery.lastSentAt ? new Date(delivery.lastSentAt).toISOString() : null,
    } : { ok: null, lastSentAt: null },
  };
}

/** POST /v1/alerts/test: an alert that the next cron minute emails and then resolves. */
export function testAlertStatements(db, { now, actor }) {
  const id = newId("a", now);
  return {
    id,
    statements: [
      db.prepare(`INSERT INTO alerts (id, key, kind, target, summary, detail_json, opened_at, updated_at)
        VALUES (?1, ?2, 'test', NULL, ?3, ?4, ?5, ?5)`)
        .bind(id, `test:${id}`, `Test alert requested by ${actor}`, JSON.stringify({ requestedBy: actor }), now),
    ],
  };
}

// Slot maths (UTC only) and when a job is due: the local controller's rules,
// and `materialise`, the hosted control plane's pure decision of which runs a
// job's schedule creates now (§3.2 of docs/hosted-control-plane.md).

import { parseDuration } from "./job.mjs";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function epoch(time) {
  return time instanceof Date ? time.getTime() : time;
}

/** The slot times of an `at` schedule on the UTC day that starts at `dayStart`. */
function slotsOn(at, dayStart) {
  const hours = at.hours ?? Array.from({ length: 24 }, (_, hour) => hour);
  const minutes = at.minutes ?? [0];
  return hours.flatMap((hour) => minutes.map((minute) => dayStart + hour * HOUR + minute * MINUTE))
    .sort((a, b) => a - b);
}

function utcDayStart(time) {
  return Math.floor(time / DAY) * DAY;
}

/** The latest slot at or before `now` (a Date or epoch milliseconds), as epoch milliseconds. */
export function previousSlot(at, now) {
  const time = epoch(now);
  const today = utcDayStart(time);
  const earlier = slotsOn(at, today).filter((slot) => slot <= time);
  return earlier.length ? earlier.at(-1) : slotsOn(at, today - DAY).at(-1);
}

/** The first slot after `time` (epoch milliseconds), as epoch milliseconds. */
export function nextSlot(at, time) {
  const today = utcDayStart(time);
  return slotsOn(at, today).find((slot) => slot > time) ?? slotsOn(at, today + DAY)[0];
}

// ---------- The local controller (state.json records)

export function isDue(job, record, now) {
  if (job.enabled === false || record?.paused === true) return false;
  if (job.schedule.at) {
    // Due once per slot: a slot that passed while the controller was down runs
    // once on its return, never once per missed slot.
    if (!record?.lastSubmittedAt) return true;
    return new Date(record.lastSubmittedAt).getTime() < previousSlot(job.schedule.at, now);
  }
  const anchor = record?.lastFinishedAt ?? record?.lastSubmittedAt;
  if (!anchor) return true;
  return now.getTime() - new Date(anchor).getTime() >= parseDuration(job.schedule.every);
}

/** When the job will next be submitted, or null while it is paused or running. */
export function nextDueAt(job, record, now) {
  if (job.enabled === false || record?.paused === true || record?.activeJobId) return null;
  if (isDue(job, record, now)) return now.toISOString();
  if (job.schedule.at) return new Date(nextSlot(job.schedule.at, now.getTime())).toISOString();
  const anchor = new Date(record.lastFinishedAt ?? record.lastSubmittedAt).getTime();
  return new Date(anchor + parseDuration(job.schedule.every)).toISOString();
}

// ---------- The hosted control plane

function maxOf(...values) {
  const present = values.filter((value) => value !== null && value !== undefined);
  return present.length ? Math.max(...present) : null;
}

/** Whether a due run (or a slot) at `dueAt` is past the job's lateness limit under `catchUp: none`. */
function tooLate(job, dueAt, now) {
  const seconds = job.timeouts?.maxLatenessSeconds;
  return job.policy?.catchUp === "none" && seconds !== null && seconds !== undefined && now - dueAt > seconds * 1000;
}

/**
 * The slot an `every` job is at, if one has come: the interval counts from
 * the later of its last completion and its last slot (a slot that was
 * skipped or lost counts as an attempt, so it is not retried at once). A job
 * that never ran is due at once, on the current minute so that a second call
 * in the same minute names the same slot. After a long gap the slot is the
 * latest whole interval, never a backlog.
 */
function intervalSlot(every, state, now) {
  const interval = parseDuration(every);
  const anchor = maxOf(state.lastFinishedAt, state.lastSlotAt);
  if (anchor === null) return { slot: Math.floor(now / MINUTE) * MINUTE, interval };
  if (now < anchor + interval) return { slot: null, next: anchor + interval, interval };
  return { slot: anchor + Math.floor((now - anchor) / interval) * interval, interval };
}

/**
 * What a job's schedule creates now. Pure: the caller reads the state and
 * applies the answer, and applying it twice changes nothing more, because a
 * slot is unique per job (`UNIQUE(job_id, slot_at)`).
 *
 * - `job`: a normalised definition plus `paused`.
 * - `state`: `{lastSlotAt, lastFinishedAt, due, active}`, where `due` is the
 *   job's waiting run `{id, dueAt}` and `active` its claimed-or-later run.
 * - `options.globalPause`: the operator's pause-all.
 *
 * Returns `{slots, expire, lastSlotAt, nextDueAt}`: at most one new slot (a
 * run to insert as `due` or as `skipped` with its reason), the ids of due
 * runs to mark `skipped(expired)`, the newest slot now accounted for, and
 * when this job should next be looked at (null: when its run finishes).
 *
 * Disabled jobs record nothing. Paused jobs, and every job under the global
 * pause, record their slots as `skipped(paused-at-slot)`. Either way the
 * newest slot advances, so resuming never replays old slots. Missed slots
 * collapse into the newest one: after downtime a job runs once.
 */
export function materialise(job, state = {}, now, { globalPause = false } = {}) {
  const time = epoch(now);
  const result = { slots: [], expire: [], lastSlotAt: state.lastSlotAt ?? null, nextDueAt: null };
  let due = state.due ?? null;
  if (due && tooLate(job, due.dueAt, time)) {
    result.expire.push(due.id);
    due = null;
  }
  const schedule = job.schedule;
  if (!schedule) return result;

  let slot = null;
  if (schedule.at) {
    const latest = previousSlot(schedule.at, time);
    if (result.lastSlotAt === null || latest > result.lastSlotAt) slot = latest;
    result.nextDueAt = nextSlot(schedule.at, time);
  } else {
    // An interval counts from completion: nothing more is due while a run waits or runs.
    if (due || state.active) return result;
    const found = intervalSlot(schedule.every, state, time);
    slot = found.slot;
    result.nextDueAt = slot === null ? found.next : slot + found.interval;
  }
  if (slot === null) return result;

  result.lastSlotAt = slot;
  if (job.enabled === false) return result;
  let entry;
  if (job.paused || globalPause) entry = { state: "skipped", skipReason: "paused-at-slot" };
  else if (tooLate(job, slot, time)) entry = { state: "skipped", skipReason: "expired" };
  else if (due) entry = { state: "skipped", skipReason: "coalesced" };
  else if (state.active && job.policy?.overlap === "skip") entry = { state: "skipped", skipReason: "overlap" };
  else entry = { state: "due", skipReason: null };

  const prefer = job.placement?.preferMachines?.length ? (job.placement.preferWaitSeconds ?? 300) * 1000 : null;
  result.slots.push({
    slotAt: slot,
    dueAt: slot,
    ...entry,
    preferredUntil: entry.state === "due" && prefer !== null ? slot + prefer : null,
  });
  // A due interval run is the next thing to happen; its completion sets the time after.
  if (schedule.every && entry.state === "due") result.nextDueAt = null;
  return result;
}

/**
 * When a job will next run, for people: null while it is disabled, paused,
 * under the global pause, or already waiting or running.
 */
export function upcomingAt(job, state = {}, now, { globalPause = false } = {}) {
  const time = epoch(now);
  if (!job.schedule || job.enabled === false || job.paused || globalPause || state.due || state.active) return null;
  if (job.schedule.at) {
    return nextSlot(job.schedule.at, maxOf(time, state.lastSlotAt) ?? time);
  }
  const found = intervalSlot(job.schedule.every, state, time);
  return found.slot === null ? found.next : time;
}

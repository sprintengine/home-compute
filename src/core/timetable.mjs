// A timetable change, `{enabled?, hours?: [H…] | "every", minutes?: [M…]}`:
// the body the dashboard and the menu bar app send, checked here once for
// the local controller's command and the hosted API alike.

import { HttpError } from "./errors.mjs";
import { JOB_ID } from "./job.mjs";

const KEYS = new Set(["enabled", "hours", "minutes"]);

function wholeNumbers(values, maximum, name) {
  if (!Array.isArray(values) || values.length === 0 || values.length > maximum + 1
    || values.some((value) => !Number.isInteger(value) || value < 0 || value > maximum)) {
    throw new HttpError(400, `${name} must be a non-empty list of whole numbers from 0 to ${maximum}`);
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * The change, checked and normalised (hours and minutes sorted, without
 * repeats), for `job` (anything with an `id` and a `schedule`). Hours and
 * minutes only apply to a job that runs at set times.
 */
export function timetableChange(job, changes) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    throw new HttpError(400, "The change must be an object");
  }
  const unknown = Object.keys(changes).filter((key) => !KEYS.has(key));
  if (unknown.length) throw new HttpError(400, `Unknown timetable field ${unknown.join(", ")}`);
  if (!JOB_ID.test(job.id)) throw new HttpError(400, "Invalid job id");
  const change = {};
  if (changes.enabled !== undefined) {
    if (typeof changes.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
    change.enabled = changes.enabled;
  }
  if ((changes.hours !== undefined || changes.minutes !== undefined) && !job.schedule?.at) {
    throw new HttpError(400, `${job.id} runs on an interval, not at set times`);
  }
  if (changes.hours !== undefined) {
    change.hours = changes.hours === "every" ? "every" : wholeNumbers(changes.hours, 23, "hours");
  }
  if (changes.minutes !== undefined) change.minutes = wholeNumbers(changes.minutes, 59, "minutes");
  if (!Object.keys(change).length) throw new HttpError(400, "Nothing to change");
  return change;
}

/** A schedule with a checked change applied: `hours: "every"` drops the hours, so it runs every hour. */
export function applyTimetable(schedule, change) {
  if (!schedule?.at || (change.hours === undefined && change.minutes === undefined)) return schedule;
  const at = { ...schedule.at };
  if (change.hours === "every") delete at.hours;
  else if (change.hours !== undefined) at.hours = change.hours;
  if (change.minutes !== undefined) at.minutes = change.minutes;
  return { ...schedule, at };
}

import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { HttpError } from "./errors.mjs";

const execFile = promisify(execFileCallback);
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const KEYS = new Set(["enabled", "hours", "minutes"]);

function wholeNumbers(values, maximum, name) {
  if (!Array.isArray(values) || values.length === 0 || values.length > maximum + 1
    || values.some((value) => !Number.isInteger(value) || value < 0 || value > maximum)) {
    throw new HttpError(400, `${name} must be a non-empty list of whole numbers from 0 to ${maximum}`);
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * The arguments that describe one job's timetable change, after the change
 * is checked: `JOB [--enabled true|false] [--hours every|H,H] [--minutes M,M]`.
 * Every argument is built from a validated boolean or number, never from the
 * request's text, and the command runs without a shell.
 */
export function timetableArguments(job, changes) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    throw new HttpError(400, "The change must be an object");
  }
  const unknown = Object.keys(changes).filter((key) => !KEYS.has(key));
  if (unknown.length) throw new HttpError(400, `Unknown timetable field ${unknown.join(", ")}`);
  if (!ID.test(job.id)) throw new HttpError(400, "Invalid job id");
  const args = [job.id];
  if (changes.enabled !== undefined) {
    if (typeof changes.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
    args.push("--enabled", String(changes.enabled));
  }
  if ((changes.hours !== undefined || changes.minutes !== undefined) && !job.schedule?.at) {
    throw new HttpError(400, `${job.id} runs on an interval, not at set times`);
  }
  if (changes.hours !== undefined) {
    args.push("--hours", changes.hours === "every" ? "every" : wholeNumbers(changes.hours, 23, "hours").join(","));
  }
  if (changes.minutes !== undefined) {
    args.push("--minutes", wholeNumbers(changes.minutes, 59, "minutes").join(","));
  }
  if (args.length === 1) throw new HttpError(400, "Nothing to change");
  return args;
}

/** The configured command, its program resolved against the configuration's directory. */
export function resolveTimetableCommand(config) {
  const command = config.timetable?.command;
  if (!command) return undefined;
  const directory = path.dirname(config.filename ?? path.resolve("home-compute.json"));
  const [program, ...rest] = command;
  return { file: path.resolve(directory, program), args: rest, cwd: directory };
}

function lastJsonObject(text) {
  for (const line of String(text ?? "").trim().split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value = JSON.parse(trimmed);
      if (value && typeof value === "object") return value;
    } catch {
      // Not the answer line.
    }
  }
  return undefined;
}

/**
 * Runs the project's timetable command with `args`. It succeeds when it exits
 * 0 and its last JSON line, if any, does not say `"ok": false`.
 */
export async function runTimetableCommand(command, args, { timeoutMs = 120_000, execute = execFile } = {}) {
  try {
    const { stdout } = await execute(command.file, [...command.args, ...args], {
      cwd: command.cwd,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env: process.env,
    });
    const answer = lastJsonObject(stdout);
    if (answer?.ok === false) throw new HttpError(422, answer.error ?? "The timetable command refused the change");
    return answer ?? {};
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const answer = lastJsonObject(error.stdout);
    if (answer?.error) throw new HttpError(422, answer.error);
    const detail = String(error.stderr ?? "").trim().split(/\r?\n/).at(-1);
    if (error.killed) throw new HttpError(504, "The timetable command timed out");
    throw new HttpError(500, `The timetable command failed: ${detail || error.message}`);
  }
}

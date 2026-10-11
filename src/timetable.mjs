import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { HttpError } from "./errors.mjs";
import { timetableChange } from "./core/timetable.mjs";

const execFile = promisify(execFileCallback);

/**
 * The arguments that describe one job's timetable change, after the change
 * is checked: `JOB [--enabled true|false] [--hours every|H,H] [--minutes M,M]`.
 * Every argument is built from a validated boolean or number, never from the
 * request's text, and the command runs without a shell.
 */
export function timetableArguments(job, changes) {
  const change = timetableChange(job, changes);
  const args = [job.id];
  if (change.enabled !== undefined) args.push("--enabled", String(change.enabled));
  if (change.hours !== undefined) args.push("--hours", change.hours === "every" ? "every" : change.hours.join(","));
  if (change.minutes !== undefined) args.push("--minutes", change.minutes.join(","));
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

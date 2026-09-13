import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildJobSpec } from "./bacalhau.mjs";
import { parseDuration } from "./config.mjs";

export async function readState(filename) {
  try {
    const value = JSON.parse(await readFile(filename, "utf8"));
    return { version: 1, jobs: {}, ...value };
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, jobs: {} };
    throw error;
  }
}

export async function writeState(filename, state) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filename);
}

export function isDue(job, record, now) {
  if (job.enabled === false || record?.paused === true) return false;
  const anchor = record?.lastFinishedAt ?? record?.lastSubmittedAt;
  if (!anchor) return true;
  return now.getTime() - new Date(anchor).getTime() >= parseDuration(job.schedule.every);
}

export async function reconcile({ config, client, environment, stateFile, now = new Date(), logger = console }) {
  const state = await readState(stateFile);
  const events = [];
  for (const job of config.jobs) {
    const record = (state.jobs[job.id] ??= {});
    if (record.activeJobId) {
      try {
        const status = await client.describe(record.activeJobId);
        record.lastObservedState = status.state;
        record.lastObservedAt = now.toISOString();
        if (status.terminal) {
          record.lastFinishedJobId = record.activeJobId;
          record.lastFinishedState = status.state;
          record.lastFinishedAt = now.toISOString();
          record.activeJobId = undefined;
          events.push({ event: "job_finished", job: job.id, bacalhauJobId: record.lastFinishedJobId, state: status.state });
        }
      } catch (error) {
        events.push({ event: "status_error", job: job.id, bacalhauJobId: record.activeJobId, error: error.message });
        logger.error(JSON.stringify(events.at(-1)));
        continue;
      }
    }
    if (record.activeJobId || !isDue(job, record, now)) continue;
    try {
      const spec = buildJobSpec(job, environment);
      const bacalhauJobId = await client.submit(spec);
      record.activeJobId = bacalhauJobId;
      record.lastSubmittedAt = now.toISOString();
      record.lastObservedState = "Submitted";
      const event = { event: "job_submitted", job: job.id, bacalhauJobId };
      events.push(event);
      logger.log(JSON.stringify(event));
    } catch (error) {
      record.lastSubmissionError = error.message;
      record.lastSubmissionErrorAt = now.toISOString();
      const event = { event: "submission_error", job: job.id, error: error.message };
      events.push(event);
      logger.error(JSON.stringify(event));
    }
  }
  state.updatedAt = now.toISOString();
  await writeState(stateFile, state);
  return { state, events };
}

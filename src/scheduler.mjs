import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildJobSpec } from "./bacalhau.mjs";
import { isDue, nextDueAt, nextSlot, previousSlot } from "./core/schedule.mjs";
import { outcomeOf, parseReports, publishedEntries, reportedError, trackPublished } from "./core/reports.mjs";
import { redactValue } from "./redact.mjs";

// The slot maths and report parsing live in src/core so the hosted control plane shares them.
export { isDue, nextDueAt, nextSlot, parseReports, previousSlot };

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

/**
 * Record a run that has reached a terminal state: its exit code, its outcome
 * and, for a job that reports in JSON lines, what it said. `published` keeps
 * the latest tracked event per key across runs, so a run that found nothing new
 * does not hide when something last was.
 */
export async function recordFinished({ job, record, status, client, now }) {
  const report = job.task.report;
  let reports = [];
  if (report?.format === "json-lines") {
    let text = `${status.stdout ?? ""}\n${status.stderr ?? ""}`;
    if (status.truncated && client.logs) {
      try {
        text = await client.logs(record.activeJobId);
      } catch {
        // Keep the truncated copy; a partial report beats none.
      }
    }
    reports = parseReports(text);
  }
  const failedExit = status.exitCode !== undefined && status.exitCode !== 0;
  const state = status.state === "Completed" && failedExit ? "Failed" : status.state;
  const outcome = outcomeOf(status.state, status.exitCode, reports, report);
  Object.assign(record, {
    lastFinishedJobId: record.activeJobId,
    lastFinishedState: state,
    lastFinishedAt: now.toISOString(),
    lastExitCode: status.exitCode ?? null,
    lastOutcome: outcome,
    lastError: outcome === "failed"
      ? (reportedError(reports) ?? status.errorMessage
        ?? (failedExit ? `exited with ${status.exitCode}` : `ended ${status.state}`))
      : undefined,
    activeJobId: undefined,
  });
  if (report?.format === "json-lines") record.lastReports = reports;
  if (report?.trackEvent) {
    record.published = trackPublished(record.published, reports, report, { fallbackKey: job.id, at: now.toISOString() });
  }
  return {
    event: "job_finished",
    job: job.id,
    bacalhauJobId: record.lastFinishedJobId,
    state,
    exitCode: record.lastExitCode,
    outcome,
    reports,
  };
}

const FAILURE_DETAIL_LINES = 40;

/** Runs a history write, logging rather than throwing: history never stops scheduling. */
async function keepHistory(logger, job, operation) {
  try {
    await operation();
  } catch (error) {
    logger.error(JSON.stringify({ event: "history_error", job, error: error.message }));
  }
}

/** The end of a failed run's own output, redacted, for the run's history. */
function failureDetail(status, redact) {
  const lines = [];
  if (status.errorMessage) lines.push(status.errorMessage);
  const output = String(status.stderr ?? "").trim() || String(status.stdout ?? "").trim();
  if (output) lines.push(...output.split(/\r?\n/).slice(-FAILURE_DETAIL_LINES));
  return lines.length ? redact(lines.join("\n")) : undefined;
}

/** Notes a submission in the job's history. */
export async function recordSubmitted({ history, job, bacalhauJobId, submittedAt, source, parameters, logger = console }) {
  if (!history) return;
  await keepHistory(logger, job.id, () => history.record(job.id, bacalhauJobId, {
    source,
    submittedAt,
    state: "Submitted",
    ...(parameters?.length ? { parameters } : {}),
  }));
}

/** Notes what a run still going looks like now: queued, or running since when. */
async function recordProgress({ history, job, record, status, now, logger }) {
  if (!history) return;
  await keepHistory(logger, job.id, async () => {
    const known = await history.find(job.id, record.activeJobId);
    const startedAt = status.timing?.startedAt
      ?? known?.startedAt
      ?? (/^running$/i.test(status.state) ? now.toISOString() : undefined);
    await history.record(job.id, record.activeJobId, {
      state: status.state,
      submittedAt: known?.submittedAt ?? status.timing?.submittedAt ?? record.lastSubmittedAt,
      ...(startedAt ? { startedAt } : {}),
    });
  });
}

/**
 * Records a run that reached a terminal state, as `recordFinished` does, and
 * keeps it in the job's history with its timing, reports and, when it failed,
 * the end of its output. Everything kept is passed through `redact`.
 */
export async function settleRun({ job, record, status, client, now, history, redact = (text) => text, logger = console }) {
  const submittedAt = record.lastSubmittedAt;
  const event = await recordFinished({ job, record, status, client, now });
  if (history) {
    await keepHistory(logger, job.id, async () => {
      const known = await history.find(job.id, event.bacalhauJobId);
      const published = publishedEntries(event.reports, job.task.report, job.id);
      await history.record(job.id, event.bacalhauJobId, {
        submittedAt: known?.submittedAt ?? status.timing?.submittedAt ?? submittedAt,
        startedAt: status.timing?.startedAt ?? known?.startedAt,
        finishedAt: status.timing?.finishedAt ?? record.lastFinishedAt,
        state: event.state,
        outcome: event.outcome,
        exitCode: event.exitCode ?? undefined,
        ...(event.outcome === "failed" ? {
          error: record.lastError ? redact(record.lastError) : undefined,
          failureDetail: failureDetail(status, redact),
        } : {}),
        ...(job.task.report?.format === "json-lines" ? { reports: redactValue(event.reports, redact) } : {}),
        ...(published.length ? { published } : {}),
      });
    });
  }
  return event;
}

export async function reconcile({
  config, client, environment, stateFile, now = new Date(), logger = console, history, redact = (text) => text,
}) {
  const state = await readState(stateFile);
  const events = [];
  for (const job of config.jobs) {
    const record = (state.jobs[job.id] ??= {});
    if (history) await keepHistory(logger, job.id, () => history.seed(job.id, record));
    if (record.activeJobId) {
      try {
        const status = await client.describe(record.activeJobId);
        record.lastObservedState = status.state;
        record.lastObservedAt = now.toISOString();
        if (status.terminal) {
          const event = await settleRun({ job, record, status, client, now, history, redact, logger });
          events.push(event);
          logger.log(JSON.stringify({ ...event, reports: event.reports.length }));
        } else {
          await recordProgress({ history, job, record, status, now, logger });
        }
      } catch (error) {
        events.push({ event: "status_error", job: job.id, bacalhauJobId: record.activeJobId, error: error.message });
        logger.error(JSON.stringify(events.at(-1)));
        continue;
      }
    }
    if (record.activeJobId || !isDue(job, record, now)) continue;
    try {
      const spec = buildJobSpec(job, environment, { now });
      const bacalhauJobId = await client.submit(spec);
      record.activeJobId = bacalhauJobId;
      record.lastSubmittedAt = now.toISOString();
      record.lastObservedState = "Submitted";
      record.lastSubmissionError = undefined;
      record.lastSubmissionErrorAt = undefined;
      await recordSubmitted({ history, job, bacalhauJobId, submittedAt: record.lastSubmittedAt, source: "schedule", logger });
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

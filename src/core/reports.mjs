// What a workload says about itself in JSON lines, and what that makes of a
// run: its outcome and, for a job that tracks an event, what it published.
// The agent parses; the controller (local or hosted) settles.

/** Every line of a workload's output that is a JSON object naming an `event`. */
export function parseReports(text) {
  const reports = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value = JSON.parse(trimmed);
      if (value && typeof value.event === "string") reports.push(value);
    } catch {
      // Not every brace-led line is a report.
    }
  }
  return reports.slice(-50);
}

function reportedOutcome(reports, report) {
  if (report?.trackEvent && reports.some((entry) => entry.event === report.trackEvent)) return "published";
  if (reports.length && reports.every((entry) => entry.event.endsWith("_unchanged"))) return "unchanged";
  return "completed";
}

function reportedFailure(reports) {
  return reports.some((entry) => entry.event.endsWith("_failed"));
}

/**
 * The local controller's outcome of a Bacalhau run: `failed` unless it
 * Completed with exit 0 and no `*_failed` report; then `published` when the
 * tracked event was reported, `unchanged` when every report said so, else
 * `completed`.
 */
export function outcomeOf(state, exitCode, reports, report) {
  if (state !== "Completed" || (exitCode !== undefined && exitCode !== 0) || reportedFailure(reports)) return "failed";
  return reportedOutcome(reports, report);
}

/**
 * The same outcome for a hosted run, from what the agent observed: a
 * timeout, an OOM kill, a non-zero exit or a `*_failed` report is `failed`.
 */
export function runOutcome({ exitCode, oomKilled = false, timedOut = false, reports = [], report } = {}) {
  if (timedOut || oomKilled || (exitCode !== undefined && exitCode !== null && exitCode !== 0) || reportedFailure(reports)) {
    return "failed";
  }
  return reportedOutcome(reports, report);
}

/** The error a failed run's reports give, the newest first. */
export function reportedError(reports) {
  return reports.findLast((entry) => entry.error)?.error;
}

/**
 * `published` after a run: the latest tracked event per `trackBy` value,
 * kept across runs so a run that found nothing new does not hide when
 * something last was. `fallbackKey` (the job id) names a report without the
 * key; `runId`, when given, links each entry to the run that published it.
 */
export function trackPublished(published, reports, report, { fallbackKey, at, runId } = {}) {
  if (!report?.trackEvent) return published;
  const key = report.trackBy ?? "key";
  const next = { ...(published ?? {}) };
  for (const entry of reports.filter((candidate) => candidate.event === report.trackEvent)) {
    next[entry[key] ?? fallbackKey] = {
      run: entry.run ?? null,
      at: entry.time ?? at,
      seconds: entry.seconds ?? null,
      ...(runId ? { runId } : {}),
    };
  }
  return next;
}

/** The tracked events of one run, as its history lists them: `[{key, run, status?}]`. */
export function publishedEntries(reports, report, fallbackKey) {
  if (!report?.trackEvent) return [];
  const trackBy = report.trackBy ?? "key";
  return reports.filter((entry) => entry.event === report.trackEvent)
    .map((entry) => ({ key: String(entry[trackBy] ?? fallbackKey), run: entry.run ?? null, ...(entry.status ? { status: entry.status } : {}) }));
}

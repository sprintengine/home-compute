// Run records: derived durations, metrics from reports, bounded report lists.
// Pure, so the controller's history files and the hosted run table share them.

const MAX_REPORT_BYTES = 32 * 1024;
const MAX_DETAIL_CHARS = 4_000;

function seconds(from, to) {
  const start = Date.parse(from ?? "");
  const end = Date.parse(to ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return Math.round((end - start) / 100) / 10;
}

/**
 * The numbers a run's reports gave, one value per top-level numeric field:
 * the largest for a `peak…`/`max…` field (a high-water mark), else the sum
 * over the run's reports (a run that imports two models took both times).
 * Nothing is named here, so a field a workload starts reporting appears as is.
 */
export function reportMetrics(reports = []) {
  const metrics = {};
  for (const report of reports) {
    for (const [name, value] of Object.entries(report ?? {})) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      if (!(name in metrics)) metrics[name] = value;
      else if (/^(peak|max)/i.test(name)) metrics[name] = Math.max(metrics[name], value);
      else metrics[name] = Math.round((metrics[name] + value) * 1000) / 1000;
    }
  }
  return metrics;
}

/** The reports, whole, while they fit; the newest that fit otherwise. */
export function boundedReports(reports) {
  const kept = [];
  let size = 0;
  for (const report of [...reports].reverse()) {
    const bytes = JSON.stringify(report).length;
    if (size + bytes > MAX_REPORT_BYTES) break;
    kept.unshift(report);
    size += bytes;
  }
  return kept;
}

/** Fills in a run's derived fields: its durations, and its metrics from its reports. */
export function completeRun(run) {
  const finished = { ...run };
  const queue = seconds(run.submittedAt, run.startedAt);
  const duration = run.finishedAt ? seconds(run.startedAt ?? run.submittedAt, run.finishedAt) : undefined;
  if (queue !== undefined) finished.queueSeconds = queue;
  if (duration !== undefined) finished.durationSeconds = duration;
  if (Array.isArray(run.reports)) {
    finished.reports = boundedReports(run.reports);
    finished.metrics = reportMetrics(finished.reports);
  }
  if (typeof finished.failureDetail === "string" && finished.failureDetail.length > MAX_DETAIL_CHARS) {
    finished.failureDetail = finished.failureDetail.slice(-MAX_DETAIL_CHARS);
  }
  return Object.fromEntries(Object.entries(finished).filter(([, value]) => value !== undefined));
}

/** A run without its reports, for lists. */
export function summarizeRun(run) {
  const { reports, ...summary } = run;
  return summary;
}

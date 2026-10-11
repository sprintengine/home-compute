import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
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
function boundedReports(reports) {
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

/**
 * The last `keep` runs of each job, newest first, one JSON file per job next
 * to the controller's state. Runs are keyed by their Bacalhau job id. Every
 * change is written through at once (atomically, as the state is) and the
 * files are only ever read at first use, so reads cost nothing.
 */
export class HistoryStore {
  constructor(directory, { keep = 50 } = {}) {
    this.directory = directory;
    this.keep = keep;
    this.cache = new Map();
    this.writes = Promise.resolve();
  }

  filename(job) {
    if (!ID.test(job)) throw new Error(`Invalid job id ${JSON.stringify(job)}`);
    return path.join(this.directory, `${job}.json`);
  }

  async load(job) {
    if (this.cache.has(job)) return this.cache.get(job);
    let runs = [];
    try {
      const value = JSON.parse(await readFile(this.filename(job), "utf8"));
      if (Array.isArray(value?.runs)) runs = value.runs.filter((run) => run && typeof run.id === "string");
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    this.cache.set(job, runs);
    return runs;
  }

  async save(job) {
    const runs = this.cache.get(job) ?? [];
    const filename = this.filename(job);
    const write = async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${filename}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ version: 1, job, runs }, null, 1)}\n`, { mode: 0o600 });
      await rename(temporary, filename);
    };
    this.writes = this.writes.then(write, write);
    return this.writes;
  }

  /** Newest first. */
  async runs(job, { limit = this.keep } = {}) {
    return (await this.load(job)).slice(0, limit);
  }

  async find(job, id) {
    return (await this.load(job)).find((run) => run.id === id);
  }

  /** The job a Bacalhau job id belongs to, among `jobs`. */
  async locate(id, jobs) {
    for (const job of jobs) {
      const run = await this.find(job, id);
      if (run) return { job, run };
    }
    return undefined;
  }

  /** Creates or updates the run `id` of `job` with `fields`. */
  async record(job, id, fields) {
    const runs = await this.load(job);
    const index = runs.findIndex((run) => run.id === id);
    const current = index >= 0 ? runs[index] : { id, job };
    const next = completeRun({ ...current, ...fields, id, job });
    if (index >= 0 && JSON.stringify(next) === JSON.stringify(current)) return current;
    if (index >= 0) runs[index] = next;
    else runs.unshift(next);
    runs.sort((a, b) => (Date.parse(b.submittedAt ?? "") || 0) - (Date.parse(a.submittedAt ?? "") || 0));
    runs.splice(this.keep);
    await this.save(job);
    return next;
  }

  /**
   * A job's first history, from what its state record says of its last run,
   * so a controller that kept no history yet still shows the run it knows.
   */
  async seed(job, record) {
    const runs = await this.load(job);
    if (runs.length || !record?.lastFinishedJobId) return;
    // Once a newer run is submitted, lastSubmittedAt is that run's, not this one's.
    const submittedFirst = Date.parse(record.lastSubmittedAt ?? "") <= Date.parse(record.lastFinishedAt ?? "");
    await this.record(job, record.lastFinishedJobId, {
      source: "state",
      submittedAt: submittedFirst ? record.lastSubmittedAt : undefined,
      finishedAt: record.lastFinishedAt,
      state: record.lastFinishedState,
      outcome: record.lastOutcome,
      exitCode: record.lastExitCode ?? undefined,
      error: record.lastError,
      reports: record.lastReports,
    });
  }
}

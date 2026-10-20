// The agent's local run history: one JSON line per finished run, and one
// more when the control plane has taken its result, in `history.jsonl` in
// the state directory (0600). The status server, `home-compute-agent
// history` and the menu bar and tray apps read it; nothing else does, and
// the control plane keeps the real history. A line holds what a person
// needs at a glance (job, times, outcome, exit code, error, the model run a
// job published) and never a secret: no spec, no env, no log tail, and the
// error text is redacted again as it is written. The file rotates once it
// passes `maxBytes`: it becomes `history.jsonl.1` (replacing the previous
// one) and a new file starts, so the history holds about the last
// 2 × `maxBytes` of runs.

import { open, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { createRedactor } from "../../src/core/redact.mjs";
import { publishedEntries, runOutcome } from "../../src/core/reports.mjs";

export const HISTORY_FILE = "history.jsonl";
export const HISTORY_MAX_BYTES = 512 * 1024;
export const HISTORY_VERSION = 1;
const MAX_ERROR_CHARS = 1000;
const MAX_DETAIL_CHARS = 4096;
const MAX_TEXT_CHARS = 300;
const MAX_PUBLISHED = 20;
/** Outcomes that count as passed (✓); `failed` is ✗; `cancelled` is neither. */
export const PASSED = new Set(["published", "unchanged", "completed"]);

const patterns = createRedactor([]);

function clip(text, max) {
  if (text === null || text === undefined) return null;
  const value = String(text);
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function iso(time) {
  return typeof time === "number" && Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * A run's outcome as the history shows it: `cancelled`, `failed`, or what
 * its reports make of it (`published`, `unchanged`, `completed`). A run that
 * failed before its container started (a refused image, a failed pull) has
 * no exit code and is `failed`.
 */
export function historyOutcome(record, report) {
  if (record.cancelled) return "cancelled";
  if (record.failed || (record.error && (record.exitCode === null || record.exitCode === undefined))) return "failed";
  return runOutcome({ exitCode: record.exitCode, oomKilled: record.oomKilled, timedOut: record.timedOut, reports: record.reports ?? [], report });
}

/**
 * The history line for a finished run, from its claim, its final record and
 * the times the supervisor kept. `redact` is the run's own redactor (its
 * secret values); the credential patterns apply as well, so an error
 * message cannot carry a token into the file.
 */
export function historyEntry({ claim, record, claimedAt, startedAt, finishedAt, redact = (text) => text }) {
  const clean = (text, max) => (text === null || text === undefined ? null : clip(patterns(redact(String(text))), max));
  const run = claim?.run ?? {};
  const spec = claim?.spec ?? {};
  const outcome = historyOutcome(record, spec.report);
  const published = publishedEntries(record.reports ?? [], spec.report, run.jobId)
    .slice(-MAX_PUBLISHED)
    .map((entry) => ({ key: clean(entry.key, MAX_TEXT_CHARS), run: clean(entry.run, MAX_TEXT_CHARS), ...(entry.status ? { status: clean(entry.status, 40) } : {}) }));
  return {
    v: HISTORY_VERSION,
    type: "run",
    run: String(run.id),
    job: clean(run.jobId, MAX_TEXT_CHARS),
    attempt: number(run.attempt),
    source: clean(run.source, 40),
    image: clean(record.image?.ref ?? spec.image, MAX_TEXT_CHARS),
    digest: clean(record.image?.digest, 100),
    claimedAt: iso(claimedAt),
    startedAt: iso(startedAt),
    finishedAt: iso(finishedAt),
    outcome,
    exitCode: number(record.exitCode),
    oomKilled: Boolean(record.oomKilled),
    timedOut: Boolean(record.timedOut),
    cancelled: Boolean(record.cancelled),
    error: outcome === "failed" ? clean(record.error, MAX_ERROR_CHARS) : null,
    errorDetail: outcome === "failed" ? clean(record.errorDetail, MAX_DETAIL_CHARS) : null,
    durationMs: number(record.durations?.durationMs),
    pullMs: number(record.durations?.pullMs),
    vmWaitMs: number(record.durations?.vmWaitMs),
    peakMemoryBytes: number(record.stats?.peakMemoryBytes),
    memoryLimitBytes: number(record.stats?.memoryLimitBytes),
    avgCpuPct: number(record.stats?.avgCpuPct),
    cpuSeconds: number(record.stats?.cpuSeconds),
    published,
  };
}

/** The line that says the control plane took (or refused) a run's result. */
export function reportedEntry(runId, { at, state = null, status = null }) {
  return { v: HISTORY_VERSION, type: "reported", run: String(runId), at: iso(at), state: clip(state, 40), ...(status ? { status } : {}) };
}

/**
 * Folds history lines into runs, newest finished first: a `run` line makes
 * the entry, a later `reported` line adds `reported: {at, state}`. Lines that
 * are not JSON, are of another version or type, or report a run whose `run`
 * line is gone (rotated away) are skipped. A run written twice keeps the
 * later line. Every entry gets `passed`: true (✓), false (✗) or null.
 */
export function parseHistory(text) {
  const runs = new Map();
  const reports = new Map();
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object" || entry.v !== HISTORY_VERSION || typeof entry.run !== "string") continue;
    if (entry.type === "run") {
      const reported = runs.get(entry.run)?.reported ?? reports.get(entry.run) ?? null;
      runs.delete(entry.run);
      runs.set(entry.run, { ...entry, reported });
    } else if (entry.type === "reported") {
      const value = { at: entry.at ?? null, state: entry.state ?? null, ...(entry.status ? { status: entry.status } : {}) };
      if (runs.has(entry.run)) runs.get(entry.run).reported = value;
      else reports.set(entry.run, value);
    }
  }
  const time = (entry) => Date.parse(entry.finishedAt ?? entry.startedAt ?? entry.claimedAt ?? "") || 0;
  return [...runs.values()]
    .map(({ v, type, ...entry }, index) => ({ ...entry, passed: entry.outcome === "failed" ? false : PASSED.has(entry.outcome) ? true : null, order: index }))
    .sort((a, b) => time(b) - time(a) || b.order - a.order)
    .map(({ order, ...entry }) => entry);
}

export class RunHistory {
  constructor(dir, { maxBytes = HISTORY_MAX_BYTES } = {}) {
    this.file = path.join(dir, HISTORY_FILE);
    this.previous = `${this.file}.1`;
    this.maxBytes = maxBytes;
    this.writing = Promise.resolve();
  }

  /** Appends one line (0600), rotating first when it would pass `maxBytes`. Writes are serialised. */
  append(entry) {
    const line = `${JSON.stringify(entry)}\n`;
    const write = this.writing.then(async () => {
      const size = await stat(this.file).then((info) => info.size, () => 0);
      if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) await rename(this.file, this.previous);
      const handle = await open(this.file, "a", 0o600);
      try {
        await handle.chmod(0o600);
        await handle.appendFile(line);
      } finally {
        await handle.close();
      }
    });
    this.writing = write.catch(() => {});
    return write;
  }

  async #read(file) {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return "";
      throw error;
    }
  }

  /** Every run the two files hold, newest first. */
  async all() {
    await this.writing;
    return parseHistory(`${await this.#read(this.previous)}\n${await this.#read(this.file)}`);
  }

  /** The newest `limit` runs. */
  async recent(limit = 20) {
    return (await this.all()).slice(0, Math.max(0, limit));
  }
}

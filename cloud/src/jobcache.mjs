// hc-core's job definitions, kept in isolate memory and keyed by the
// `jobs_version` setting, which every job or settings write increases (§2).
// A sync then reads one settings row instead of the whole jobs table.

import { jobFromRow } from "./db.mjs";

let cache = { version: null, jobs: null };

/** Every job by id, read again only when `version` (the `jobs_version` setting, as text) has moved. */
export async function jobsAt(db, version) {
  if (cache.jobs && cache.version === version) return cache.jobs;
  const { results } = await db.prepare("SELECT * FROM jobs").all();
  const jobs = new Map();
  for (const row of results) {
    try {
      jobs.set(row.id, jobFromRow(row));
    } catch (error) {
      console.error(JSON.stringify({ event: "job_unreadable", job: row.id, error: error.message }));
    }
  }
  cache = { version, jobs };
  return jobs;
}

/** For tests: forget what is cached. */
export function clearJobCache() {
  cache = { version: null, jobs: null };
}

/** Whether the last `jobsAt` call was answered from memory (for tests and the CPU measurements). */
export function cachedVersion() {
  return cache.version;
}

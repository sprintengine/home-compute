// Loading what pages show. Each loader keeps one request in flight per key
// and stores the answer (or the error) in `state`, then renders; views call
// the `ensure…` forms, which load only what is missing.

import { TERMINAL_PHASES, phaseOf } from "./lib.js";
import { api, hosted, render, state } from "./ui.js";

const inflight = new Map();

function once(key, task) {
  if (!inflight.has(key)) inflight.set(key, task().finally(() => inflight.delete(key)));
  return inflight.get(key);
}

export function loading(key) {
  return inflight.has(key);
}

/** The overview's data. Errors stay in `state.error` so the page shows the last good snapshot with a banner. */
export function loadSnapshot() {
  return once("snapshot", async () => {
    try {
      state.snapshot = (await api("/v1/snapshot")).data;
      state.updatedAt = Date.now();
      state.error = null;
    } catch (error) {
      if (error.status !== 401) state.error = error.message;
    }
  });
}

export function loadJob(id) {
  return once(`job:${id}`, async () => {
    try {
      state.jobs.set(id, { data: (await api(`/v1/jobs/${encodeURIComponent(id)}`)).data });
    } catch (error) {
      state.jobs.set(id, { error: error.message, status: error.status });
    }
    render();
  });
}

export function ensureJob(id) {
  if (hosted() && !state.jobs.has(id)) loadJob(id);
}

const PAGE = 30;

/**
 * A job's run history, a page at a time (newest first; skipped slots left
 * out). `more` loads the next page; otherwise the first page is loaded again
 * and replaces what is held (a live refresh).
 */
export function loadHistory(id, { more = false } = {}) {
  return once(`history:${id}:${more}`, async () => {
    const current = state.history.get(id) ?? { runs: [], next: null, done: false };
    if (more && (current.done || current.next === null)) return;
    state.history.set(id, { ...current, loading: true });
    if (more) render();
    try {
      const query = new URLSearchParams({ limit: String(PAGE), skipped: "0" });
      if (more) query.set("before", String(current.next));
      const { data } = await api(`/v1/jobs/${encodeURIComponent(id)}/runs?${query}`);
      const runs = more ? [...current.runs, ...(data.runs ?? [])] : mergeFirstPage(current.runs, data.runs ?? []);
      const next = more || !current.runs.length || current.runs.length <= PAGE ? data.next ?? null : current.next;
      state.history.set(id, { runs, next, done: next === null || next === undefined, loading: false });
    } catch (error) {
      state.history.set(id, { ...current, loading: false, error: error.message });
    }
    render();
  });
}

/** The newest page replaces its own runs and keeps older pages already scrolled to. */
function mergeFirstPage(held, page) {
  if (held.length <= page.length) return page;
  const ids = new Set(page.map((run) => run.id));
  const oldest = Date.parse(page.at(-1)?.submittedAt ?? 0);
  return [...page, ...held.filter((run) => !ids.has(run.id) && Date.parse(run.submittedAt) < oldest)];
}

export function ensureHistory(id) {
  if (!state.history.has(id)) loadHistory(id);
}

/** A run: GET /v1/runs/:id on the hosted control plane; the local controller has only its job's history. */
export function loadRun(id, jobHint) {
  return once(`run:${id}`, async () => {
    try {
      if (hosted()) {
        state.runs.set(id, { data: (await api(`/v1/runs/${encodeURIComponent(id)}`)).data });
      } else if (jobHint) {
        await loadHistory(jobHint);
        const run = state.history.get(jobHint)?.runs.find((candidate) => candidate.id === id);
        state.runs.set(id, run ? { data: run } : { error: "Not in this job's history" });
      } else {
        state.runs.set(id, { error: "Open runs from their job on the local controller" });
      }
    } catch (error) {
      state.runs.set(id, { error: error.message, status: error.status });
    }
    render();
  });
}

export function ensureRun(id, jobHint) {
  if (!state.runs.has(id)) loadRun(id, jobHint);
}

export function loadLog(id, { force = false } = {}) {
  const current = state.logs.get(id);
  if (!force && (current?.data || current?.error)) return Promise.resolve();
  return once(`log:${id}`, async () => {
    if (!current?.data) state.logs.set(id, { loading: true });
    try {
      state.logs.set(id, { data: (await api(`/v1/runs/${encodeURIComponent(id)}/logs`)).data });
    } catch (error) {
      state.logs.set(id, { error: error.message });
    }
    render();
  });
}

export function loadMachineRuns(id) {
  return once(`machine-runs:${id}`, async () => {
    try {
      state.machineRuns.set(id, { data: (await api(`/v1/machines/${encodeURIComponent(id)}/runs`)).data });
    } catch (error) {
      state.machineRuns.set(id, { error: error.message });
    }
    render();
  });
}

export function ensureMachineRuns(id) {
  if (!state.machineRuns.has(id)) loadMachineRuns(id);
}

export function loadSettings() {
  return once("settings", async () => {
    try {
      state.settings = { data: (await api("/v1/settings")).data };
    } catch (error) {
      state.settings = { error: error.message, status: error.status };
    }
    render();
  });
}

export function loadAudit({ more = false } = {}) {
  return once(`audit:${more}`, async () => {
    const current = state.audit ?? { entries: [], next: null };
    if (more && current.next === null) return;
    state.audit = { ...current, loading: true };
    if (more) render();
    try {
      const query = new URLSearchParams({ limit: "50" });
      if (more) query.set("before", String(current.next));
      const { data } = await api(`/v1/audit?${query}`);
      state.audit = { entries: more ? [...current.entries, ...data.entries] : data.entries, next: data.next ?? null, loading: false };
    } catch (error) {
      state.audit = { ...current, loading: false, error: error.message, status: error.status };
    }
    render();
  });
}

/**
 * Everything the current page shows, again: the snapshot, then the page's
 * own data. Called when /v1/changes says something moved.
 */
export async function refreshPage(route) {
  await loadSnapshot();
  const tasks = [];
  if (route.page === "job") {
    if (hosted()) tasks.push(loadJob(route.id));
    tasks.push(loadHistory(route.id));
  } else if (route.page === "run") {
    const run = state.runs.get(route.id)?.data;
    // A finished run does not change, except a lost one that recovers.
    if (!run || !TERMINAL_PHASES.has(phaseOf(run))) {
      tasks.push(loadRun(route.id, route.job));
      if (state.logs.has(route.id)) tasks.push(loadLog(route.id, { force: true }));
    }
  } else if (route.page === "machine") {
    tasks.push(loadMachineRuns(route.id));
  } else if (route.page === "audit") {
    tasks.push(loadAudit());
  }
  await Promise.all(tasks);
}

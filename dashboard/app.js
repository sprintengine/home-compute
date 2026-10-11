// Home Compute dashboard: plain modules, no build step, nothing loaded from
// elsewhere. Every value from the controller reaches the page as text
// (textContent), never as markup.

const EVENT_NAMES = [
  "job_submitted", "job_finished", "job_paused", "job_resumed",
  "status_error", "submission_error", "config_reloaded",
];
const POLL_LIVE_MS = 60_000;
const POLL_MS = 15_000;

const state = {
  session: null,
  snapshot: null,
  updatedAt: null,
  live: false,
  error: null,
  runs: new Map(),
  logs: new Map(),
  editing: null,
  busy: new Set(),
};

const main = document.getElementById("main");
const topStatus = document.getElementById("top-status");
const toastBox = document.getElementById("toast");

// ---------- DOM helpers

function h(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (name === "class") element.className = value;
    else if (name.startsWith("on")) element.addEventListener(name.slice(2), value);
    else if (value === true) element.setAttribute(name, "");
    else element.setAttribute(name, String(value));
  }
  append(element, children);
  return element;
}

function append(element, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

function toast(message, { error = false } = {}) {
  toastBox.textContent = message;
  toastBox.className = `toast${error ? " error" : ""}`;
  toastBox.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { toastBox.hidden = true; }, error ? 7000 : 3500);
}

// ---------- Formatting

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dayClock = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const fullTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

function parseTime(value) {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? time : null;
}

function sameDay(a, b) {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

function when(value) {
  const time = parseTime(value);
  if (time === null) return "—";
  return sameDay(time, Date.now()) ? clock.format(time) : dayClock.format(time);
}

function relative(value) {
  const time = parseTime(value);
  if (time === null) return "never";
  const seconds = Math.round((time - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  let text;
  if (abs < 45) return seconds >= 0 ? "now" : "just now";
  if (abs < 3600) text = `${Math.round(abs / 60)} min`;
  else if (abs < 86_400) text = `${Math.round(abs / 360) / 10} h`.replace(".0 h", " h");
  else text = `${Math.round(abs / 86_400)} d`;
  return seconds >= 0 ? `in ${text}` : `${text} ago`;
}

function duration(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "—";
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** "2026101112" (a model run) as "11 Oct 12Z". */
function modelRun(run) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})$/.exec(String(run ?? ""));
  if (!match) return run ? String(run) : "—";
  const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  return `${date.getUTCDate()} ${date.toLocaleString("en", { month: "short", timeZone: "UTC" })} ${match[4]}Z`;
}

function megabytes(value) {
  if (typeof value !== "number") return "—";
  return value >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${Math.round(value)} MB`;
}

function bytes(value) {
  if (typeof value !== "number") return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

/** A metric by the unit its name implies; anything else as a plain number. */
function metric(name, value) {
  if (/mb$/i.test(name)) return megabytes(value);
  if (/bytes$/i.test(name)) return bytes(value);
  if (/seconds$/i.test(name)) return duration(value);
  return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** A field name as a label; its unit is left to the value ("peakMemoryMb" is "Peak memory"). */
function words(name) {
  const bare = name.replace(/Mb$/, "").replace(/Bytes$/, "").replace(/(.)Seconds$/, "$1 time").replace(/^seconds$/, "time");
  const text = bare.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase()
    .replace(/\b(cpu|gpu|io)\b/g, (word) => word.toUpperCase());
  return text.replace(/^./, (c) => c.toUpperCase());
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function scheduleText(schedule) {
  if (!schedule) return "No schedule";
  if (schedule.every) return `Every ${schedule.every} after the last run`;
  const at = schedule.at ?? {};
  const minutes = at.minutes ?? [0];
  if (!at.hours) return `Hourly at ${minutes.map((m) => `:${pad(m)}`).join(", ")} UTC`;
  const times = at.hours.flatMap((hour) => minutes.map((m) => `${pad(hour)}:${pad(m)}`));
  return `${times.length > 8 ? `${times.length} times a day: ` : "Daily at "}${times.join(", ")} UTC`;
}

// ---------- Job state

function jobState(job) {
  if (job.running) {
    const live = String(job.liveState ?? job.activeState ?? "").toLowerCase();
    return ["queued", "pending"].includes(live) ? "queued" : "running";
  }
  if (job.paused) return "paused";
  if (job.configuredEnabled === false) return "off";
  return "idle";
}

const STATES = {
  running: { label: "Running", tone: "running", icon: "●" },
  queued: { label: "Queued", tone: "warning", icon: "◷" },
  paused: { label: "Paused", tone: "warning", icon: "❚❚" },
  off: { label: "Off", tone: "off", icon: "○" },
  idle: { label: "Idle", tone: "", icon: "○" },
};

const OUTCOMES = {
  published: { label: "Published", tone: "good", icon: "✓" },
  unchanged: { label: "No new run", tone: "", icon: "＝" },
  completed: { label: "Completed", tone: "good", icon: "✓" },
  failed: { label: "Failed", tone: "critical", icon: "✕" },
};

function chip(spec, title) {
  return h("span", { class: `chip ${spec.tone}`, title }, h("span", { class: "icon", "aria-hidden": "true" }, spec.icon), spec.label);
}

function stateChip(job) {
  return chip(STATES[jobState(job)]);
}

function outcomeChip(outcome, state) {
  if (outcome && OUTCOMES[outcome]) return chip(OUTCOMES[outcome]);
  if (state && /fail|error/i.test(state)) return chip(OUTCOMES.failed);
  if (state) return chip({ label: state, tone: "", icon: "·" });
  return null;
}

function pendingSubmissionError(job) {
  if (!job.lastSubmissionError) return null;
  const at = parseTime(job.lastSubmissionErrorAt);
  const finished = parseTime(job.lastFinishedAt);
  if (at !== null && finished !== null && finished > at) return null;
  return job.lastSubmissionError;
}

/** Why a job needs a look, or null. */
function attention(job) {
  if (jobState(job) === "off") return null;
  const submission = pendingSubmissionError(job);
  if (submission) return `Could not submit: ${submission}`;
  if (job.liveError) return `Bacalhau: ${job.liveError}`;
  if (job.lastOutcome === "failed") return job.lastError || `Last run ended ${job.lastFinishedState ?? "Failed"}`;
  return null;
}

function latestRun(job) {
  return (job.recentRuns ?? []).find((run) => run.finishedAt) ?? null;
}

// ---------- API

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, { method = "GET", body } = {}) {
  const headers = { accept: "application/json" };
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    if (state.session?.csrfToken) headers["x-csrf-token"] = state.session.csrfToken;
  }
  const response = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    cache: "no-store",
    body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    // An empty or non-JSON body.
  }
  if (response.status === 401) {
    state.session = null;
    showLogin();
    throw new ApiError(401, "Signed out");
  }
  if (!response.ok) throw new ApiError(response.status, data?.error ?? `HTTP ${response.status}`);
  return data;
}

// ---------- Live updates

let source = null;
let pollTimer = null;
let refreshTimer = null;
let refreshing = null;

function scheduleRefresh(delay = 400) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh(), delay);
}

function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    await refresh();
    schedulePoll();
  }, state.live ? POLL_LIVE_MS : POLL_MS);
}

function connectEvents() {
  source?.close();
  source = new EventSource("/v1/events");
  source.addEventListener("ready", () => {
    state.live = true;
    renderStatus();
    schedulePoll();
  });
  for (const name of EVENT_NAMES) {
    source.addEventListener(name, (event) => {
      let data = {};
      try { data = JSON.parse(event.data); } catch { /* keep {} */ }
      if (data.job) state.runs.delete(data.job);
      if (name === "job_finished" && data.outcome === "failed") toast(`${data.job} failed`, { error: true });
      scheduleRefresh();
    });
  }
  source.onerror = () => {
    // EventSource reconnects by itself; poll faster meanwhile.
    if (state.live) {
      state.live = false;
      renderStatus();
      schedulePoll();
    }
  };
}

async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      state.snapshot = await api("/v1/snapshot");
      state.updatedAt = Date.now();
      state.error = null;
      const route = parseRoute();
      if (route.job) await loadRuns(route.job, { quiet: true });
    } catch (error) {
      if (error.status !== 401) state.error = error.message;
    } finally {
      refreshing = null;
    }
    if (state.session) render();
  })();
  return refreshing;
}

const runsLoading = new Map();

/** Loads a job's run history once at a time; render() calls ensureRuns, which never loops. */
function loadRuns(job, options = {}) {
  if (!runsLoading.has(job)) {
    runsLoading.set(job, fetchRuns(job, options).finally(() => runsLoading.delete(job)));
  }
  return runsLoading.get(job);
}

function ensureRuns(job) {
  if (!state.runs.has(job) && !runsLoading.has(job)) loadRuns(job, { quiet: true }).then(render);
}

async function fetchRuns(job, { quiet = false } = {}) {
  try {
    const data = await api(`/v1/jobs/${encodeURIComponent(job)}/runs`);
    state.runs.set(job, data.runs ?? []);
  } catch (error) {
    // Fall back to the snapshot's recent runs rather than asking again at once.
    if (!state.runs.has(job)) state.runs.set(job, (state.snapshot?.jobs ?? []).find((j) => j.id === job)?.recentRuns ?? []);
    if (!quiet) toast(error.message, { error: true });
  }
}

async function loadLog(runId, { force = false } = {}) {
  const current = state.logs.get(runId);
  if (current?.loading || ((current?.data || current?.error) && !force)) return;
  state.logs.set(runId, { loading: true });
  if (force) render();
  try {
    state.logs.set(runId, { data: await api(`/v1/runs/${encodeURIComponent(runId)}/logs`) });
  } catch (error) {
    state.logs.set(runId, { error: error.message });
  }
  render();
}

// ---------- Actions

async function act(job, action) {
  const key = `${job}:${action}`;
  if (state.busy.has(key)) return;
  if (action === "run" && !confirm(`Run ${job} now?`)) return;
  state.busy.add(key);
  render();
  try {
    await api(`/v1/jobs/${encodeURIComponent(job)}/${action}`, { method: "POST" });
    toast({ run: `${job} submitted`, pause: `${job} paused`, resume: `${job} resumed` }[action]);
  } catch (error) {
    toast(`${job}: ${error.message}`, { error: true });
  } finally {
    state.busy.delete(key);
    await refresh();
  }
}

async function saveTimetable(job, changes) {
  const key = `${job}:timetable`;
  state.busy.add(key);
  render();
  try {
    const result = await api(`/v1/jobs/${encodeURIComponent(job)}/timetable`, { method: "POST", body: changes });
    state.editing = null;
    const restart = result.reload?.restartRequired ?? [];
    toast(restart.length
      ? `Saved. Restart the controller to apply ${restart.join(", ")}.`
      : "Saved and applied.");
  } catch (error) {
    toast(error.message, { error: true });
  } finally {
    state.busy.delete(key);
    await refresh();
  }
}

async function signOut() {
  try {
    await api("/v1/session", { method: "DELETE" });
  } catch {
    // Signed out either way.
  }
  state.session = null;
  source?.close();
  showLogin();
}

// ---------- Routing

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "job" && parts[1]) return { job: parts[1], run: parts[2] === "run" ? parts[3] : undefined };
  return {};
}

function jobHref(id) {
  return `#/job/${encodeURIComponent(id)}`;
}

function runHref(job, run) {
  return `${jobHref(job)}/run/${encodeURIComponent(run)}`;
}

// ---------- Rendering

function renderStatus() {
  const snapshot = state.snapshot;
  topStatus.replaceChildren();
  if (!state.session) return;
  const degraded = snapshot?.controller?.status === "degraded" || state.error;
  append(topStatus, [
    h("span", { class: `dot ${degraded ? "critical" : "good"}`, "aria-hidden": "true" }),
    h("span", {}, state.error ? "Unreachable" : degraded ? "Degraded" : "Online"),
    h("span", { class: "sep" }, "·"),
    h("span", { title: state.live ? "Receiving live events" : `Refreshing every ${POLL_MS / 1000} s` }, state.live ? "Live" : "Polling"),
    state.session.method === "session"
      ? [h("span", { class: "sep" }, "·"), h("button", { class: "link", onclick: signOut }, "Sign out")]
      : null,
  ]);
}

function render() {
  renderStatus();
  if (!state.session) return;
  const route = parseRoute();
  const scroll = window.scrollY;
  const logScroll = main.querySelector(".log")?.scrollTop;
  const focused = document.activeElement?.id;
  let view;
  if (!state.snapshot) {
    view = state.error ? h("div", { class: "banner" }, `Cannot reach the controller: ${state.error}`) : h("p", { class: "muted center" }, "Loading…");
  } else if (route.job && route.run) {
    view = runView(route.job, route.run);
  } else if (route.job) {
    view = jobView(route.job);
  } else {
    view = overview();
  }
  main.replaceChildren(view);
  window.scrollTo(0, scroll);
  const log = main.querySelector(".log");
  // A log opens at its end, the part a tail is for; later renders keep the reader's place.
  if (log) log.scrollTop = logScroll ?? log.scrollHeight;
  if (focused) document.getElementById(focused)?.focus();
}

function overview() {
  const { snapshot } = state;
  const jobs = snapshot.jobs ?? [];
  const flagged = jobs.filter((job) => attention(job));
  const active = jobs.filter((job) => !flagged.includes(job) && ["running", "queued"].includes(jobState(job)));
  const rest = jobs.filter((job) => !flagged.includes(job) && !active.includes(job) && jobState(job) !== "off");
  const off = jobs.filter((job) => jobState(job) === "off");
  const nodes = snapshot.nodeCount ?? (snapshot.nodes ?? []).length;

  return h("div", {},
    state.error ? h("div", { class: "banner" }, `Last refresh failed: ${state.error}`) : null,
    snapshot.controller?.clusterError ? h("div", { class: "banner" }, `Bacalhau: ${snapshot.controller.clusterError}`) : null,
    h("p", { class: "muted small" },
      `${jobs.length - off.length} jobs scheduled · ${nodes} ${nodes === 1 ? "node" : "nodes"}`,
      state.updatedAt ? ` · updated ${clock.format(state.updatedAt)}` : ""),
    flagged.length ? [h("h2", {}, `Needs attention (${flagged.length})`), h("div", { class: "stack" }, flagged.map(jobCard))] : null,
    active.length ? [h("h2", {}, "Running now"), h("div", { class: "stack" }, active.map(jobCard))] : null,
    h("h2", {}, "Jobs"),
    h("div", { class: "stack" }, rest.length ? rest.map(jobCard) : h("p", { class: "muted" }, "No other jobs.")),
    off.length ? h("p", { class: "off-line" }, `Off in the timetable: ${off.map((job) => job.id).join(", ")}`) : null,
  );
}

function jobCard(job) {
  const status = jobState(job);
  const problem = attention(job);
  const last = latestRun(job);
  const finishedAt = last?.finishedAt ?? job.lastFinishedAt;
  const published = Object.entries(job.published ?? {});
  const peak = last?.metrics?.peakMemoryMb;
  const nextDue = job.nextDueAt;

  return h("a", { class: `job${problem ? " attention" : ""}${["running", "queued"].includes(status) ? " running" : ""}`, href: jobHref(job.id) },
    h("div", { class: "row between" },
      h("span", { class: "job-name grow" }, job.id),
      stateChip(job)),
    job.description ? h("div", { class: "job-desc" }, job.description) : null,
    h("div", { class: "job-lines" },
      problem ? h("div", { class: "error-text" }, problem) : null,
      ["running", "queued"].includes(status)
        ? h("div", { class: "line" }, `${status === "queued" ? "Waiting for capacity" : "Running"} since ${when(job.lastSubmittedAt)}`,
          h("span", { class: "sep" }, "·"), relative(job.lastSubmittedAt))
        : null,
      finishedAt
        ? h("div", { class: "line" },
          outcomeChip(job.lastOutcome, job.lastFinishedState),
          h("span", {}, `${when(finishedAt)} (${relative(finishedAt)})`),
          last?.durationSeconds !== undefined ? [h("span", { class: "sep" }, "·"), h("span", {}, duration(last.durationSeconds))] : null,
          peak !== undefined ? [h("span", { class: "sep" }, "·"), h("span", { title: "Peak memory" }, `peak ${megabytes(peak)}`)] : null)
        : h("div", { class: "line muted" }, "Not run yet"),
      published.length
        ? h("div", { class: "line" }, published.map(([model, entry], index) => [
          index ? h("span", { class: "sep" }, "·") : null,
          h("span", { title: entry.at ? `Fetched ${fullTime.format(new Date(entry.at))}` : undefined }, `${model} ${modelRun(entry.run)}`),
        ]))
        : null,
      status === "paused"
        ? h("div", { class: "line muted" }, "Paused: scheduled runs are skipped")
        : nextDue ? h("div", { class: "line muted" }, `Next ${when(nextDue)} (${relative(nextDue)})`) : null,
    ));
}

function jobView(id) {
  const job = (state.snapshot.jobs ?? []).find((candidate) => candidate.id === id);
  if (!job) return h("div", {}, h("a", { class: "back", href: "#/" }, "‹ All jobs"), h("p", {}, `No job ${id}.`));
  ensureRuns(id);
  const runs = state.runs.get(id) ?? job.recentRuns ?? [];
  const status = jobState(job);
  const problem = attention(job);
  const busy = (action) => state.busy.has(`${id}:${action}`);

  return h("div", {},
    h("a", { class: "back", href: "#/" }, "‹ All jobs"),
    h("div", { class: "row between" }, h("h1", { class: "grow" }, job.id), stateChip(job)),
    job.description ? h("div", { class: "job-desc" }, job.description) : null,
    problem ? h("div", { class: "banner", style: undefined }, problem) : null,
    h("div", { class: "actions" },
      h("button", { class: "primary", disabled: job.running || busy("run"), onclick: () => act(id, "run") }, busy("run") ? "Submitting…" : "Run now"),
      job.paused
        ? h("button", { disabled: busy("resume"), onclick: () => act(id, "resume") }, "Resume")
        : h("button", { disabled: busy("pause") || status === "off", onclick: () => act(id, "pause") }, "Pause")),
    scheduleSection(job),
    publishedSection(job),
    h("h2", {}, `Run history (${runs.length})`),
    runs.length ? runTable(id, runs) : h("p", { class: "muted" }, "No runs recorded yet."),
  );
}

function scheduleSection(job) {
  const editable = state.snapshot.timetable?.editable && job.schedule?.at;
  const editing = state.editing?.job === job.id;
  const card = h("div", { class: "card" });
  if (editing) {
    card.append(timetableForm(job));
  } else {
    append(card, [
      h("div", { class: "row between" },
        h("div", { class: "grow" },
          h("div", {}, job.configuredEnabled === false ? "Off in the timetable" : scheduleText(job.schedule)),
          job.nextDueAt ? h("div", { class: "muted small" }, `Next ${when(job.nextDueAt)} (${relative(job.nextDueAt)})`) : null),
        editable ? h("button", { onclick: () => { state.editing = draftFor(job); render(); } }, "Edit") : null),
      editable ? null : h("p", { class: "muted small" },
        "The timetable is read-only here. Change it in the project (for Wingfoil: ",
        h("span", { class: "mono" }, `macmini.sh jobs set ${job.id} --hours 6,12 --minutes 0`),
        "), then reload the controller (POST /v1/reload) or restart it."),
    ]);
  }
  return [h("h2", {}, "Timetable"), card];
}

function draftFor(job) {
  const at = job.schedule?.at ?? {};
  return {
    job: job.id,
    enabled: job.configuredEnabled !== false,
    everyHour: !at.hours,
    hours: new Set(at.hours ?? []),
    minutes: (at.minutes ?? [0]).join(", "),
  };
}

function timetableForm(job) {
  const draft = state.editing;
  const busy = state.busy.has(`${job.id}:timetable`);
  const hourButtons = Array.from({ length: 24 }, (_, hour) => h("button", {
    type: "button",
    "aria-pressed": String(draft.hours.has(hour)),
    disabled: draft.everyHour,
    onclick: () => {
      if (draft.hours.has(hour)) draft.hours.delete(hour); else draft.hours.add(hour);
      render();
    },
  }, pad(hour)));

  const submit = (event) => {
    event.preventDefault();
    const minutes = draft.minutes.split(/[\s,]+/).filter(Boolean).map(Number);
    if (!minutes.length || minutes.some((m) => !Number.isInteger(m) || m < 0 || m > 59)) {
      toast("Minutes must be whole numbers from 0 to 59, separated by commas", { error: true });
      return;
    }
    if (!draft.everyHour && draft.hours.size === 0) {
      toast("Choose at least one hour, or every hour", { error: true });
      return;
    }
    const before = draftFor(job);
    const changes = {};
    if (draft.enabled !== before.enabled) changes.enabled = draft.enabled;
    const hours = draft.everyHour ? "every" : [...draft.hours].sort((a, b) => a - b);
    const beforeHours = before.everyHour ? "every" : [...before.hours].sort((a, b) => a - b);
    if (JSON.stringify(hours) !== JSON.stringify(beforeHours)) changes.hours = hours;
    const sortedMinutes = [...new Set(minutes)].sort((a, b) => a - b);
    if (JSON.stringify(sortedMinutes) !== JSON.stringify(job.schedule?.at?.minutes ?? [0])) changes.minutes = sortedMinutes;
    if (!Object.keys(changes).length) {
      state.editing = null;
      render();
      return;
    }
    saveTimetable(job.id, changes);
  };

  return h("form", { onsubmit: submit },
    h("label", { class: "check" },
      h("input", { type: "checkbox", id: "tt-enabled", checked: draft.enabled, onchange: (event) => { draft.enabled = event.target.checked; render(); } }),
      "Enabled"),
    h("div", { class: "field" },
      h("span", {}, "Hours (UTC)"),
      h("label", { class: "check" },
        h("input", { type: "checkbox", id: "tt-every", checked: draft.everyHour, onchange: (event) => { draft.everyHour = event.target.checked; render(); } }),
        "Every hour"),
      h("div", { class: "hours" }, hourButtons)),
    h("label", { class: "field" },
      h("span", {}, "Minutes past the hour"),
      h("input", {
        type: "text", id: "tt-minutes", inputmode: "numeric", autocomplete: "off", value: draft.minutes,
        oninput: (event) => { draft.minutes = event.target.value; },
      })),
    h("p", { class: "muted small" }, "Saved through the project's timetable command, then applied without a restart."),
    h("div", { class: "actions" },
      h("button", { class: "primary", type: "submit", disabled: busy }, busy ? "Saving…" : "Save"),
      h("button", { type: "button", disabled: busy, onclick: () => { state.editing = null; render(); } }, "Cancel")));
}

function publishedSection(job) {
  const entries = Object.entries(job.published ?? {});
  if (!entries.length) return null;
  return [
    h("h2", {}, "Last published"),
    h("div", { class: "card" }, h("dl", { class: "facts" }, entries.map(([model, entry]) => [
      h("dt", {}, model),
      h("dd", {}, modelRun(entry.run), entry.at ? h("span", { class: "muted" }, ` · fetched ${relative(entry.at)}`) : null),
    ]))),
  ];
}

function runTable(job, runs) {
  return h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {},
      h("th", {}, "Started"),
      h("th", { class: "num" }, "Took"),
      h("th", {}, "Outcome"),
      h("th", { class: "num wide" }, "Queued"),
      h("th", { class: "num wide" }, "Exit"),
      h("th", { class: "num wide" }, "Peak mem"),
      h("th", { class: "wide" }, "Published"))),
    h("tbody", {}, runs.map((run) => {
      const open = () => { location.hash = runHref(job, run.id); };
      return h("tr", {
        class: run.outcome === "failed" ? "failed" : "",
        tabindex: "0",
        onclick: open,
        onkeydown: (event) => { if (event.key === "Enter") open(); },
      },
      h("td", {}, h("a", { href: runHref(job, run.id) }, when(run.startedAt ?? run.submittedAt))),
      h("td", { class: "num" }, run.finishedAt ? duration(run.durationSeconds) : "…"),
      h("td", {}, run.finishedAt ? outcomeChip(run.outcome, run.state) : chip(run.state === "Running" ? STATES.running : STATES.queued)),
      h("td", { class: "num wide" }, duration(run.queueSeconds)),
      h("td", { class: "num wide" }, run.exitCode ?? "—"),
      h("td", { class: "num wide" }, run.metrics?.peakMemoryMb !== undefined ? megabytes(run.metrics.peakMemoryMb) : "—"),
      h("td", { class: "wide" }, (run.published ?? []).map((entry) => `${entry.key} ${modelRun(entry.run)}`).join(", ") || "—"));
    }))));
}

function runView(jobId, runId) {
  ensureRuns(jobId);
  const run = (state.runs.get(jobId) ?? []).find((candidate) => candidate.id === runId);
  loadLog(runId);
  const log = state.logs.get(runId);

  return h("div", {},
    h("a", { class: "back", href: jobHref(jobId) }, `‹ ${jobId}`),
    h("div", { class: "row between" },
      h("h1", { class: "grow" }, run ? `Run of ${when(run.startedAt ?? run.submittedAt)}` : "Run"),
      run?.finishedAt ? outcomeChip(run.outcome, run.state) : run ? chip(STATES.running) : null),
    h("p", { class: "mono muted" }, runId),
    run ? runDetails(run) : h("p", { class: "muted" }, "Not in this job's history."),
    h("h2", {}, "Log"),
    logView(runId, log));
}

function runDetails(run) {
  const facts = [
    ["State", run.state],
    ["Submitted", run.submittedAt && fullTime.format(new Date(run.submittedAt))],
    ["Started", run.startedAt && fullTime.format(new Date(run.startedAt))],
    ["Finished", run.finishedAt && fullTime.format(new Date(run.finishedAt))],
    ["Queued for", run.queueSeconds !== undefined ? duration(run.queueSeconds) : null],
    ["Took", run.durationSeconds !== undefined ? duration(run.durationSeconds) : null],
    ["Exit code", run.exitCode],
    ["Source", run.source === "manual" ? "Run now" : run.source === "schedule" ? "Timetable" : run.source],
    ["Arguments", run.parameters?.join(" ")],
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");
  const metrics = Object.entries(run.metrics ?? {});

  return [
    run.error ? h("div", { class: "banner" }, run.error) : null,
    run.failureDetail ? h("pre", { class: "detail" }, run.failureDetail) : null,
    h("h2", {}, "Details"),
    h("div", { class: "card" }, h("dl", { class: "facts" }, facts.map(([name, value]) => [h("dt", {}, name), h("dd", {}, String(value))]))),
    metrics.length ? [
      h("h2", {}, "Reported numbers"),
      h("div", { class: "card" }, h("dl", { class: "facts" }, metrics.map(([name, value]) => [
        h("dt", {}, words(name)), h("dd", { title: String(value) }, metric(name, value)),
      ]))),
    ] : null,
    (run.reports ?? []).length ? [
      h("h2", {}, `Reports (${run.reports.length})`),
      h("div", { class: "card" }, run.reports.map(reportView)),
    ] : null,
  ];
}

function reportView(report) {
  const known = new Set(["event", "model", "run", "time", "phases", "status", "error"]);
  const numbers = Object.entries(report).filter(([key, value]) => !known.has(key) && typeof value === "number");
  const phases = report.phases && typeof report.phases === "object" ? Object.entries(report.phases) : [];
  return h("div", { class: "report" },
    h("div", { class: "row" },
      h("strong", {}, report.event ?? "report"),
      report.model ? h("span", {}, report.model) : null,
      report.run ? h("span", { class: "muted" }, modelRun(report.run)) : null,
      report.status ? h("span", { class: "chip" }, report.status) : null),
    report.error ? h("div", { class: "error-text" }, report.error) : null,
    numbers.length ? h("div", { class: "phases" }, numbers.map(([key, value]) => h("span", {}, `${words(key)}: ${metric(key, value)}`))) : null,
    phases.length ? h("div", { class: "phases" }, phases.map(([name, phase]) => h("span", {},
      `${name} ${typeof phase?.seconds === "number" ? duration(phase.seconds) : ""}${typeof phase?.bytes === "number" ? ` · ${bytes(phase.bytes)}` : ""}`))) : null);
}

function logView(runId, log) {
  if (!log || log.loading) return h("p", { class: "muted" }, "Loading the log…");
  if (log.error) {
    return h("div", {}, h("div", { class: "banner" }, `Could not load the log: ${log.error}`),
      h("div", { class: "actions" }, h("button", { onclick: () => loadLog(runId, { force: true }) }, "Try again")));
  }
  const data = log.data;
  const errorsOnly = state.logErrorsOnly && data.errorCount > 0;
  const lines = data.lines ?? [];
  const pre = h("div", { class: `log${state.logWrap ? " wrap" : ""}${errorsOnly ? " errors-only" : ""}`, role: "log" },
    lines.map((line, index) => h("div", { class: `log-line ${line.level}`, id: `L${index + 1}` },
      h("span", { class: "n" }, index + 1), h("span", { class: "t" }, line.text || " "))));
  const firstError = lines.findIndex((line) => line.level === "error");

  return h("div", {},
    h("div", { class: "log-tools" },
      h("span", { class: data.errorCount ? "chip critical" : "chip" }, `${data.errorCount} error line${data.errorCount === 1 ? "" : "s"}`),
      h("span", { class: "muted" },
        `${lines.length} lines${data.truncated ? ` (the last ${lines.length}; ${bytes(data.bytes)} in all)` : ""}`,
        data.partial ? " · still being written" : ""),
      firstError >= 0 ? h("button", { class: "link", onclick: () => {
        state.logErrorsOnly = false;
        render();
        const target = document.getElementById(`L${firstError + 1}`);
        target?.scrollIntoView({ block: "center" });
      } }, "First error") : null,
      h("label", {}, h("input", { type: "checkbox", id: "log-errors", checked: Boolean(state.logErrorsOnly), disabled: !data.errorCount,
        onchange: (event) => { state.logErrorsOnly = event.target.checked; render(); } }), "Errors only"),
      h("label", {}, h("input", { type: "checkbox", id: "log-wrap", checked: Boolean(state.logWrap),
        onchange: (event) => { state.logWrap = event.target.checked; render(); } }), "Wrap"),
      h("button", { class: "link", onclick: () => loadLog(runId, { force: true }) }, "Reload")),
    lines.length ? pre : h("p", { class: "muted" }, "The log is empty."));
}

// ---------- Sign in

function showLogin(info = {}) {
  clearTimeout(pollTimer);
  source?.close();
  renderStatus();
  const expired = new URLSearchParams(location.search).get("signin") === "expired";
  const form = h("form", {
    onsubmit: async (event) => {
      event.preventDefault();
      const input = form.querySelector("input");
      const button = form.querySelector("button");
      button.disabled = true;
      try {
        const response = await fetch("/v1/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ token: input.value }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error({
            invalid_token: "That token is not right.",
            throttled: "Too many attempts. Wait ten minutes.",
            no_token_configured: "This controller has no API token to sign in with.",
          }[data.error] ?? data.error ?? `HTTP ${response.status}`);
        }
        input.value = "";
        history.replaceState(null, "", location.pathname + location.hash);
        start(data);
      } catch (error) {
        toast(error.message, { error: true });
      } finally {
        button.disabled = false;
      }
    },
  },
  h("label", { class: "field" },
    h("span", {}, "API token"),
    h("input", { type: "password", id: "token", autocomplete: "current-password", required: true, placeholder: "HOME_COMPUTE_API_TOKEN" })),
  h("div", { class: "actions" }, h("button", { class: "primary", type: "submit" }, "Sign in")));

  main.replaceChildren(h("div", { class: "login card" },
    h("h1", {}, "Sign in"),
    expired ? h("div", { class: "banner" }, "That sign-in link has expired or was already used. Open the dashboard from the menu bar again, or use the token.") : null,
    info.tailscaleLogin
      ? h("p", {}, `Tailscale says you are ${info.tailscaleLogin}, but that login is not on this controller's dashboard.allowedLogins.`)
      : h("p", {}, "Over Tailscale, an allowed login is signed in automatically. Otherwise use the controller's API token (HOME_COMPUTE_API_TOKEN)."),
    info.tokenLogin === false ? h("p", {}, "This controller has no API token configured, so only Tailscale sign-in works here.") : form));
}

function start(session) {
  state.session = session;
  render();
  refresh();
  connectEvents();
  schedulePoll();
}

async function boot() {
  let session;
  try {
    const response = await fetch("/v1/session", { credentials: "same-origin", cache: "no-store" });
    session = await response.json();
  } catch (error) {
    main.replaceChildren(h("div", { class: "banner" }, `Cannot reach the controller: ${error.message}`));
    return;
  }
  if (session.authenticated) start(session);
  else showLogin(session);
}

window.addEventListener("hashchange", () => {
  state.editing = null;
  render();
  window.scrollTo(0, 0);
  const route = parseRoute();
  if (route.job) loadRuns(route.job, { quiet: true }).then(render);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.session) refresh();
});

// Relative times move on even when nothing else does.
setInterval(() => { if (state.session && !state.editing) render(); }, 30_000);

boot();

// The dashboard's shared core: its state, DOM helpers, the API client (with
// the CSRF token on every change), chips, dialogs and the loaders views ask
// for data through. Every value from the server reaches the page as text
// (textContent), never as markup.

import { PHASE_LABELS, jobState, phaseOf } from "./lib.js";

export const state = {
  session: null,
  snapshot: null,
  cursor: null,
  updatedAt: null,
  error: null,
  offline: false,
  live: false,
  jobs: new Map(), // id → {data, error}: GET /v1/jobs/:id
  history: new Map(), // job id → {runs, next, loading, done, error}
  runs: new Map(), // run id → {data, error}: GET /v1/runs/:id
  logs: new Map(), // run id → {data, error, loading}
  machineRuns: new Map(), // machine id → {data, error}
  settings: null,
  audit: null, // {entries, next, loading, done}
  joinToken: null, // the last join token made, shown once, then forgotten
  editing: null, // {kind, id, ...draft}
  busy: new Set(),
  ui: { logErrorsOnly: false, logWrap: false, showRevoked: false },
};

let renderer = () => {};
export function setRenderer(fn) {
  renderer = fn;
}
export function render() {
  renderer();
}

// ---------- Session and roles

/** Whether this dashboard talks to the hosted control plane (Access) rather than the local controller. */
export function hosted() {
  return state.session?.method === "access" || state.snapshot?.controller?.kind === "hosted";
}

export function hasFeature(name) {
  return (state.snapshot?.controller?.features ?? []).includes(name);
}

const RANK = { viewer: 0, operator: 1, admin: 2 };
/** Whether the signed-in role may do what `needed` may. The local controller's sessions can do everything. */
export function can(needed) {
  const role = state.session?.role;
  if (!role) return !hosted();
  return (RANK[role] ?? -1) >= RANK[needed];
}

// ---------- DOM

export function h(tag, attributes = {}, ...children) {
  const svg = ["svg", "rect", "line", "g", "title", "text", "path"].includes(tag) && attributes?.svg !== false;
  const element = svg ? document.createElementNS("http://www.w3.org/2000/svg", tag) : document.createElement(tag);
  for (const [name, value] of Object.entries(attributes ?? {})) {
    if (value === undefined || value === null || value === false || name === "svg") continue;
    if (name === "class") element.setAttribute("class", value);
    else if (name.startsWith("on") && typeof value === "function") element.addEventListener(name.slice(2), value);
    else if (name === "value" && "value" in element && !svg) element.value = value;
    else if (name === "checked" && !svg) element.checked = Boolean(value);
    else if (value === true) element.setAttribute(name, "");
    else element.setAttribute(name, String(value));
  }
  append(element, children);
  return element;
}

export function append(element, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

export function toast(message, { error = false } = {}) {
  const box = document.getElementById("toast");
  box.textContent = message;
  box.className = `toast${error ? " error" : ""}`;
  box.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { box.hidden = true; }, error ? 7000 : 3500);
}

/**
 * A modal confirmation (a <dialog>, so focus stays inside and Escape cancels).
 * Resolves true only for the confirm button. `typeToConfirm` makes the
 * person type a word (a machine's name) first.
 */
export function confirmDialog({ title, body, confirm = "Confirm", danger = false, typeToConfirm = null }) {
  return new Promise((resolve) => {
    const input = typeToConfirm ? h("input", { type: "text", id: "confirm-input", autocomplete: "off", "aria-describedby": "confirm-body" }) : null;
    const ok = h("button", { class: danger ? "danger-fill" : "primary", type: "submit", value: "ok", disabled: Boolean(typeToConfirm), id: "confirm-ok" }, confirm);
    if (input) input.addEventListener("input", () => { ok.disabled = input.value.trim() !== typeToConfirm; });
    const dialog = h("dialog", { class: "dialog", "aria-labelledby": "confirm-title" },
      h("form", { method: "dialog" },
        h("h2", { class: "dialog-title", id: "confirm-title" }, title),
        h("div", { id: "confirm-body" }, body),
        input ? h("label", { class: "field" }, h("span", {}, `Type ${typeToConfirm} to confirm`), input) : null,
        h("div", { class: "actions" },
          ok,
          h("button", { type: "submit", value: "cancel", formnovalidate: true }, "Cancel"))));
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "ok");
      dialog.remove();
    });
    document.body.append(dialog);
    dialog.showModal();
    (input ?? ok).focus();
  });
}

// ---------- Chips

const STATES = {
  running: { label: "Running", tone: "running", icon: "●" },
  queued: { label: "Waiting", tone: "warning", icon: "◷" },
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

const PHASE_CHIPS = {
  due: STATES.queued,
  claimed: { label: PHASE_LABELS.claimed, tone: "running", icon: "●" },
  "starting-vm": { label: PHASE_LABELS["starting-vm"], tone: "running", icon: "●" },
  pulling: { label: PHASE_LABELS.pulling, tone: "running", icon: "●" },
  running: STATES.running,
  reporting: { label: PHASE_LABELS.reporting, tone: "running", icon: "●" },
  cancelled: { label: "Cancelled", tone: "off", icon: "⊘" },
  skipped: { label: "Skipped", tone: "off", icon: "»" },
  lost: { label: "Lost", tone: "critical", icon: "?" },
  "timed-out": { label: "Timed out", tone: "critical", icon: "✕" },
};

export function chip(spec, title) {
  return h("span", { class: `chip ${spec.tone}`, title }, h("span", { class: "icon", "aria-hidden": "true" }, spec.icon), spec.label);
}

export function stateChip(job) {
  return chip(STATES[jobState(job)]);
}

export function outcomeChip(outcome, stateName) {
  if (outcome && OUTCOMES[outcome]) return chip(OUTCOMES[outcome]);
  if (stateName && /fail|error/i.test(stateName)) return chip(OUTCOMES.failed);
  if (stateName) return chip({ label: stateName, tone: "", icon: "·" });
  return null;
}

/** A run's chip: its outcome once finished, else its phase. */
export function runChip(run) {
  const phase = phaseOf(run);
  if (phase === "timed-out") return chip(PHASE_CHIPS["timed-out"]);
  if (["succeeded", "failed"].includes(phase) || run.finishedAt && !PHASE_CHIPS[phase]) return outcomeChip(run.outcome, run.state);
  const spec = PHASE_CHIPS[phase];
  return spec ? chip(spec, run.skipReason ? `skipped: ${run.skipReason}` : undefined) : outcomeChip(run.outcome, run.state);
}

// ---------- Formatting that needs the browser's own time zone

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dayClock = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
export const fullTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

/** A time in the browser's zone: the clock today, else the day too. */
export function when(value) {
  const time = typeof value === "number" ? value : Date.parse(value ?? "");
  if (!Number.isFinite(time)) return "—";
  return new Date(time).toDateString() === new Date().toDateString() ? clock.format(time) : dayClock.format(time);
}

export function clockNow(value) {
  return clock.format(value);
}

// ---------- API

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

let onSignedOut = () => {};
export function setSignedOutHandler(fn) {
  onSignedOut = fn;
}

/** A /v1 request. Changes carry JSON and the session's CSRF token (both header names: hc-web's and the local controller's). */
export async function api(path, { method = "GET", body, headers: extra = {} } = {}) {
  const headers = { accept: "application/json", ...extra };
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    if (state.session?.csrfToken) {
      headers["x-hc-csrf"] = state.session.csrfToken;
      headers["x-csrf-token"] = state.session.csrfToken;
    }
  }
  let response;
  try {
    response = await fetch(path, {
      method, headers, credentials: "same-origin", cache: "no-store",
      body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
    });
  } catch (error) {
    state.offline = true;
    throw new ApiError(0, navigator.onLine === false ? "You are offline" : `Cannot reach the server (${error.message})`);
  }
  state.offline = false;
  let data = null;
  if (response.status !== 204) {
    try { data = await response.json(); } catch { /* an empty or non-JSON body */ }
  }
  if (response.status === 401) {
    onSignedOut(data);
    throw new ApiError(401, "Signed out", data);
  }
  if (!response.ok) {
    const reason = data?.error === "csrf_check_failed" ? `refused (${data.reason}); reload the page` : data?.error;
    throw new ApiError(response.status, reason ?? `HTTP ${response.status}`, data);
  }
  return { status: response.status, data, etag: response.headers.get("etag") };
}

/** Runs `task` once at a time per `key`, marking it busy for the buttons that started it. */
export async function busy(key, task) {
  if (state.busy.has(key)) return undefined;
  state.busy.add(key);
  render();
  try {
    return await task();
  } finally {
    state.busy.delete(key);
    render();
  }
}

export function isBusy(key) {
  return state.busy.has(key);
}

// ---------- Small shared pieces

export function back(href, label) {
  return h("a", { class: "back", href }, `‹ ${label}`);
}

export function section(title, ...children) {
  return h("section", { class: "section", "aria-label": title }, h("h2", {}, title), ...children);
}

export function facts(rows) {
  const present = rows.filter(([, value]) => value !== undefined && value !== null && value !== "");
  return h("dl", { class: "facts" }, present.map(([name, value]) => [h("dt", {}, name), h("dd", {}, value instanceof Node || Array.isArray(value) ? value : String(value))]));
}

export function banner(text, tone = "") {
  return h("div", { class: `banner ${tone}`, role: tone === "info" ? "status" : "alert" }, text);
}

export function emptyState(text) {
  return h("p", { class: "muted empty" }, text);
}

/** A sentinel that calls `load` when it scrolls into view, plus a button for keyboards and old browsers. */
export function loadMore({ label = "Load more", loading = false, done = false, load }) {
  if (done) return null;
  const button = h("button", { class: "link", disabled: loading, onclick: load }, loading ? "Loading…" : label);
  const sentinel = h("div", { class: "load-more" }, button);
  if ("IntersectionObserver" in window && !loading) {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        load();
      }
    }, { rootMargin: "200px" });
    queueMicrotask(() => observer.observe(sentinel));
  }
  return sentinel;
}

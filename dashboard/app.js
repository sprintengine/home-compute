// Home Compute dashboard: plain modules, no build step, nothing loaded from
// elsewhere. Served by hc-web as static assets behind Cloudflare Access (and
// still by the local controller until it is retired). This file boots it:
// the session, routing, navigation and live updates.
//
// Live updates on the hosted control plane: while the page is visible it
// asks GET /v1/changes every 10 s (204 while nothing moved) and reloads the
// snapshot and the page's own data only when the cursor moves; polling
// stops while the page is hidden. The local controller has no cursor, so
// there it listens to /v1/events and polls the snapshot as before.

import { parseRoute } from "./lib.js";
import {
  api, append, banner, can, clockNow, h, hasFeature, hosted, setRenderer, setSignedOutHandler, state, toast,
} from "./ui.js";
import { loadSnapshot, refreshPage } from "./data.js";
import { overview } from "./overview.js";
import { jobPage } from "./job.js";
import { applyBarWidths, runPage } from "./run.js";
import { addMachinePage, machinePage, machinesPage } from "./machines.js";
import { timetablePage } from "./timetable.js";
import { auditPage, settingsPage } from "./admin.js";

const CHANGES_EVERY_MS = 10_000;
const LEGACY_POLL_MS = 15_000;
const LEGACY_POLL_LIVE_MS = 60_000;
const LEGACY_EVENTS = ["job_submitted", "job_finished", "job_paused", "job_resumed", "status_error", "submission_error", "config_reloaded"];

const main = document.getElementById("main");
const topStatus = document.getElementById("top-status");
const nav = document.getElementById("nav");

let pollTimer = null;
let source = null;
let signedOut = null;

// ---------- Rendering

const TITLES = {
  overview: "Overview", job: "Job", run: "Run", machines: "Machines", machine: "Machine", "add-machine": "Add machine",
  timetable: "Timetable", settings: "Settings", audit: "Audit log",
};

const NAV = [
  { page: "overview", href: "#/", label: "Overview", icon: "◉" },
  { page: "timetable", href: "#/timetable", label: "Timetable", icon: "▦" },
  { page: "machines", href: "#/machines", label: "Machines", icon: "▣", hosted: true },
  { page: "settings", href: "#/settings", label: "Settings", icon: "⚙" },
];
const SECTION_OF = { job: "overview", run: "overview", machine: "machines", "add-machine": "machines", audit: "settings" };

function renderNav(route) {
  const current = SECTION_OF[route.page] ?? route.page;
  nav.replaceChildren(...(state.session ? NAV.filter((item) => !item.hosted || hosted()).map((item) => h("a", {
    href: item.href, class: "nav-item", "aria-current": item.page === current ? "page" : undefined,
  }, h("span", { class: "nav-icon", "aria-hidden": "true" }, item.icon), h("span", { class: "nav-label" }, item.label))) : []));
  nav.hidden = !state.session;
}

function renderStatus() {
  topStatus.replaceChildren();
  if (!state.session) return;
  const problem = state.offline || state.error;
  const paused = state.snapshot?.controller?.globalPause;
  append(topStatus, [
    h("span", { class: `dot ${problem ? "critical" : paused ? "warning" : "good"}`, "aria-hidden": "true" }),
    h("span", {}, state.offline ? "Offline" : state.error ? "Unreachable" : paused ? "Paused" : "Online"),
    state.updatedAt ? h("span", { class: "muted wide-only" }, `· ${clockNow(state.updatedAt)}`) : null,
    state.session.login ? h("span", { class: "who wide-only", title: `Signed in as ${state.session.login}` }, `· ${state.session.login}${state.session.role ? ` (${state.session.role})` : ""}`) : null,
    state.session.role === "viewer" ? h("span", { class: "chip off", title: "You can look but not change anything" }, "Viewer") : null,
    state.session.method === "session" ? h("button", { class: "link", onclick: signOutLocal }, "Sign out") : null,
  ]);
}

function view(route) {
  if (!state.snapshot) {
    return state.error ? banner(`Cannot reach the control plane: ${state.error}`) : h("p", { class: "muted center" }, "Loading…");
  }
  switch (route.page) {
    case "job": return jobPage(route.id);
    case "run": return runPage(route.id, route.job);
    case "machines": return machinesPage();
    case "machine": return machinePage(route.id);
    case "add-machine": return addMachinePage();
    case "timetable": return timetablePage();
    case "settings": return settingsPage();
    case "audit": return auditPage();
    default: return overview();
  }
}

function editable(element) {
  return element && (element.tagName === "TEXTAREA" || element.tagName === "SELECT" || element.tagName === "INPUT" && /^(text|number|search|email|url|)$/.test(element.type));
}

function render() {
  const route = parseRoute(location.hash);
  renderNav(route);
  renderStatus();
  if (!state.session) {
    if (signedOut) main.replaceChildren(signedOut);
    return;
  }
  document.title = `${TITLES[route.page] ?? "Home Compute"} · Home Compute`;
  // Keep the reader's place and the field being typed in across a re-render.
  const scroll = window.scrollY;
  const logScroll = main.querySelector(".log")?.scrollTop;
  const active = document.activeElement;
  const focusId = main.contains(active) ? active.id : null;
  const selection = editable(active) && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;
  main.replaceChildren(view(route));
  applyBarWidths(main);
  window.scrollTo(0, scroll);
  const log = main.querySelector(".log");
  // A log opens at its end, the part a tail is for; later renders keep the reader's place.
  if (log) log.scrollTop = logScroll ?? log.scrollHeight;
  if (focusId) {
    const again = document.getElementById(focusId);
    again?.focus({ preventScroll: true });
    if (again && selection && typeof again.setSelectionRange === "function") {
      try { again.setSelectionRange(...selection); } catch { /* a number input has no selection */ }
    }
  }
}

setRenderer(render);

// ---------- Live updates

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
}

/** One look at /v1/changes; a moved cursor reloads what the page shows. */
async function poll() {
  stopPolling();
  if (!state.session || document.visibilityState !== "visible") return;
  try {
    const { status, data } = await api(`/v1/changes${state.cursor ? `?since=${encodeURIComponent(state.cursor)}` : ""}`);
    if (status === 200 && data?.cursor && data.cursor !== state.cursor) {
      state.cursor = data.cursor;
      await refreshPage(parseRoute(location.hash));
    } else if (!state.snapshot) {
      await refreshPage(parseRoute(location.hash));
    }
    state.error = null;
  } catch (error) {
    if (error.status === 401) return;
    if (error.status === 404) return legacy();
    state.error = error.message;
  }
  render();
  if (document.visibilityState === "visible" && !pollTimer) pollTimer = setTimeout(poll, CHANGES_EVERY_MS);
}

/** The local controller: its event stream, and the snapshot every 15 s (60 s while events arrive). */
function legacy() {
  state.legacy = true;
  if (!source && "EventSource" in window) {
    source = new EventSource("/v1/events");
    source.addEventListener("ready", () => { state.live = true; });
    for (const name of LEGACY_EVENTS) {
      source.addEventListener(name, (event) => {
        let data = {};
        try { data = JSON.parse(event.data); } catch { /* keep {} */ }
        if (data.job) state.history.delete(data.job);
        if (name === "job_finished" && data.outcome === "failed") toast(`${data.job} failed`, { error: true });
        refreshPage(parseRoute(location.hash)).then(render);
      });
    }
    source.onerror = () => { state.live = false; };
  }
  const tick = async () => {
    stopPolling();
    if (!state.session || document.visibilityState !== "visible") return;
    await refreshPage(parseRoute(location.hash));
    render();
    pollTimer = setTimeout(tick, state.live ? LEGACY_POLL_LIVE_MS : LEGACY_POLL_MS);
  };
  return tick();
}

function resume() {
  if (state.legacy) return legacy();
  return poll();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") resume();
  else stopPolling();
});

window.addEventListener("online", () => resume());
window.addEventListener("offline", () => { state.offline = true; render(); });

// ---------- Routing

let lastPage = parseRoute(location.hash).page;
window.addEventListener("hashchange", () => {
  const route = parseRoute(location.hash);
  // A join token is shown once: leaving the page forgets it.
  if (lastPage === "add-machine" && route.page !== "add-machine") state.joinToken = null;
  lastPage = route.page;
  state.editing = null;
  render();
  window.scrollTo(0, 0);
  main.querySelector("h1")?.setAttribute("tabindex", "-1");
  main.querySelector("h1")?.focus({ preventScroll: true });
  if (state.snapshot) refreshPage(route).then(render);
});

// Relative times move on even when nothing else does.
setInterval(() => {
  if (state.session && !state.editing && document.visibilityState === "visible") render();
}, 30_000);

// ---------- Sign in

setSignedOutHandler((body) => {
  stopPolling();
  source?.close();
  source = null;
  state.session = null;
  showSignedOut(body ?? {});
});

function showSignedOut(info) {
  if (info.access || hosted()) {
    signedOut = h("div", { class: "login card" },
      h("h1", {}, "Signed out"),
      h("p", {}, "Your Cloudflare Access session has ended, or this login has no role here yet. Reload to sign in again."),
      info.login ? h("p", { class: "muted small" }, `Signed in as ${info.login}, which has no role. An admin can add it under Settings › Roles.`) : null,
      h("div", { class: "actions" }, h("button", { class: "primary", onclick: () => location.reload() }, "Reload")));
  } else {
    signedOut = localLogin(info);
  }
  render();
}

/** The local controller's token sign-in, as before. */
function localLogin(info = {}) {
  const expired = new URLSearchParams(location.search).get("signin") === "expired";
  const form = h("form", {
    onsubmit: async (event) => {
      event.preventDefault();
      const input = form.querySelector("input");
      const button = form.querySelector("button");
      button.disabled = true;
      try {
        const response = await fetch("/v1/session", {
          method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ token: input.value }),
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
  h("label", { class: "field" }, h("span", {}, "API token"),
    h("input", { type: "password", id: "token", autocomplete: "current-password", required: true, placeholder: "HOME_COMPUTE_API_TOKEN" })),
  h("div", { class: "actions" }, h("button", { class: "primary", type: "submit" }, "Sign in")));
  return h("div", { class: "login card" },
    h("h1", {}, "Sign in"),
    expired ? banner("That sign-in link has expired or was already used. Open the dashboard from the menu bar again, or use the token.") : null,
    info.tailscaleLogin
      ? h("p", {}, `Tailscale says you are ${info.tailscaleLogin}, but that login is not on this controller's dashboard.allowedLogins.`)
      : h("p", {}, "Over Tailscale, an allowed login is signed in automatically. Otherwise use the controller's API token (HOME_COMPUTE_API_TOKEN)."),
    info.tokenLogin === false ? h("p", {}, "This controller has no API token configured, so only Tailscale sign-in works here.") : form);
}

async function signOutLocal() {
  try {
    await api("/v1/session", { method: "DELETE" });
  } catch {
    // Signed out either way.
  }
  state.session = null;
  source?.close();
  showSignedOut({});
}

function start(session) {
  if (session.method === "access" && !session.role) {
    showSignedOut({ access: true, login: session.login });
    return;
  }
  state.session = session;
  signedOut = null;
  render();
  if (session.method === "access") poll();
  else loadSnapshot().then(() => (hosted() ? poll() : legacy()));
}

async function boot() {
  let session;
  try {
    const response = await fetch("/v1/session", { credentials: "same-origin", cache: "no-store" });
    session = await response.json();
  } catch (error) {
    main.replaceChildren(banner(navigator.onLine === false ? "You are offline. The dashboard opens again when you are back online." : `Cannot reach the control plane: ${error.message}`));
    return;
  }
  if (session.authenticated) start(session);
  else showSignedOut(session);
}

// Static files work offline (the API needs the network); see sw.js.
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
  navigator.serviceWorker.register("/sw.js").catch(() => { /* the dashboard works without it */ });
}

// For tests and people poking at the console: what the page last loaded.
window.homeCompute = { state, can, hasFeature };

boot();

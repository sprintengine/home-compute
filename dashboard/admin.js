// Settings (global pause, retention, the agent version machines should run,
// roles) and the audit log (§7.7). Secrets are M5: their page appears once
// the API has them (`secrets` in the snapshot's features).

import { relative } from "./lib.js";
import {
  api, banner, busy, can, emptyState, facts, fullTime, h, hasFeature, hosted, isBusy, loadMore, render, section, state, toast, when,
} from "./ui.js";
import { loadAudit, loadSettings, loadSnapshot } from "./data.js";

const RETENTION = [
  ["runDays", "Keep runs (days)"],
  ["keepRunsPerJob", "Always keep per job (runs)"],
  ["skippedDays", "Keep skipped slots (days)"],
  ["successLogDays", "Keep logs of successes (days)"],
  ["failureLogDays", "Keep logs of failures (days)"],
  ["auditDays", "Keep the audit log (days)"],
];

export function settingsPage() {
  const session = state.session ?? {};
  const paused = Boolean(state.snapshot.controller?.globalPause);
  if (hosted() && can("admin") && !state.settings) loadSettings();
  return h("div", { class: "page settings-page" },
    h("h1", {}, "Settings"),
    h("section", { class: "card", "aria-labelledby": "gp-title" },
      h("h2", { class: "card-title", id: "gp-title" }, "Global pause"),
      h("p", {}, paused ? "Everything is paused: every scheduled slot is recorded as skipped. Run now still works." : "Scheduled runs start on their slots."),
      can("operator") && hosted() ? h("div", { class: "actions" }, h("button", {
        class: paused ? "primary" : "danger", id: "global-pause", disabled: isBusy("global-pause"),
        onclick: () => busy("global-pause", async () => {
          try {
            await api(paused ? "/v1/resume-all" : "/v1/pause-all", { method: "POST" });
            toast(paused ? "Resumed" : "Everything is paused");
            state.settings = null;
            await loadSnapshot();
          } catch (error) {
            toast(error.message, { error: true });
          }
        }),
      }, paused ? "Resume everything" : "Pause everything")) : null),
    hosted() && can("admin") ? adminSettings() : null,
    h("section", { class: "card", "aria-labelledby": "me-title" },
      h("h2", { class: "card-title", id: "me-title" }, "You"),
      facts([
        ["Signed in as", session.login ?? "—"],
        ["Role", session.role ?? (hosted() ? "none" : "full access (local controller)")],
        ["Session ends", session.expiresAt ? `${when(session.expiresAt)} (${relative(session.expiresAt)})` : null],
      ]),
      hosted() ? h("p", { class: "small" }, h("a", { href: "/cdn-cgi/access/logout" }, "Sign out of Cloudflare Access")) : null),
    hosted() && can("admin") ? h("p", {}, h("a", { href: "#/audit" }, "Audit log ›")) : null,
    hasFeature("secrets") ? h("p", {}, h("a", { href: "#/secrets" }, "Secrets ›")) : null);
}

function adminSettings() {
  const loaded = state.settings;
  if (!loaded) return h("p", { class: "muted" }, "Loading settings…");
  if (loaded.error) return banner(`Could not load the settings: ${loaded.error}`);
  const settings = loaded.data;
  const draft = state.editing?.kind === "settings" ? state.editing : null;
  const start = () => {
    state.editing = {
      kind: "settings",
      retention: Object.fromEntries(RETENTION.map(([key]) => [key, String(settings.retention?.[key] ?? "")])),
      desiredAgentVersion: settings.desiredAgentVersion ?? "",
      roles: Object.entries(settings.roles ?? {}).map(([login, role]) => ({ login, role })),
    };
    render();
  };
  if (!draft) {
    return [
      h("section", { class: "card", "aria-labelledby": "rt-title" },
        h("div", { class: "row between" }, h("h2", { class: "card-title", id: "rt-title" }, "Retention and agents"), h("button", { class: "small-button", id: "settings-edit", onclick: start }, "Edit")),
        facts([
          ...RETENTION.map(([key, label]) => [label, settings.retention?.[key]]),
          ["Agents should run", settings.desiredAgentVersion ?? "the newest version any machine runs"],
        ])),
      h("section", { class: "card", "aria-labelledby": "rl-title" },
        h("h2", { class: "card-title", id: "rl-title" }, "Roles"),
        Object.keys(settings.roles ?? {}).length
          ? facts(Object.entries(settings.roles).map(([login, role]) => [login, role]))
          : h("p", { class: "muted small" }, "Only the bootstrap admins (BOOTSTRAP_ADMINS) have a role."),
        h("p", { class: "muted small" }, "Viewers see everything but change nothing; operators run, pause, drain and edit timetables, placement and resources; admins also edit images, machines, settings and join tokens.")),
    ];
  }
  const submit = async (event) => {
    event.preventDefault();
    const retention = {};
    for (const [key, label] of RETENTION) {
      const value = Number(draft.retention[key]);
      if (!Number.isInteger(value) || value < 1 || value > 3650) return toast(`${label}: a whole number from 1 to 3650`, { error: true });
      retention[key] = value;
    }
    const roles = {};
    for (const entry of draft.roles) {
      if (!entry.login.trim()) continue;
      roles[entry.login.trim().toLowerCase()] = entry.role;
    }
    const version = draft.desiredAgentVersion.trim();
    await busy("settings", async () => {
      try {
        const { data } = await api("/v1/settings", { method: "PATCH", body: { retention, roles, desiredAgentVersion: version || null } });
        state.settings = { data };
        state.editing = null;
        toast(data.changed?.length ? `Saved: ${data.changed.join(", ")}` : "Nothing changed");
        await loadSnapshot();
      } catch (error) {
        toast(error.message, { error: true });
      }
    });
  };
  return h("form", { class: "card form", onsubmit: submit, "aria-labelledby": "se-title", "data-edit": "settings" },
    h("h2", { class: "card-title", id: "se-title" }, "Retention, agents and roles"),
    h("div", { class: "form-grid" }, RETENTION.map(([key, label]) => h("label", { class: "field" }, h("span", {}, label),
      h("input", { type: "number", min: 1, max: 3650, step: 1, id: `rt-${key}`, value: draft.retention[key], oninput: (event) => { draft.retention[key] = event.target.value; } })))),
    h("label", { class: "field narrow" }, h("span", {}, "Agents should run version (empty: the newest enrolled)"),
      h("input", { type: "text", id: "rt-version", value: draft.desiredAgentVersion, placeholder: "0.2.0", pattern: "\\d+\\.\\d+\\.\\d+", oninput: (event) => { draft.desiredAgentVersion = event.target.value; } })),
    h("fieldset", { class: "field" }, h("legend", {}, "Roles"),
      draft.roles.map((entry, index) => h("div", { class: "row role-row" },
        h("input", { type: "text", value: entry.login, "aria-label": "Email or service:<client-id>", placeholder: "someone@example.com", oninput: (event) => { entry.login = event.target.value; } }),
        h("select", { "aria-label": `Role for ${entry.login || "this login"}`, onchange: (event) => { entry.role = event.target.value; } },
          ["viewer", "operator", "admin"].map((role) => h("option", { value: role, selected: role === entry.role }, role))),
        h("button", { type: "button", class: "small-button", "aria-label": `Remove ${entry.login || "this row"}`, onclick: () => { draft.roles.splice(index, 1); render(); } }, "Remove"))),
      h("button", { type: "button", class: "small-button", onclick: () => { draft.roles.push({ login: "", role: "viewer" }); render(); } }, "Add a login")),
    h("div", { class: "actions" },
      h("button", { class: "primary", type: "submit", disabled: isBusy("settings") }, "Save"),
      h("button", { type: "button", onclick: () => { state.editing = null; render(); } }, "Cancel")));
}

// ---------- Audit

export function auditPage() {
  if (!hosted()) return h("div", { class: "page" }, h("h1", {}, "Audit log"), banner("The audit log is part of the hosted control plane.", "info"));
  if (!can("admin")) return h("div", { class: "page" }, h("h1", {}, "Audit log"), banner("Only an admin can read the audit log."));
  if (!state.audit) loadAudit();
  const audit = state.audit;
  return h("div", { class: "page audit-page" },
    h("h1", {}, "Audit log"),
    h("p", { class: "muted small" }, "Every change people, machines and the system made, newest first. Secret values never appear here."),
    audit?.error ? banner(`Could not load the audit log: ${audit.error}`) : null,
    !audit || (!audit.entries?.length && audit.loading) ? h("p", { class: "muted" }, "Loading…")
      : audit.entries.length ? h("div", { class: "table-wrap" }, h("table", { class: "audit" },
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "When"), h("th", { scope: "col" }, "Who"), h("th", { scope: "col" }, "What"), h("th", { scope: "col" }, "Target"), h("th", { scope: "col", class: "wide" }, "Change"))),
        h("tbody", {}, audit.entries.map((entry) => h("tr", {},
          h("td", { title: fullTime.format(new Date(entry.at)) }, when(entry.at)),
          h("td", { class: "clip" }, entry.actor),
          h("td", {}, h("span", { class: "mono" }, entry.action)),
          h("td", { class: "clip mono" }, entry.target ?? ""),
          h("td", { class: "wide change" }, changeText(entry))))))) : emptyState("Nothing recorded yet."),
    audit ? loadMore({ loading: audit.loading, done: audit.next === null, load: () => loadAudit({ more: true }) }) : null);
}

/** A change in one line (before → after per field); a long one opens to the whole JSON. */
function changeText(entry) {
  const show = (value) => (value === null || value === undefined ? "" : JSON.stringify(value));
  let line;
  if (entry.before && entry.after) {
    const keys = [...new Set([...Object.keys(entry.before), ...Object.keys(entry.after)])];
    line = keys.map((key) => `${key}: ${show(entry.before[key])} → ${show(entry.after[key])}`).join("; ");
  } else {
    line = show(entry.after ?? entry.before);
  }
  if (line.length <= 140) return line;
  return h("details", {}, h("summary", {}, `${line.slice(0, 120)}…`),
    h("pre", { class: "detail" }, JSON.stringify({ before: entry.before, after: entry.after }, null, 2)));
}

export function sectionUnavailable(title) {
  return h("div", { class: "page" }, h("h1", {}, title), section(title, emptyState("Not available here.")));
}

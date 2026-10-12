// Settings (global pause, retention, the agent version machines should run,
// roles, alert email), the audit log and the vault's secrets (§7.7). The
// secrets page is write-only: it lists names, hints and labels, and a value
// typed into it goes to hc-web to be sealed and is never shown again.

import { parseLabels, relative } from "./lib.js";
import {
  api, back, banner, busy, can, emptyState, facts, fullTime, h, hasFeature, hosted, isBusy, loadMore, render, section, state, toast, when,
} from "./ui.js";
import { loadAudit, loadSecrets, loadSettings, loadSnapshot } from "./data.js";

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
    hosted() && hasFeature("alerts") ? alertsCard() : null,
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

// ---------- Alerts

function alertsCard() {
  const alerts = state.snapshot.alerts ?? {};
  const email = alerts.email ?? {};
  const cron = state.snapshot.controller?.cron;
  const resolved = alerts.resolved ?? [];
  return h("section", { class: "card", "aria-labelledby": "al-title" },
    h("h2", { class: "card-title", id: "al-title" }, "Alerts"),
    h("p", { class: "small" }, "You are emailed when a job fails twice in a row, a tracked output goes stale, no machine is online for 10 minutes or a run waits 15 minutes; again when it ends; and once a day while it lasts. A check outside Cloudflare opens a GitHub issue if the control plane stops answering or its cron stops."),
    facts([
      ["Email", email.ok === null || email.ok === undefined ? "nothing sent yet" : email.ok ? "working" : `failing: ${email.error ?? "unknown error"}`],
      ["Last email", email.lastSentAt ? `${when(email.lastSentAt)} (${relative(email.lastSentAt)})` : null],
      ["Cron", cron ? (cron.stale ? `not ticking (last ${cron.lastTickAt ? relative(cron.lastTickAt) : "never"})` : `ticking (last ${relative(cron.lastTickAt)})`) : null],
      ["Open now", String((alerts.open ?? []).length)],
    ]),
    resolved.length ? h("details", {}, h("summary", {}, `Resolved in the last day (${resolved.length})`),
      h("ul", { class: "list" }, resolved.map((alert) => h("li", {}, `${alert.summary} · ${relative(alert.openedAt)} to ${relative(alert.resolvedAt)}`)))) : null,
    can("admin") ? h("div", { class: "actions" }, h("button", {
      id: "alert-test", disabled: isBusy("alert-test"),
      onclick: () => busy("alert-test", async () => {
        try {
          await api("/v1/alerts/test", { method: "POST" });
          toast("Test alert queued: the email goes within a minute");
          await loadSnapshot();
        } catch (error) {
          toast(error.message, { error: true });
        }
      }),
    }, "Send a test alert")) : null);
}

// ---------- Secrets

export function secretsPage() {
  if (!hosted()) return h("div", { class: "page" }, h("h1", {}, "Secrets"), banner("Secrets are part of the hosted control plane.", "info"));
  if (!can("admin")) return h("div", { class: "page" }, h("h1", {}, "Secrets"), banner("Only an admin can see or set secrets."));
  if (!state.secrets) loadSecrets();
  const loaded = state.secrets;
  const data = loaded?.data;
  const draft = state.editing?.kind === "secret" ? state.editing : null;
  const start = (name = "") => {
    state.editing = { kind: "secret", name, labels: "" };
    render();
  };
  return h("div", { class: "page secrets-page" },
    back("#/settings", "Settings"),
    h("h1", {}, "Secrets"),
    h("p", { class: "muted small" }, "Values are sealed by the control plane with the vault's public key as soon as they arrive, and are only ever opened for a run on a machine whose labels the secret allows. Nothing here, or anywhere in the API, shows a value again."),
    loaded?.error ? banner(`Could not load the secrets: ${loaded.error}`) : null,
    data && !data.vault?.configured ? banner(`The vault is not configured: ${data.vault?.error ?? "hc-web has no VAULT_PUBLIC_KEY"}`) : null,
    !data ? h("p", { class: "muted" }, "Loading…") : h("div", { class: "table-wrap" }, h("table", { class: "secrets" },
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Name"), h("th", { scope: "col" }, "Hint"), h("th", { scope: "col" }, "Machines"), h("th", { scope: "col" }, "Used by"), h("th", { scope: "col" }, "Set"), h("th", { scope: "col" }, ""))),
      h("tbody", {},
        data.missing.map((secret) => h("tr", { class: "attention" },
          h("td", { class: "mono" }, secret.name), h("td", {}, h("span", { class: "chip critical" }, "not set")), h("td", {}, ""),
          h("td", { class: "used" }, secret.usedBy.join(", ")), h("td", {}, ""),
          h("td", {}, h("button", { class: "small-button", onclick: () => start(secret.name) }, "Set")))),
        data.secrets.map((secret) => h("tr", {},
          h("td", { class: "mono" }, secret.name),
          h("td", { class: "mono" }, secret.hint ?? "—"),
          h("td", { class: "labels" }, Object.keys(secret.allowedLabels).length ? Object.entries(secret.allowedLabels).map(([key, value]) => `${key}=${value}`).join(", ") : "any"),
          h("td", { class: "used" }, secret.usedBy.join(", ") || "no job"),
          h("td", { title: secret.updatedBy }, `${relative(secret.updatedAt)}${secret.staleKey ? " · older key" : ""}`),
          h("td", {}, h("button", { class: "small-button", onclick: () => start(secret.name) }, "Replace"), " ",
            h("button", {
              class: "small-button danger", disabled: isBusy(`secret-delete:${secret.name}`),
              onclick: () => {
                if (!confirm(`Delete ${secret.name}? Jobs that use it are blocked until it is set again.`)) return;
                busy(`secret-delete:${secret.name}`, async () => {
                  try {
                    await api(`/v1/secrets/${encodeURIComponent(secret.name)}`, { method: "DELETE" });
                    toast(`Deleted ${secret.name}`);
                    state.secrets = null;
                    await loadSnapshot();
                  } catch (error) {
                    toast(error.message, { error: true });
                  }
                });
              },
            }, "Delete"))))))),
    draft ? secretForm(draft) : h("div", { class: "actions" }, h("button", { class: "primary", id: "secret-add", onclick: () => start() }, "Add a secret")));
}

function secretForm(draft) {
  const submit = async (event) => {
    event.preventDefault();
    const form = event.target;
    const value = form.elements.value.value;
    let labels;
    try {
      labels = draft.labels.trim() ? parseLabels(draft.labels) : undefined;
    } catch (error) {
      return toast(error.message, { error: true });
    }
    await busy("secret", async () => {
      try {
        const { data } = await api(`/v1/secrets/${encodeURIComponent(draft.name.trim())}`, { method: "PUT", body: { value, ...(labels ? { allowedLabels: labels } : {}) } });
        form.reset();
        state.editing = null;
        state.secrets = null;
        toast(`Saved ${data.name}${data.hint ? ` (${data.hint})` : ""}`);
        await loadSnapshot();
      } catch (error) {
        toast(error.message, { error: true });
      }
    });
  };
  return h("form", { class: "card form secret-form", onsubmit: submit, autocomplete: "off", "data-edit": "secret" },
    h("h2", { class: "card-title" }, draft.name ? `Set ${draft.name}` : "Add a secret"),
    h("label", { class: "field" }, h("span", {}, "Name (lower case, digits, . _ -)"),
      h("input", { type: "text", id: "secret-name", value: draft.name, required: true, pattern: "[a-z0-9][a-z0-9._\\-]{0,62}", oninput: (event) => { draft.name = event.target.value; } })),
    h("label", { class: "field" }, h("span", {}, "Value (sent once, never shown again)"),
      h("input", { type: "password", name: "value", id: "secret-value", required: true, autocomplete: "new-password", spellcheck: "false" })),
    h("label", { class: "field" }, h("span", {}, "Only machines with labels (key=value, comma-separated; empty keeps the current ones, or any machine)"),
      h("input", { type: "text", id: "secret-labels", value: draft.labels, placeholder: "site=home", oninput: (event) => { draft.labels = event.target.value; } })),
    h("div", { class: "actions" },
      h("button", { class: "primary", type: "submit", disabled: isBusy("secret") }, "Seal and save"),
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

// Machines (§7.4): status, VM, current run, caps, labels, agent, last seen
// and clock skew; drain, edit (name, labels, caps) and revoke. A machine's
// page adds its last 24 hours: what it ran and when its VM was up. Add
// machine (§7.6) makes a join token, shown once with the install commands;
// installing over SSH is M6.

import {
  MACHINE_STATUS, capsText, duration, installCommands, labelsText, mib, parseLabels, parseTime, phaseOf, relative, runHref, vmText,
  vmUptime,
} from "./lib.js";
import {
  api, back, banner, busy, can, chip, confirmDialog, emptyState, facts, fullTime, h, hosted, isBusy, render, section, state, toast, when,
} from "./ui.js";
import { ensureMachineRuns, loadMachineRuns, loadSnapshot } from "./data.js";
import { runTable } from "./job.js";

const DAY = 86_400_000;

function statusChip(machine) {
  const spec = MACHINE_STATUS[machine.status] ?? { label: machine.status, tone: "", icon: "·" };
  return chip(spec, machine.unhealthy ?? undefined);
}

function notHosted() {
  return h("div", { class: "page" }, back("#/", "Overview"), h("h1", {}, "Machines"),
    banner("Machines are part of the hosted control plane. The local controller runs jobs on its Bacalhau nodes.", "info"));
}

export function machinesPage() {
  if (!hosted()) return notHosted();
  const machines = state.snapshot.machines ?? [];
  const now = Date.now();
  return h("div", { class: "page" },
    h("div", { class: "row between title-row" }, h("h1", { class: "grow" }, "Machines"),
      can("admin") ? h("a", { class: "button primary", href: "#/machines/add", id: "add-machine" }, "Add machine") : null),
    machines.length
      ? h("div", { class: "machine-grid" }, machines.map((machine) => machineCard(machine, now)))
      : emptyState("No machines yet. Add one to run jobs on it."));
}

function machineCard(machine, now) {
  const current = machine.currentRuns ?? [];
  return h("article", { class: `card machine ${machine.status}`, "aria-labelledby": `m-${machine.id}` },
    h("div", { class: "row between" },
      h("h2", { class: "machine-name grow", id: `m-${machine.id}` }, h("a", { href: `#/machine/${machine.id}` }, machine.name)),
      statusChip(machine)),
    facts([
      ["VM", vmText(machine, now)],
      ["Running", current.length ? current.map((run, index) => [index ? ", " : "", h("a", { href: runHref(run.id) }, `${run.job} (${run.phase})`)]) : "nothing"],
      ["Caps", capsText(machine.capacity)],
      ["Labels", labelsText(machine.labels) || "none"],
      ["Agent", [machine.agentVersion ?? "unknown", machine.updateAvailable ? h("span", { class: "chip warning small-chip" }, `update to ${machine.desiredAgentVersion}`) : null]],
      ["Last seen", machine.lastSeenAt ? relative(machine.lastSeenAt, now) : "never"],
      ["Clock", skewText(machine)],
    ]),
    machine.health?.lastError ? h("p", { class: "error-text small" }, machine.health.lastError) : null,
    can("operator") ? h("div", { class: "actions" }, drainButton(machine), h("a", { class: "button", href: `#/machine/${machine.id}` }, "Details")) : null);
}

function skewText(machine) {
  if (typeof machine.clockSkewMs !== "number") return "—";
  const seconds = Math.round(machine.clockSkewMs / 100) / 10;
  const text = Math.abs(seconds) < 1 ? "in step" : `${Math.abs(seconds)} s ${seconds > 0 ? "ahead" : "behind"}`;
  return machine.clockSkewWarning ? h("span", { class: "warn-text" }, `⚠ ${text}`) : text;
}

function drainButton(machine) {
  const draining = machine.drain;
  return h("button", {
    class: draining ? "" : "", id: `drain-${machine.name}`, disabled: isBusy(`${machine.id}:drain`) || machine.status === "revoked",
    title: draining ? "Let it claim work again" : "Finish current work, claim nothing new",
    onclick: () => busy(`${machine.id}:drain`, async () => {
      try {
        await api(`/v1/machines/${encodeURIComponent(machine.id)}`, { method: "PATCH", body: { drain: !draining } });
        toast(draining ? `${machine.name} takes work again` : `${machine.name} is draining: it finishes what it runs and claims nothing new`);
        await loadSnapshot();
      } catch (error) {
        toast(error.message, { error: true });
      }
    }),
  }, draining ? "Undrain" : "Drain");
}

// ---------- One machine

export function machinePage(id) {
  if (!hosted()) return notHosted();
  const machine = (state.snapshot.machines ?? []).find((candidate) => candidate.id === id || candidate.name === id);
  if (!machine) return h("div", { class: "page" }, back("#/machines", "Machines"), h("h1", {}, "Machine"), banner("There is no such machine; it may have been revoked."));
  ensureMachineRuns(machine.id);
  const now = Date.now();
  const timeline = state.machineRuns.get(machine.id);
  const runs = timeline?.data?.runs ?? [];
  const uptime = vmUptime(machine, now);
  const draft = state.editing?.kind === "machine" && state.editing.id === machine.id ? state.editing : null;
  return h("div", { class: "page machine-page" },
    back("#/machines", "Machines"),
    h("div", { class: "row between title-row" }, h("h1", { class: "grow" }, machine.name), statusChip(machine)),
    machine.unhealthy ? banner(`Unhealthy: ${machine.unhealthy}${machine.health?.lastError ? ` (${machine.health.lastError})` : ""}`) : null,
    machine.localDrain ? banner("Drained on the machine itself (its menu bar or status server).", "info") : null,
    can("operator") ? h("div", { class: "actions" },
      drainButton(machine),
      can("admin") && !draft ? h("button", { id: "machine-edit", onclick: () => {
        state.editing = { kind: "machine", id: machine.id, name: machine.name, labels: labelsText(machine.labels), ...capsDraft(machine.capacity) };
        render();
      } }, "Edit") : null,
      can("admin") ? h("button", { class: "danger", id: "machine-revoke", disabled: isBusy(`${machine.id}:revoke`), onclick: () => revoke(machine) }, "Revoke") : null) : null,
    draft ? editForm(machine, draft) : null,
    h("div", { class: "cards" },
      h("section", { class: "card", "aria-labelledby": "mf-title" }, h("h2", { class: "card-title", id: "mf-title" }, "Machine"),
        facts([
          ["VM", vmText(machine, now)],
          ["Boot time", typeof machine.health?.vmBootSeconds === "number" ? duration(machine.health.vmBootSeconds) : null],
          ["VM up (24 h)", machine.vm?.state ? `${duration(uptime.ms / 1000)} (${Math.round(uptime.fraction * 100)}%)` : null],
          ["Free now", machine.free ? capsText({ cpus: machine.free.cpus, memoryMiB: machine.free.memoryMiB, maxRuns: machine.free.runs }) : null],
          ["Caps", capsText(machine.capacity)],
          ["Labels", labelsText(machine.labels) || "none"],
          ["Capabilities", machine.capabilities?.length ? machine.capabilities.join(", ") : null],
          ["Agent", [machine.agentVersion ?? "unknown", machine.updateAvailable ? ` (update to ${machine.desiredAgentVersion})` : ""]],
          ["Runtime", [machine.facts?.runtime, machine.facts?.dockerVersion ?? machine.facts?.version].filter(Boolean).join(" ") || null],
          ["OS", [machine.facts?.os, machine.facts?.arch].filter(Boolean).join(" ") || null],
          ["Last seen", machine.lastSeenAt ? `${relative(machine.lastSeenAt, now)} · ${fullTime.format(new Date(machine.lastSeenAt))}` : "never"],
          ["Last IP", machine.lastIp],
          ["Clock", skewText(machine)],
          ["Enrolled", machine.enrolledAt ? fullTime.format(new Date(machine.enrolledAt)) : null],
          ["Credential", machine.rotationPending ? "rotation pending" : machine.credentialIssuedAt ? `issued ${relative(machine.credentialIssuedAt, now)}` : null],
        ])),
      h("section", { class: "card wide-card", "aria-labelledby": "mt-title" }, h("h2", { class: "card-title", id: "mt-title" }, "Last 24 hours"),
        dayTimeline(machine, runs, uptime, now),
        timeline?.error ? banner(`Could not load its runs: ${timeline.error}`) : null)),
    section(`Runs in the last 24 hours${runs.length ? ` (${runs.length})` : ""}`,
      runs.length ? runTable(runs, { showJob: true }) : timeline ? emptyState("It ran nothing in the last day.") : h("p", { class: "muted" }, "Loading…")));
}

function capsDraft(capacity) {
  return {
    cpus: capacity?.cpus === undefined ? "" : String(capacity.cpus),
    memoryMiB: capacity?.memoryMiB === undefined ? "" : String(capacity.memoryMiB),
    diskMiB: capacity?.diskMiB === undefined ? "" : String(capacity.diskMiB),
    maxRuns: capacity?.maxRuns === undefined ? "" : String(capacity.maxRuns),
  };
}

function editForm(machine, draft) {
  const field = (key, label, attributes = {}) => h("label", { class: "field narrow" }, h("span", {}, label),
    h("input", { type: "number", min: 0, id: `me-${key}`, value: draft[key], inputmode: "decimal", oninput: (event) => { draft[key] = event.target.value; }, ...attributes }));
  const submit = async (event) => {
    event.preventDefault();
    let labels;
    try {
      labels = parseLabels(draft.labels);
    } catch (error) {
      return toast(`Labels: ${error.message}`, { error: true });
    }
    const capacity = {};
    for (const key of ["cpus", "memoryMiB", "diskMiB", "maxRuns"]) {
      if (String(draft[key]).trim() === "") continue;
      const value = Number(draft[key]);
      if (!Number.isFinite(value) || value < 0) return toast(`${key} must be a number`, { error: true });
      capacity[key] = value;
    }
    await busy(`${machine.id}:edit`, async () => {
      try {
        await api(`/v1/machines/${encodeURIComponent(machine.id)}`, { method: "PATCH", body: { name: draft.name.trim(), labels, capacity } });
        toast("Saved");
        state.editing = null;
        await loadSnapshot();
      } catch (error) {
        toast(error.message, { error: true });
      }
    });
  };
  return h("form", { class: "card form", "data-edit": "machine", onsubmit: submit },
    h("label", { class: "field" }, h("span", {}, "Name"), h("input", { type: "text", id: "me-name", value: draft.name, required: true, pattern: "[a-z0-9][a-z0-9-]{0,62}", autocomplete: "off", spellcheck: "false", oninput: (event) => { draft.name = event.target.value; } })),
    h("label", { class: "field" }, h("span", {}, "Labels (key=value, comma-separated)"), h("input", { type: "text", id: "me-labels", value: draft.labels, autocomplete: "off", spellcheck: "false", oninput: (event) => { draft.labels = event.target.value; } })),
    h("fieldset", { class: "field" }, h("legend", {}, "Caps (empty: the agent's own figures)"),
      h("div", { class: "row" }, field("cpus", "CPU", { step: 0.5 }), field("memoryMiB", "Memory (MiB)", { step: 256 }), field("diskMiB", "Disk (MiB)", { step: 1024 }), field("maxRuns", "Runs at once", { step: 1 }))),
    h("div", { class: "actions" },
      h("button", { class: "primary", type: "submit", disabled: isBusy(`${machine.id}:edit`) }, "Save"),
      h("button", { type: "button", onclick: () => { state.editing = null; render(); } }, "Cancel")));
}

async function revoke(machine) {
  const sure = await confirmDialog({
    title: `Revoke ${machine.name}?`, confirm: "Revoke", danger: true, typeToConfirm: machine.name,
    body: [
      h("p", {}, "Its credential stops working at once: it claims nothing more, finishes what it runs and keeps the results until it is enrolled again."),
      h("p", {}, "To use the machine again, make a join token and enrol it."),
    ],
  });
  if (!sure) return;
  await busy(`${machine.id}:revoke`, async () => {
    try {
      await api(`/v1/machines/${encodeURIComponent(machine.id)}`, { method: "DELETE" });
      toast(`${machine.name} revoked`);
      await loadSnapshot();
      location.hash = "#/machines";
    } catch (error) {
      toast(error.message, { error: true });
    }
  });
}

/** 24 hours as one track: VM spans behind, runs on top (outcome by colour, with a word in each tooltip). */
function dayTimeline(machine, runs, uptime, now) {
  const width = 720;
  const height = 64;
  const start = now - DAY;
  const x = (time) => Math.round(((time - start) / DAY) * width * 10) / 10;
  const ticks = [];
  const firstTick = Math.ceil(start / (6 * 3_600_000)) * 6 * 3_600_000;
  for (let time = firstTick; time <= now; time += 6 * 3_600_000) ticks.push(time);
  const lanes = runs.map((run) => {
    const from = Math.max(start, parseTime(run.startedAt) ?? parseTime(run.claimedAt) ?? start);
    const to = Math.min(now, parseTime(run.finishedAt) ?? now);
    const phase = phaseOf(run);
    const tone = run.outcome === "failed" || ["failed", "timed-out", "lost"].includes(phase) ? "failed" : run.finishedAt ? "ok" : "active";
    return { run, from, to, tone };
  });
  const label = `${machine.name} over the last 24 hours: VM up ${Math.round(uptime.fraction * 100)}% of the time; ${runs.length} run${runs.length === 1 ? "" : "s"}`;
  return h("div", { class: "day-timeline" },
    h("svg", { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", class: "day", role: "img", "aria-label": label },
      h("title", {}, label),
      h("rect", { x: 0, y: 8, width, height: 18, class: "track" }),
      uptime.spans.map((span) => h("rect", { x: x(span.from), y: 8, width: Math.max(1, x(span.to) - x(span.from)), height: 18, class: "vm-span" },
        h("title", {}, `VM up ${when(span.from)}–${when(span.to)} (${duration((span.to - span.from) / 1000)})`))),
      h("rect", { x: 0, y: 34, width, height: 18, class: "track" }),
      lanes.map(({ run, from, to, tone }) => h("rect", { x: Math.min(x(from), width - 3), y: 34, width: Math.max(3, x(to) - x(from)), height: 18, rx: 1, class: `run-span ${tone}` },
        h("title", {}, `${run.job} · ${when(from)} · ${duration((to - from) / 1000)} · ${tone === "failed" ? "failed" : tone === "active" ? "running" : "succeeded"}`))),
      ticks.map((time) => h("line", { x1: x(time), x2: x(time), y1: 4, y2: 56, class: "tick" }))),
    h("div", { class: "day-axis", "aria-hidden": "true" },
      h("span", {}, "24 h ago"), ticks.map((time) => h("span", { class: "tick-label", "data-left": Math.round(((time - start) / DAY) * 1000) / 10 }, `${new Date(time).toISOString().slice(11, 16)} UTC`)), h("span", {}, "now")),
    h("div", { class: "legend small" },
      h("span", {}, h("span", { class: "key vm" }), "VM up"),
      h("span", {}, h("span", { class: "key ok" }), "run succeeded"),
      h("span", {}, h("span", { class: "key failed" }), "failed"),
      h("span", {}, h("span", { class: "key active" }), "running")));
}

// ---------- Add a machine

export function addMachinePage() {
  if (!hosted()) return notHosted();
  if (!can("admin")) return h("div", { class: "page" }, back("#/machines", "Machines"), h("h1", {}, "Add machine"), banner("Only an admin can add machines."));
  const token = state.joinToken;
  return h("div", { class: "page add-machine" },
    back("#/machines", "Machines"),
    h("h1", {}, "Add machine"),
    token ? tokenView(token) : tokenForm(),
    h("section", { class: "card muted-card", "aria-labelledby": "ssh-title" },
      h("h2", { class: "card-title", id: "ssh-title" }, "Install over SSH ", chip({ label: "Coming in M6", tone: "off", icon: "◷" })),
      h("p", { class: "muted small" }, "The provisioner machine will install and enrol a tailnet host for you, with live steps here. Until then, install by hand with a join token.")));
}

function tokenForm() {
  const draft = state.editing?.kind === "join-token" ? state.editing : (state.editing = { kind: "join-token", name: "", labels: "", ttl: "60" });
  const submit = async (event) => {
    event.preventDefault();
    let labels;
    try {
      labels = parseLabels(draft.labels);
    } catch (error) {
      return toast(`Labels: ${error.message}`, { error: true });
    }
    await busy("join-token", async () => {
      try {
        const { data } = await api("/v1/join-tokens", { method: "POST", body: { ...(draft.name.trim() ? { name: draft.name.trim() } : {}), labels, ttlMinutes: Number(draft.ttl) } });
        state.joinToken = data;
        state.editing = null;
      } catch (error) {
        toast(error.message, { error: true });
      }
    });
  };
  return h("form", { class: "card form", onsubmit: submit, "aria-labelledby": "jt-title" },
    h("h2", { class: "card-title", id: "jt-title" }, "1. Make a join token"),
    h("p", { class: "muted small" }, "A join token enrols one machine, once, within its lifetime. Its name and labels win over what the agent says about itself."),
    h("label", { class: "field" }, h("span", {}, "Machine name"), h("input", { type: "text", id: "jt-name", value: draft.name, placeholder: "linux-box", pattern: "[a-z0-9][a-z0-9-]{0,62}", autocomplete: "off", spellcheck: "false", "aria-describedby": "jt-name-hint", oninput: (event) => { draft.name = event.target.value; } }),
      h("span", { class: "muted small", id: "jt-name-hint" }, "Lower-case letters, digits and dashes. Empty: the machine's host name.")),
    h("label", { class: "field" }, h("span", {}, "Labels (optional)"), h("input", { type: "text", id: "jt-labels", value: draft.labels, placeholder: "site=home", autocomplete: "off", spellcheck: "false", oninput: (event) => { draft.labels = event.target.value; } })),
    h("label", { class: "field narrow" }, h("span", {}, "Valid for (minutes)"), h("input", { type: "number", id: "jt-ttl", min: 1, max: 1440, value: draft.ttl, oninput: (event) => { draft.ttl = event.target.value; } })),
    h("div", { class: "actions" }, h("button", { class: "primary", type: "submit", id: "jt-create", disabled: isBusy("join-token") }, "Make join token")));
}

function copyButton(text, label, id) {
  return h("button", {
    type: "button", class: "small-button", id,
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast(`${label} copied`);
      } catch {
        toast("Copying needs a secure page; select the text instead", { error: true });
      }
    },
  }, "Copy");
}

function commandCard(key, title, note, steps) {
  return h("section", { class: "card", "aria-labelledby": `${key}-title` },
    h("h2", { class: "card-title", id: `${key}-title` }, title),
    h("p", { class: "muted small" }, note),
    steps.map((step, index) => h("div", { class: "command-step" },
      h("div", { class: "row between" }, h("h3", { class: "step-title" }, `${String.fromCharCode(97 + index)}. ${step.title}`), copyButton(step.text, `${step.title.split(":")[0]} commands`, `copy-${key}-${index}`)),
      h("pre", { class: "commands", tabindex: "0", "aria-label": `${title}: ${step.title}` }, step.text))));
}

function tokenView(token) {
  const server = token.server ?? token.enrolCommand?.match(/--server (\S+)/)?.[1] ?? null;
  const commands = installCommands(server && !server.startsWith("<") ? server : null);
  const expires = Date.parse(token.expiresAt);
  return h("div", { class: "stack" },
    h("section", { class: "card token-card", "aria-labelledby": "tk-title" },
      h("h2", { class: "card-title", id: "tk-title" }, `1. Join token${token.name ? ` for ${token.name}` : ""}`),
      banner(`Shown once: copy it now. It works once, until ${when(expires)} (${relative(expires)}), and is not stored anywhere readable.`, "warning"),
      h("div", { class: "token-row" },
        h("input", { type: "text", readonly: true, id: "join-token", class: "mono", value: token.token, "aria-label": "Join token", onfocus: (event) => event.target.select() }),
        copyButton(token.token, "Token", "copy-token")),
      token.labels && Object.keys(token.labels).length ? h("p", { class: "muted small" }, `Labels: ${labelsText(token.labels)}`) : null),
    commandCard("macos", "2. On a Mac", "The agent runs as you, as a LaunchAgent; Colima starts its own VM only when work is due.", commands.macos),
    commandCard("linux", "2. On Linux (systemd)", "The agent runs as hcagent under systemd; its containers run in home-compute.slice.", commands.linux),
    commandCard("linux-nodocker", "2. On Linux without Docker", "The agent runs as hcagent in the foreground (under tini when there is no systemd) and runs each image as a process.", commands.linuxNodocker),
    h("p", { class: "muted small" }, "The machine appears under Machines after its first sync, usually within 30 seconds. These steps are in agent/README.md, “Install by hand”."),
    h("div", { class: "actions" },
      h("button", { class: "primary", id: "token-done", onclick: () => { state.joinToken = null; location.hash = "#/machines"; } }, "Done: forget the token")));
}

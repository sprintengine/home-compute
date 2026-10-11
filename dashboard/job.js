// A job's page (§7.2): run now (with extra arguments), pause/resume and
// enable; the timetable editor (hour chips, minute chips, every hour);
// placement; resources with a peak-memory hint; the image and its digest;
// and the run history, loaded a page at a time as it scrolls.

import {
  LOCAL_NAME, LOCAL_ZONE, clockIn, duration, jobState, labelsText, localScheduleText, memoryChoices, memoryHint, mib, modelRun, parseArgs,
  parseLabels, peakMiB, phaseOf, pinnedImage, relative, runHref, scheduleText,
} from "./lib.js";
import {
  api, back, banner, busy, can, chip, emptyState, facts, fullTime, h, hosted, isBusy, loadMore, render, runChip, section, state,
  stateChip, toast, when,
} from "./ui.js";
import { ensureHistory, ensureJob, loadHistory, loadJob, loadSnapshot } from "./data.js";

const MINUTE_CHIPS = Array.from({ length: 12 }, (_, index) => index * 5);

function editing(kind, id) {
  return state.editing?.kind === kind && state.editing.job === id ? state.editing : null;
}

function startEditing(draft) {
  state.editing = draft;
  render();
  queueMicrotask(() => document.querySelector(`[data-edit="${draft.kind}"] input, [data-edit="${draft.kind}"] button`)?.focus());
}

function stopEditing() {
  state.editing = null;
  render();
}

/** Saves a change and refreshes what shows it; returns true when it worked. */
async function save(key, path, body, message, { method = "PATCH", job } = {}) {
  return busy(key, async () => {
    try {
      const { data } = await api(path, { method, body });
      toast(typeof message === "function" ? message(data) : message);
      state.editing = null;
      if (job) {
        await Promise.all([loadSnapshot(), hosted() ? loadJob(job) : null, loadHistory(job)]);
      } else {
        await loadSnapshot();
      }
      return true;
    } catch (error) {
      toast(error.message, { error: true });
      return false;
    }
  });
}

export function jobPage(id) {
  const job = (state.snapshot.jobs ?? []).find((candidate) => candidate.id === id);
  if (!job) return h("div", { class: "page" }, back("#/", "Overview"), h("h1", {}, id), banner(`There is no job called ${id}.`));
  ensureJob(id);
  ensureHistory(id);
  const definition = state.jobs.get(id)?.data ?? null;
  const history = state.history.get(id);
  return h("div", { class: "page job-page" },
    back("#/", "Overview"),
    h("div", { class: "row between title-row" }, h("h1", { class: "grow" }, job.id), job.blocked ? chip({ label: "Blocked", tone: "warning", icon: "⊘" }) : null, job.blocked && jobState(job) === "idle" ? null : stateChip(job)),
    job.description ? h("p", { class: "job-desc" }, job.description) : null,
    job.blocked ? banner(`Blocked: ${job.blocked}. Its runs wait until then.`, "warning") : null,
    job.lastOutcome === "failed" && job.lastError ? banner(`Last run failed: ${job.lastError}`) : null,
    job.waiting ? banner(job.waiting.replace(/^waiting/, "Waiting"), "info") : null,
    controls(job),
    h("div", { class: "cards" },
      timetableCard(job),
      definition ? placementCard(job, definition) : null,
      definition ? resourcesCard(job, definition, history?.runs ?? []) : null,
      definition ? imageCard(job, definition, history?.runs ?? []) : null,
      publishedCard(job)),
    historySection(job, history));
}

// ---------- Controls

function controls(job) {
  if (!can("operator")) return h("p", { class: "muted small" }, "You can look but not change anything (viewer).");
  const draft = editing("run", job.id);
  const runBusy = isBusy(`${job.id}:run`);
  const configuredOff = job.configuredEnabled === false;
  return h("div", {},
    h("div", { class: "actions" },
      h("button", { class: "primary", id: "run-now", "aria-expanded": String(Boolean(draft)), disabled: runBusy || job.phase === "due",
        onclick: () => (draft ? stopEditing() : startEditing({ kind: "run", job: job.id, args: "", force: false })) }, runBusy ? "Submitting…" : "Run now…"),
      job.paused
        ? h("button", { disabled: isBusy(`${job.id}:resume`), onclick: () => save(`${job.id}:resume`, `/v1/jobs/${encodeURIComponent(job.id)}/resume`, {}, `${job.id} resumed`, { method: "POST" }) }, "Resume")
        : h("button", { disabled: isBusy(`${job.id}:pause`) || configuredOff, onclick: () => save(`${job.id}:pause`, `/v1/jobs/${encodeURIComponent(job.id)}/pause`, {}, `${job.id} paused: scheduled slots are skipped`, { method: "POST" }) }, "Pause"),
      h("button", {
        disabled: isBusy(`${job.id}:enable`),
        onclick: () => save(`${job.id}:enable`, `/v1/jobs/${encodeURIComponent(job.id)}/timetable`, { enabled: configuredOff }, configuredOff ? `${job.id} enabled` : `${job.id} switched off`, { method: hosted() ? "PATCH" : "POST", job: job.id }),
      }, configuredOff ? "Enable" : "Switch off")),
    draft ? runForm(job, draft) : null);
}

function runForm(job, draft) {
  const args = parseArgs(draft.args);
  const submit = async (event) => {
    event.preventDefault();
    const ok = await save(`${job.id}:run`, `/v1/jobs/${encodeURIComponent(job.id)}/run`,
      { ...(args.length ? { extraParameters: args } : {}), ...(draft.force ? { force: true } : {}) },
      (data) => `${job.id} submitted${data?.runId ? `: it waits for a machine` : ""}`, { method: "POST", job: job.id });
    if (ok) state.editing = null;
  };
  return h("form", { class: "card form", "data-edit": "run", onsubmit: submit },
    h("label", { class: "field" },
      h("span", {}, "Extra arguments (optional)"),
      h("input", { type: "text", id: "run-args", value: draft.args, autocomplete: "off", spellcheck: "false", placeholder: "--models ecmwf",
        oninput: (event) => { draft.args = event.target.value; render(); } })),
    h("p", { class: "muted small" }, args.length ? `Appended to the job's arguments: ${args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}` : "The job runs with its own arguments."),
    job.running && job.phase !== "due" ? h("label", { class: "check" }, h("input", { type: "checkbox", checked: draft.force, onchange: (event) => { draft.force = event.target.checked; } }), "Run beside the active run") : null,
    h("div", { class: "actions" },
      h("button", { class: "primary", type: "submit", id: "run-submit", disabled: isBusy(`${job.id}:run`) }, "Run now"),
      h("button", { type: "button", onclick: stopEditing }, "Cancel")));
}

// ---------- Timetable

function timetableCard(job) {
  const draft = editing("timetable", job.id);
  const editable = can("operator") && job.schedule?.at && state.snapshot.timetable?.editable !== false;
  const local = localScheduleText(job.schedule);
  return h("section", { class: "card", "aria-labelledby": "tt-title", "data-edit": draft ? "timetable" : undefined },
    h("div", { class: "row between" }, h("h2", { id: "tt-title", class: "card-title" }, "Timetable"),
      editable && !draft ? h("button", { class: "small-button", id: "tt-edit", onclick: () => startEditing(timetableDraft(job)) }, "Edit") : null),
    draft ? timetableForm(job, draft) : [
      h("p", { class: "schedule-text" }, job.configuredEnabled === false ? "Off in the timetable" : scheduleText(job.schedule)),
      local && job.configuredEnabled !== false ? h("p", { class: "muted small" }, local) : null,
      job.nextDueAt ? h("p", { class: "muted small" }, `Next ${when(job.nextDueAt)} (${relative(job.nextDueAt)})`) : null,
      job.schedule?.every ? h("p", { class: "muted small" }, "An interval job counts from its last run; only Enable applies to it.") : null,
    ]);
}

function timetableDraft(job) {
  const at = job.schedule?.at ?? {};
  return {
    kind: "timetable", job: job.id, enabled: job.configuredEnabled !== false, everyHour: !at.hours,
    hours: new Set(at.hours ?? []), minutes: new Set(at.minutes ?? [0]),
  };
}

function timetableForm(job, draft) {
  const busyNow = isBusy(`${job.id}:timetable`);
  const toggle = (set, value) => () => { if (set.has(value)) set.delete(value); else set.add(value); render(); };
  const minuteChips = [...new Set([...MINUTE_CHIPS, ...draft.minutes])].sort((a, b) => a - b);
  const preview = previewTimes(draft);
  const submit = (event) => {
    event.preventDefault();
    if (!draft.everyHour && !draft.hours.size) return toast("Choose at least one hour, or every hour", { error: true });
    if (!draft.minutes.size) return toast("Choose at least one minute", { error: true });
    const before = timetableDraft(job);
    const changes = {};
    if (draft.enabled !== before.enabled) changes.enabled = draft.enabled;
    const hours = draft.everyHour ? "every" : [...draft.hours].sort((a, b) => a - b);
    const beforeHours = before.everyHour ? "every" : [...before.hours].sort((a, b) => a - b);
    if (JSON.stringify(hours) !== JSON.stringify(beforeHours)) changes.hours = hours;
    const minutes = [...draft.minutes].sort((a, b) => a - b);
    if (JSON.stringify(minutes) !== JSON.stringify([...before.minutes].sort((a, b) => a - b))) changes.minutes = minutes;
    if (!Object.keys(changes).length) return stopEditing();
    save(`${job.id}:timetable`, `/v1/jobs/${encodeURIComponent(job.id)}/timetable`, changes, "Timetable saved", { method: hosted() ? "PATCH" : "POST", job: job.id });
  };
  return h("form", { class: "form", onsubmit: submit },
    h("label", { class: "check" }, h("input", { type: "checkbox", id: "tt-enabled", checked: draft.enabled, onchange: (event) => { draft.enabled = event.target.checked; render(); } }), "Enabled"),
    h("fieldset", { class: "field" },
      h("legend", {}, "Hours (UTC)"),
      h("label", { class: "check" }, h("input", { type: "checkbox", id: "tt-every", checked: draft.everyHour, onchange: (event) => { draft.everyHour = event.target.checked; render(); } }), "Every hour"),
      h("div", { class: "chips hours", role: "group", "aria-label": "Hours, UTC" }, Array.from({ length: 24 }, (_, hour) => h("button", {
        type: "button", "aria-pressed": String(!draft.everyHour && draft.hours.has(hour)), disabled: draft.everyHour, "aria-label": `${pad2(hour)}:00 UTC`,
        onclick: toggle(draft.hours, hour),
      }, pad2(hour))))),
    h("fieldset", { class: "field" },
      h("legend", {}, "Minutes past the hour"),
      h("div", { class: "chips minutes", role: "group", "aria-label": "Minutes" }, minuteChips.map((minute) => h("button", {
        type: "button", "aria-pressed": String(draft.minutes.has(minute)), "aria-label": `minute ${minute}`, onclick: toggle(draft.minutes, minute),
      }, `:${pad2(minute)}`)))),
    h("p", { class: "muted small", "aria-live": "polite" }, preview),
    h("div", { class: "actions" },
      h("button", { class: "primary", type: "submit", id: "tt-save", disabled: busyNow }, busyNow ? "Saving…" : "Save"),
      h("button", { type: "button", disabled: busyNow, onclick: stopEditing }, "Cancel")));
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function previewTimes(draft) {
  if (!draft.enabled) return "Off: no slots will run.";
  const minutes = [...draft.minutes].sort((a, b) => a - b);
  if (!minutes.length) return "Choose a minute.";
  if (draft.everyHour) return `Every hour at ${minutes.map((minute) => `:${pad2(minute)}`).join(", ")} (the same minutes in ${LOCAL_NAME}).`;
  const hours = [...draft.hours].sort((a, b) => a - b);
  if (!hours.length) return "Choose an hour.";
  const day = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  const slots = hours.flatMap((hour) => minutes.map((minute) => day + (hour * 60 + minute) * 60_000));
  const utc = slots.map((slot) => clockIn(slot)).join(", ");
  const local = slots.map((slot) => clockIn(slot, LOCAL_ZONE)).join(", ");
  return `${slots.length} slot${slots.length === 1 ? "" : "s"} a day: ${utc} UTC${local === utc ? "" : ` · ${local} ${LOCAL_NAME}`}.`;
}

// ---------- Placement

function placementCard(job, definition) {
  const draft = editing("placement", job.id);
  const placement = definition.placement ?? {};
  const machines = state.snapshot.machines ?? [];
  return h("section", { class: "card", "aria-labelledby": "pl-title", "data-edit": draft ? "placement" : undefined },
    h("div", { class: "row between" }, h("h2", { id: "pl-title", class: "card-title" }, "Placement"),
      can("operator") && !draft ? h("button", { class: "small-button", id: "pl-edit", onclick: () => startEditing({
        kind: "placement", job: job.id, labels: labelsText(placement.requireLabels), prefer: new Set(placement.preferMachines ?? []),
        waitMinutes: String(Math.round((placement.preferWaitSeconds ?? 300) / 60)),
      }) }, "Edit") : null),
    draft ? placementForm(job, draft, machines) : facts([
      ["Needs labels", labelsText(placement.requireLabels) || "any machine"],
      ["Prefers", placement.preferMachines?.length ? placement.preferMachines.join(", ") : "no machine in particular"],
      ["Waits for it", placement.preferMachines?.length ? `${Math.round((placement.preferWaitSeconds ?? 300) / 60)} min, then any machine` : null],
    ]));
}

function placementForm(job, draft, machines) {
  const names = [...new Set([...machines.map((machine) => machine.name), ...draft.prefer])];
  const submit = (event) => {
    event.preventDefault();
    let requireLabels;
    try {
      requireLabels = parseLabels(draft.labels);
    } catch (error) {
      return toast(`Labels: ${error.message}`, { error: true });
    }
    const minutes = Number(draft.waitMinutes);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) return toast("The wait is whole minutes from 0 to 1440", { error: true });
    save(`${job.id}:placement`, `/v1/jobs/${encodeURIComponent(job.id)}/placement`, {
      requireLabels, preferMachines: [...draft.prefer], preferWaitSeconds: minutes * 60,
    }, "Placement saved", { job: job.id });
  };
  return h("form", { class: "form", onsubmit: submit },
    h("label", { class: "field" }, h("span", {}, "Required labels (key=value, comma-separated)"),
      h("input", { type: "text", id: "pl-labels", value: draft.labels, autocomplete: "off", spellcheck: "false", placeholder: "arch=arm64", oninput: (event) => { draft.labels = event.target.value; } })),
    h("fieldset", { class: "field" }, h("legend", {}, "Preferred machine"),
      names.length ? names.map((name) => h("label", { class: "check" }, h("input", { type: "checkbox", checked: draft.prefer.has(name),
        onchange: (event) => { if (event.target.checked) draft.prefer.add(name); else draft.prefer.delete(name); } }), name))
        : h("p", { class: "muted small" }, "No machines enrolled yet.")),
    h("label", { class: "field narrow" }, h("span", {}, "Wait for a preferred machine (minutes)"),
      h("input", { type: "number", id: "pl-wait", min: 0, max: 1440, step: 1, inputmode: "numeric", value: draft.waitMinutes, oninput: (event) => { draft.waitMinutes = event.target.value; } })),
    h("div", { class: "actions" },
      h("button", { class: "primary", type: "submit", disabled: isBusy(`${job.id}:placement`) }, "Save"),
      h("button", { type: "button", onclick: stopEditing }, "Cancel")));
}

// ---------- Resources

function resourcesCard(job, definition, runs) {
  const draft = editing("resources", job.id);
  const resources = definition.resources ?? {};
  const hint = memoryHint(runs, resources.memoryMiB);
  return h("section", { class: "card", "aria-labelledby": "rs-title", "data-edit": draft ? "resources" : undefined },
    h("div", { class: "row between" }, h("h2", { id: "rs-title", class: "card-title" }, "Resources"),
      can("operator") && !draft ? h("button", { class: "small-button", id: "rs-edit", onclick: () => startEditing({
        kind: "resources", job: job.id, cpus: String(resources.cpus ?? 1), memoryMiB: resources.memoryMiB, diskMiB: String(resources.diskMiB ?? ""),
      }) }, "Edit") : null),
    draft ? resourcesForm(job, draft, hint) : [
      facts([["CPU", resources.cpus], ["Memory", mib(resources.memoryMiB)], ["Disk", mib(resources.diskMiB)]]),
      h("p", { class: `muted small hint${hint.peak && hint.peak > resources.memoryMiB * 0.9 ? " warn" : ""}` }, hint.text),
    ]);
}

function resourcesForm(job, draft, hint) {
  const low = hint.peak !== null && draft.memoryMiB < hint.peak * 1.1;
  const submit = (event) => {
    event.preventDefault();
    const cpus = Number(draft.cpus);
    const diskMiB = Number(draft.diskMiB);
    if (!(cpus > 0 && cpus <= 64)) return toast("CPU is a number above 0, at most 64", { error: true });
    if (!Number.isInteger(diskMiB) || diskMiB < 1) return toast("Disk is whole MiB", { error: true });
    save(`${job.id}:resources`, `/v1/jobs/${encodeURIComponent(job.id)}/resources`, { cpus, memoryMiB: draft.memoryMiB, diskMiB }, "Resources saved", { job: job.id });
  };
  return h("form", { class: "form", onsubmit: submit },
    h("fieldset", { class: "field" }, h("legend", {}, "Memory limit"),
      h("div", { class: "chips memory", role: "group", "aria-label": "Memory limit" }, memoryChoices(draft.memoryMiB).map((size) => h("button", {
        type: "button", "aria-pressed": String(draft.memoryMiB === size), onclick: () => { draft.memoryMiB = size; render(); },
      }, mib(size)))),
      h("p", { class: `small hint${low ? " warn" : " muted"}`, id: "rs-hint", "aria-live": "polite" },
        `${hint.text.replace(/; limit .*$/, "")}; limit ${mib(draft.memoryMiB)}`, low ? " · below the peak plus 10%: the run may be killed for memory" : "")),
    h("div", { class: "row" },
      h("label", { class: "field narrow" }, h("span", {}, "CPU"), h("input", { type: "number", id: "rs-cpus", min: 0.25, max: 64, step: 0.25, value: draft.cpus, oninput: (event) => { draft.cpus = event.target.value; } })),
      h("label", { class: "field narrow" }, h("span", {}, "Disk (MiB)"), h("input", { type: "number", id: "rs-disk", min: 1, step: 1, value: draft.diskMiB, oninput: (event) => { draft.diskMiB = event.target.value; } }))),
    h("div", { class: "actions" },
      h("button", { class: "primary", type: "submit", disabled: isBusy(`${job.id}:resources`) }, "Save"),
      h("button", { type: "button", onclick: stopEditing }, "Cancel")));
}

// ---------- Image and definition

function imageCard(job, definition, runs) {
  const draft = editing("image", job.id);
  const lastDigest = runs.find((run) => run.imageDigest)?.imageDigest ?? null;
  const pin = pinnedImage(definition.image, lastDigest);
  const secretRefs = Object.entries(definition.secretEnv ?? {});
  return h("section", { class: "card wide-card", "aria-labelledby": "im-title", "data-edit": draft ? "image" : undefined },
    h("div", { class: "row between" }, h("h2", { id: "im-title", class: "card-title" }, "Image and definition"),
      can("admin") && !draft ? h("button", { class: "small-button", id: "im-edit", onclick: () => startEditing({ kind: "image", job: job.id, image: definition.image }) }, "Edit image") : null),
    draft ? h("form", { class: "form", onsubmit: (event) => {
      event.preventDefault();
      save(`${job.id}:image`, `/v1/jobs/${encodeURIComponent(job.id)}/image`, { image: draft.image.trim() }, "Image saved", { job: job.id });
    } },
    h("label", { class: "field" }, h("span", {}, "Image (prefer repo@sha256:…)"), h("input", { type: "text", id: "im-image", value: draft.image, spellcheck: "false", autocomplete: "off", oninput: (event) => { draft.image = event.target.value; } })),
    h("div", { class: "actions" }, h("button", { class: "primary", type: "submit" }, "Save"), h("button", { type: "button", onclick: stopEditing }, "Cancel"))) : null,
    facts([
      ["Image", h("span", { class: "mono" }, definition.image)],
      ["Last ran", lastDigest ? h("span", { class: "mono" }, lastDigest) : "no digest recorded yet"],
      ["Arguments", definition.args?.length ? h("span", { class: "mono" }, definition.args.join(" ")) : "none"],
      ["Entrypoint", definition.entrypoint ? h("span", { class: "mono" }, definition.entrypoint.join(" ")) : null],
      ["Environment", Object.keys(definition.env ?? {}).join(", ") || "none"],
      ["Secrets", secretRefs.length ? secretRefs.map(([name, ref]) => `${name} ← ${ref}`).join(", ") : "none"],
      ["Run timeout", definition.timeouts?.runSeconds ? duration(definition.timeouts.runSeconds) : null],
      ["Policy", definition.policy ? `${definition.policy.overlap ?? "coalesce"} · catch-up ${definition.policy.catchUp ?? "latest"}${definition.policy.retry ? ` · ${definition.policy.retry.maxAttempts ?? 3} attempts` : ""}` : null],
      ["Reports", definition.report ? `${definition.report.format}, tracking ${definition.report.trackEvent} by ${definition.report.trackBy}` : null],
      ["Network", definition.network],
      ["Revision", `${definition.revision}${definition.updatedBy ? ` · ${definition.updatedBy}` : ""}${definition.updatedAt ? ` · ${relative(definition.updatedAt)}` : ""}${definition.preset ? ` · preset ${definition.preset}` : ""}`],
    ]),
    pin && can("admin") ? h("div", { class: "actions" }, h("button", {
      id: "im-pin", disabled: isBusy(`${job.id}:image`),
      onclick: () => save(`${job.id}:image`, `/v1/jobs/${encodeURIComponent(job.id)}/image`, { image: pin }, "Pinned to the digest that last ran", { job: job.id }),
    }, "Pin to the digest that last ran")) : null);
}

function publishedCard(job) {
  const entries = Object.entries(job.published ?? {});
  if (!entries.length) return null;
  return h("section", { class: "card", "aria-labelledby": "pb-title" },
    h("h2", { id: "pb-title", class: "card-title" }, "Last published"),
    facts(entries.map(([model, entry]) => [model, [modelRun(entry.run), entry.at ? h("span", { class: "muted" }, ` · ${relative(entry.at)}`) : null]])));
}

// ---------- History

function historySection(job, history) {
  const runs = history?.runs ?? job.recentRuns ?? [];
  return section("Run history",
    history?.error ? banner(`Could not load the history: ${history.error}`) : null,
    runs.length ? runTable(runs) : history ? emptyState("No runs recorded yet.") : h("p", { class: "muted" }, "Loading…"),
    history && hosted() ? loadMore({ loading: history.loading, done: history.done, load: () => loadHistory(job.id, { more: true }) }) : null);
}

export function runTable(runs, { showJob = false } = {}) {
  return h("div", { class: "table-wrap" }, h("table", { class: "runs" },
    h("thead", {}, h("tr", {},
      h("th", { scope: "col" }, "Time"),
      showJob ? h("th", { scope: "col" }, "Job") : h("th", { scope: "col", class: "wide" }, "Machine"),
      h("th", { scope: "col", class: "num wide" }, "Queue"),
      h("th", { scope: "col", class: "num" }, "Took"),
      h("th", { scope: "col", class: "num" }, "Peak"),
      h("th", { scope: "col" }, "Outcome"),
      h("th", { scope: "col", class: "wide" }, "Error"))),
    h("tbody", {}, runs.map((run) => {
      const href = runHref(run.id);
      const open = () => { location.hash = href; };
      const peak = peakMiB(run);
      const phase = phaseOf(run);
      return h("tr", { class: phase === "failed" || run.outcome === "failed" ? "failed" : "", onclick: open },
        h("td", {}, h("a", { href, title: fullTime.format(new Date(run.startedAt ?? run.submittedAt)) }, when(run.startedAt ?? run.submittedAt))),
        showJob ? h("td", {}, run.job) : h("td", { class: "wide" }, run.machineName ?? "—"),
        h("td", { class: "num wide" }, duration(run.queueSeconds)),
        h("td", { class: "num" }, run.finishedAt ? duration(run.durationSeconds) : "…"),
        h("td", { class: "num" }, peak !== null ? mib(peak) : "—"),
        h("td", {}, runChip(run)),
        h("td", { class: "wide error-cell", title: run.error ?? undefined }, run.error ?? ""));
    }))));
}

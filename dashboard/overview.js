// The overview (§7.1), in order: what needs attention, what runs now, the
// next slots and the jobs (schedule in UTC with Irish time beside it, last
// outcome, published per model, a duration sparkline). Jobs switched off
// fold into one line.

import {
  LOCAL_NAME, LOCAL_ZONE, PHASE_LABELS, WAITING_TOO_LONG_MS, attentionItems, clockIn, duration, jobHref, jobState, mib, modelRun, parseTime,
  peakMiB, phaseOf, relative, runHref, scheduleLine, sparkBars, sparkSummary,
} from "./lib.js";
import {
  api, banner, busy, can, chip, clockNow, emptyState, fullTime, h, hosted, isBusy, outcomeChip, section, state, stateChip, toast, when,
} from "./ui.js";
import { loadSnapshot } from "./data.js";

export function overview() {
  const { snapshot } = state;
  const now = Date.now();
  const jobs = snapshot.jobs ?? [];
  const off = jobs.filter((job) => jobState(job) === "off");
  const shown = jobs.filter((job) => jobState(job) !== "off");
  const machines = snapshot.machines ?? [];
  const online = machines.filter((machine) => ["online", "draining"].includes(machine.status)).length;
  const items = attentionItems(snapshot, now);
  return h("div", { class: "page overview" },
    state.error ? banner(`Last refresh failed: ${state.error}`) : null,
    snapshot.controller?.clusterError ? banner(`Bacalhau: ${snapshot.controller.clusterError}`) : null,
    snapshot.controller?.globalPause ? pausedBanner() : null,
    h("h1", { class: "visually-hidden" }, "Overview"),
    h("p", { class: "muted small summary" },
      `${shown.length} job${shown.length === 1 ? "" : "s"}`,
      hosted() ? ` · ${machines.length} machine${machines.length === 1 ? "" : "s"} (${online} online)` : ` · ${snapshot.nodeCount ?? 0} nodes`,
      state.updatedAt ? ` · updated ${clockNow(state.updatedAt)}` : ""),
    section(`Needs attention${items.length ? ` (${items.length})` : ""}`,
      items.length ? h("ul", { class: "list attention", role: "list" }, items.map(attentionRow)) : h("p", { class: "all-clear" }, h("span", { "aria-hidden": "true" }, "✓ "), "Nothing needs a look.")),
    h("div", { class: "two-up" },
      section("Running now", runningNow(snapshot, now)),
      snapshot.upcoming ? section("Next up", nextUp(snapshot.upcoming)) : null),
    section("Jobs",
      h("div", { class: "job-grid" }, shown.length ? shown.map((job) => jobCard(job, now)) : emptyState("No jobs yet. Import some with home-compute cloud import.")),
      off.length ? h("p", { class: "off-line" }, `Off in the timetable (${off.length}): `, off.map((job, index) => [index ? ", " : "", h("a", { href: jobHref(job.id) }, job.id)])) : null));
}

function pausedBanner() {
  return h("div", { class: "banner warning row between", role: "status" },
    h("span", {}, h("strong", {}, "Everything is paused. "), "Scheduled slots are recorded as skipped; Run now still works."),
    can("operator") ? h("button", {
      disabled: isBusy("resume-all"),
      onclick: () => busy("resume-all", async () => {
        try {
          await api("/v1/resume-all", { method: "POST" });
          toast("Resumed: scheduled runs start again");
          await loadSnapshot();
        } catch (error) {
          toast(error.message, { error: true });
        }
      }),
    }, "Resume all") : null);
}

function attentionRow(item) {
  return h("li", {},
    h("a", { class: `item ${item.tone}`, href: item.href },
      h("span", { class: `item-icon ${item.tone}`, "aria-hidden": "true" }, item.icon),
      h("span", { class: "item-body" },
        h("span", { class: "item-title" }, item.title),
        item.detail ? h("span", { class: "item-detail" }, item.detail) : null)));
}

function runningNow(snapshot, now) {
  const runs = (snapshot.activeRuns ?? []).filter((run) => phaseOf(run) !== "due" || now - (parseTime(run.submittedAt) ?? now) < WAITING_TOO_LONG_MS);
  if (!runs.length && !hosted()) {
    const active = (snapshot.jobs ?? []).filter((job) => ["running", "queued"].includes(jobState(job)));
    if (!active.length) return emptyState("Nothing is running.");
    return h("ul", { class: "list", role: "list" }, active.map((job) => h("li", {}, h("a", { class: "item", href: jobHref(job.id) },
      h("span", { class: "item-body" }, h("span", { class: "item-title" }, job.id), h("span", { class: "item-detail" }, `since ${when(job.lastSubmittedAt)}`)), stateChip(job)))));
  }
  if (!runs.length) return emptyState("Nothing is running.");
  const jobs = new Map((snapshot.jobs ?? []).map((job) => [job.id, job]));
  return h("ul", { class: "list running", role: "list" }, runs.map((run) => {
    const phase = phaseOf(run);
    const since = parseTime(run.startedAt) ?? parseTime(run.claimedAt) ?? parseTime(run.submittedAt);
    const peak = peakMiB(run);
    const limit = jobs.get(run.job)?.resources?.memoryMiB;
    return h("li", {},
      h("a", { class: "item", href: runHref(run.id) },
        h("span", { class: "item-body" },
          h("span", { class: "item-title" }, run.job),
          h("span", { class: "item-detail" },
            phase === "due" ? (run.waiting ?? "waiting for a machine") : [
              run.machineName ?? "—",
              ` · ${PHASE_LABELS[phase] ?? phase} ${since ? duration((now - since) / 1000) : ""}`,
              peak !== null ? ` · peak ${mib(peak)}${limit ? ` of ${mib(limit)}` : ""}` : "",
            ])),
        chip({ label: PHASE_LABELS[phase] ?? phase, tone: phase === "due" ? "warning" : "running", icon: phase === "due" ? "◷" : "●" })));
  }));
}

function nextUp(slots) {
  if (!slots.length) return emptyState(state.snapshot.controller?.globalPause ? "Paused: no slots will run." : "No scheduled slots.");
  return h("ol", { class: "list next", role: "list" }, slots.map((slot) => h("li", {},
    h("a", { class: "item", href: jobHref(slot.job) },
      h("span", { class: "slot-time" }, h("span", { class: "mono" }, `${clockIn(Date.parse(slot.at))} UTC`),
        h("span", { class: "muted small" }, relative(slot.at))),
      h("span", { class: "item-body" },
        h("span", { class: "item-title" }, slot.job),
        h("span", { class: "item-detail" }, `${clockIn(Date.parse(slot.at), LOCAL_ZONE)} ${LOCAL_NAME}`)),
      h("span", { class: `expected${slot.machine ? "" : " none"}`, title: slot.note ?? undefined },
        slot.machine ? `→ ${slot.machine}` : slot.note?.startsWith("blocked") ? "blocked" : "no machine",
        slot.machine && slot.note ? h("span", { class: "muted small block" }, slot.note) : null)))));
}

export function sparkline(durations, { width = 132, height = 30 } = {}) {
  const bars = sparkBars(durations, { width, height });
  const summary = sparkSummary(durations);
  if (!bars.length) return h("span", { class: "spark-empty muted small" }, summary);
  return h("svg", { class: "spark", width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": `Durations: ${summary}` },
    h("title", {}, summary),
    bars.map((bar) => h("rect", { x: bar.x, y: bar.y, width: bar.width, height: bar.height, rx: 1, class: bar.failed ? "failed" : "" },
      h("title", {}, `${duration(bar.seconds)}${bar.failed ? " · failed" : ""}${bar.at ? ` · ${fullTime.format(new Date(bar.at))}` : ""}`))));
}

function jobCard(job, now) {
  const status = jobState(job);
  const finishedAt = job.lastFinishedAt;
  const published = Object.entries(job.published ?? {});
  const problem = job.lastOutcome === "failed";
  return h("a", { class: `job${problem ? " attention" : ""}${["running", "queued"].includes(status) ? " running" : ""}`, href: jobHref(job.id) },
    h("div", { class: "row between" }, h("span", { class: "job-name grow" }, job.id), job.blocked ? chip({ label: "Blocked", tone: "warning", icon: "⊘" }, job.blocked) : null, job.blocked && status === "idle" ? null : stateChip(job)),
    job.description ? h("div", { class: "job-desc" }, job.description) : null,
    h("div", { class: "job-lines" },
      h("div", { class: "line schedule" }, scheduleLine(job.schedule, now)),
      finishedAt
        ? h("div", { class: "line" }, outcomeChip(job.lastOutcome, job.lastFinishedState), h("span", {}, `${when(finishedAt)} (${relative(finishedAt, now)})`))
        : h("div", { class: "line muted" }, "Not run yet"),
      problem && job.lastError ? h("div", { class: "error-text clamp" }, job.lastError) : null,
      published.length ? h("div", { class: "line published" }, published.map(([model, entry], index) => [
        index ? h("span", { class: "sep" }, "·") : null,
        h("span", { title: entry.at ? `Fetched ${fullTime.format(new Date(entry.at))}` : undefined }, `${model} ${modelRun(entry.run)}`),
      ])) : null,
      h("div", { class: "line spark-line" },
        job.durations ? sparkline(job.durations) : null,
        status === "paused" ? h("span", { class: "muted small" }, "Paused") : job.nextDueAt ? h("span", { class: "muted small" }, `Next ${when(job.nextDueAt)} (${relative(job.nextDueAt, now)})`) : null)));
}

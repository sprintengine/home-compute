// The overview (§7.1), in order: what runs now and for how long, the next
// runs in schedule order (the very next one first and largest), what needs
// attention, and the jobs (schedule in UTC with Irish time beside it, last
// outcome, published per model, a duration sparkline). Jobs switched off
// fold into one line.

import {
  LOCAL_NAME, LOCAL_ZONE, PHASE_LABELS, attentionItems, bothClocks, clockIn, duration, jobHref, jobState, mib, modelRun, nextRuns, peakMiB,
  relative, runHref, runningNow, scheduleLine, sparkBars, sparkSummary,
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
    section("Running now", running(snapshot, now)),
    section("Next up", nextUp(nextRuns(snapshot, now), now)),
    section(`Needs attention${items.length ? ` (${items.length})` : ""}`,
      items.length ? h("ul", { class: "list attention", role: "list" }, items.map(attentionRow)) : h("p", { class: "all-clear" }, h("span", { "aria-hidden": "true" }, "✓ "), "Nothing needs a look.")),
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

function running(snapshot, now) {
  const rows = runningNow(snapshot, now);
  if (!rows.length) return emptyState("Nothing running.");
  const jobs = new Map((snapshot.jobs ?? []).map((job) => [job.id, job]));
  return h("ul", { class: "list running", role: "list" }, rows.map((row) => {
    const waiting = row.phase === "due";
    const label = PHASE_LABELS[row.phase] ?? row.phase;
    const peak = row.run ? peakMiB(row.run) : null;
    const limit = jobs.get(row.job)?.resources?.memoryMiB;
    const elapsed = row.seconds === null ? "—" : duration(row.seconds);
    const detail = waiting ? row.run?.waiting ?? (row.run ? "waiting for a machine" : "queued, waiting for capacity") : [
      row.run ? `${row.run.machineName ?? "—"} · ` : "",
      label,
      peak !== null ? ` · peak ${mib(peak)}${limit ? ` of ${mib(limit)}` : ""}` : "",
    ];
    return h("li", {},
      h("a", { class: "item", href: row.run ? runHref(row.id) : jobHref(row.job) },
        h("span", { class: "item-body" },
          h("span", { class: "item-title" }, row.job),
          h("span", { class: "item-detail" }, detail)),
        h("span", { class: "elapsed", title: `${waiting ? "Waiting" : label} for ${elapsed}${row.since !== null ? `, since ${when(row.since)}` : ""}` },
          h("span", { class: "mono" }, elapsed),
          h("span", { class: "muted small" }, waiting ? "waiting" : "so far")),
        chip({ label, tone: waiting ? "warning" : "running", icon: waiting ? "◷" : "●" })));
  }));
}

/** The next runs, soonest first; the very next one is the large first item. */
function nextUp(slots, now) {
  if (!slots.length) return emptyState(state.snapshot.controller?.globalPause ? "Paused: no scheduled runs will start." : "No scheduled runs.");
  return h("ol", { class: "list next", role: "list" }, slots.map((slot, index) => {
    // Only the hosted control plane says which machine is expected to take a slot.
    const expected = "machine" in slot ? h("span", { class: `expected${slot.machine ? "" : " none"}`, title: slot.note ?? undefined },
      slot.machine ? `→ ${slot.machine}` : slot.note?.startsWith("blocked") ? "blocked" : "no machine",
      slot.machine && slot.note ? h("span", { class: "muted small block" }, slot.note) : null) : null;
    if (index === 0) {
      const why = !slot.machine && slot.note ? slot.note[0].toUpperCase() + slot.note.slice(1) : null;
      return h("li", { class: "first" },
        h("a", { class: "item next-first", href: jobHref(slot.job) },
          h("span", { class: "item-body" },
            h("span", { class: "next-label" }, "Next run"),
            h("span", { class: "next-job" }, slot.job),
            h("span", { class: "item-detail" }, bothClocks(slot.at)),
            // Next in the schedule but not going to start as things are: say why in full, not in a tooltip.
            why ? h("span", { class: "next-note" }, why) : null),
          h("span", { class: "next-in" }, h("time", { class: "next-in-text", datetime: new Date(slot.at).toISOString() }, relative(slot.at, now)), why ? null : expected)));
    }
    return h("li", {},
      h("a", { class: "item", href: jobHref(slot.job) },
        h("span", { class: "slot-time" }, h("time", { class: "mono", datetime: new Date(slot.at).toISOString() }, `${clockIn(slot.at)} UTC`),
          h("span", { class: "muted small" }, relative(slot.at, now))),
        h("span", { class: "item-body" },
          h("span", { class: "item-title" }, slot.job),
          h("span", { class: "item-detail" }, `${clockIn(slot.at, LOCAL_ZONE)} ${LOCAL_NAME}`)),
        expected));
  }));
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
  // The local controller's snapshot may know a finished run only from its recent runs.
  const last = (job.recentRuns ?? []).find((run) => run.finishedAt);
  const finishedAt = job.lastFinishedAt ?? last?.finishedAt;
  const outcome = job.lastOutcome ?? last?.outcome;
  const published = Object.entries(job.published ?? {});
  const problem = outcome === "failed";
  return h("a", { class: `job${problem ? " attention" : ""}${["running", "queued"].includes(status) ? " running" : ""}`, href: jobHref(job.id) },
    h("div", { class: "row between" }, h("span", { class: "job-name grow" }, job.id), job.blocked ? chip({ label: "Blocked", tone: "warning", icon: "⊘" }, job.blocked) : null, job.blocked && status === "idle" ? null : stateChip(job)),
    job.description ? h("div", { class: "job-desc" }, job.description) : null,
    h("div", { class: "job-lines" },
      h("div", { class: "line schedule" }, scheduleLine(job.schedule, now)),
      finishedAt
        ? h("div", { class: "line" }, outcomeChip(outcome, job.lastFinishedState ?? last?.state), h("span", {}, `${when(finishedAt)} (${relative(finishedAt, now)})`))
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

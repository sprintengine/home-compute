// A run's page (§7.3): its phase timeline (due → claimed → VM → pull → run →
// report, with durations), stats, reports, the error summary and the log
// tail with error lines highlighted, a jump to the first error and an
// errors-only filter; Cancel and Retry.

import {
  PHASE_LABELS, TERMINAL_PHASES, bytes, duration, jobHref, mib, modelRun, parseTime, peakMiB, phaseOf, phaseSteps, relative, runHref,
} from "./lib.js";
import {
  api, back, banner, busy, can, confirmDialog, facts, fullTime, h, hosted, isBusy, render, runChip, section, state, toast, when,
} from "./ui.js";
import { ensureRun, loadLog, loadRun, loadSnapshot } from "./data.js";

export function runPage(id, jobHint) {
  ensureRun(id, jobHint);
  const entry = state.runs.get(id);
  const run = entry?.data;
  if (!run) {
    return h("div", { class: "page" }, back(jobHint ? jobHref(jobHint) : "#/", jobHint ?? "Overview"), h("h1", {}, "Run"),
      entry?.error ? banner(entry.status === 404 ? "There is no such run." : `Could not load the run: ${entry.error}`) : h("p", { class: "muted" }, "Loading…"));
  }
  loadLog(id);
  const phase = phaseOf(run);
  const finished = TERMINAL_PHASES.has(phase) || phase === "lost";
  return h("div", { class: "page run-page" },
    back(jobHref(run.job), run.job),
    h("div", { class: "row between title-row" }, h("h1", { class: "grow" }, `${run.job} · ${when(run.startedAt ?? run.submittedAt)}`), runChip(run)),
    h("p", { class: "muted small" }, h("span", { class: "mono" }, run.id),
      ` · ${run.source === "manual" ? `Run now${run.requestedBy ? ` by ${run.requestedBy}` : ""}` : run.source === "schedule" ? "timetable slot" : run.source ?? ""}`,
      run.attempt > 1 ? ` · attempt ${run.attempt}` : "",
      run.retryOf ? [" · retry of ", h("a", { href: runHref(run.retryOf) }, run.retryOf.slice(0, 12) + "…")] : null,
      run.recovered ? " · recovered after it was lost" : ""),
    actions(run, finished),
    errorSummary(run),
    run.waiting ? banner(run.waiting.replace(/^waiting/, "Waiting"), "info") : null,
    h("div", { class: "cards" },
      h("section", { class: "card", "aria-labelledby": "ph-title" }, h("h2", { class: "card-title", id: "ph-title" }, "Phases"), timeline(run)),
      h("section", { class: "card", "aria-labelledby": "st-title" }, h("h2", { class: "card-title", id: "st-title" }, "Stats"), stats(run))),
    reportsSection(run),
    section("Log", logView(id)));
}

function actions(run, finished) {
  if (!can("operator") || !hosted()) return null;
  const phase = phaseOf(run);
  return h("div", { class: "actions" },
    !finished ? h("button", {
      class: "danger", id: "run-cancel", disabled: isBusy(`${run.id}:cancel`),
      onclick: async () => {
        const sure = await confirmDialog({
          title: `Cancel this ${run.job} run?`, confirm: "Cancel the run", danger: true,
          body: phase === "due" ? "It has not started; it will not run." : `Its machine stops the container on its next sync (within about 10 s) and still sends the log.`,
        });
        if (!sure) return;
        await busy(`${run.id}:cancel`, async () => {
          try {
            await api(`/v1/runs/${encodeURIComponent(run.id)}/cancel`, { method: "POST" });
            toast("Cancelled");
            await Promise.all([loadRun(run.id), loadSnapshot()]);
          } catch (error) {
            toast(error.message, { error: true });
          }
        });
      },
    }, "Cancel run") : null,
    finished && phase !== "skipped" ? h("button", {
      id: "run-retry", disabled: isBusy(`${run.id}:retry`),
      onclick: () => busy(`${run.id}:retry`, async () => {
        try {
          const { data } = await api(`/v1/runs/${encodeURIComponent(run.id)}/retry`, { method: "POST", body: {} });
          toast(`Retrying as attempt ${data.attempt}`);
          await loadSnapshot();
          location.hash = runHref(data.runId);
        } catch (error) {
          toast(error.message, { error: true });
        }
      }),
    }, "Retry") : null);
}

function errorSummary(run) {
  const reasons = [];
  if (run.oomKilled) reasons.push("killed for running out of memory");
  if (run.timedOut || phaseOf(run) === "timed-out") reasons.push("stopped at its time limit");
  if (!run.error && !reasons.length) return null;
  return h("div", { class: "banner error-summary", role: "alert" },
    h("strong", {}, run.error ?? reasons.join("; ")),
    run.error && reasons.length ? h("div", { class: "small" }, reasons.join("; ")) : null,
    run.failureDetail ? h("pre", { class: "detail" }, run.failureDetail) : null);
}

function timeline(run) {
  const steps = phaseSteps(run);
  const longest = Math.max(...steps.map((step) => step.seconds ?? 0), 1);
  const phase = phaseOf(run);
  const now = Date.now();
  const finishedAt = parseTime(run.finishedAt);
  return h("ol", { class: "phases-list" },
    steps.map((step) => {
      const reached = step.start !== null;
      const open = reached && step.seconds === null && !TERMINAL_PHASES.has(phase);
      const seconds = open ? (now - step.start) / 1000 : step.seconds;
      return h("li", { class: `phase${reached ? " reached" : ""}${open ? " current" : ""}${step.skipped ? " skipped" : ""}` },
        h("span", { class: "phase-name" }, step.label),
        h("span", { class: "phase-at mono" }, reached ? new Date(step.start).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : step.skipped ? "skipped" : "—"),
        h("span", { class: "phase-bar", "aria-hidden": "true" }, typeof seconds === "number" ? h("span", { class: "fill", "data-w": Math.max(2, Math.round((seconds / Math.max(longest, seconds)) * 100)) }) : null),
        h("span", { class: "phase-took num" }, typeof seconds === "number" ? `${duration(seconds)}${open ? "…" : ""}` : ""));
    }),
    h("li", { class: `phase end${finishedAt ? " reached" : ""}` },
      h("span", { class: "phase-name" }, finishedAt ? PHASE_LABELS[phase] ?? "Finished" : "Finished"),
      h("span", { class: "phase-at mono" }, finishedAt ? new Date(finishedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"),
      h("span", { class: "phase-bar" }), h("span", { class: "phase-took" }, "")));
}

/** Widths come from data attributes: the CSP allows no inline styles, so they are set as properties after rendering. */
export function applyBarWidths(root) {
  for (const element of root.querySelectorAll("[data-w]")) element.style.width = `${element.dataset.w}%`;
  for (const element of root.querySelectorAll("[data-left]")) element.style.left = `${element.dataset.left}%`;
}

function stats(run) {
  const samples = run.stats?.samples;
  const sampled = typeof run.stats?.peakMemoryBytes === "number" ? Math.round(run.stats.peakMemoryBytes / 1048576) : run.metrics?.peakMemoryMb;
  const workload = peakMiB(run);
  return facts([
    ["Machine", run.machineName ?? (run.machine ? run.machine : "not claimed yet")],
    ["Queued for", typeof run.queueSeconds === "number" ? duration(run.queueSeconds) : null],
    ["VM wait", typeof run.vmWaitSeconds === "number" ? duration(run.vmWaitSeconds) : null],
    ["Pull", typeof run.pullSeconds === "number" ? duration(run.pullSeconds) : null],
    ["Ran for", typeof run.durationSeconds === "number" ? duration(run.durationSeconds) : null],
    ["Peak memory", samples === 0 ? "too short to sample" : typeof sampled === "number" ? `${mib(sampled)}${run.stats?.memoryLimitBytes ? ` of ${mib(Math.round(run.stats.memoryLimitBytes / 1048576))}` : ""}` : null],
    ["Workload's own peak", workload !== null && workload !== sampled ? mib(workload) : null],
    ["CPU", typeof run.stats?.avgCpuPct === "number" ? `${Math.round(run.stats.avgCpuPct)}% average, ${Math.round(run.stats.peakCpuPct ?? 0)}% peak${typeof run.stats.cpuSeconds === "number" ? ` · ${duration(run.stats.cpuSeconds)} CPU time` : ""}` : null],
    ["Samples", typeof samples === "number" && samples > 0 ? samples : null],
    ["Exit code", run.exitCode],
    ["Image", run.imageDigest ? h("span", { class: "mono" }, run.imageDigest) : null],
    ["Arguments", run.parameters?.length ? h("span", { class: "mono" }, run.parameters.join(" ")) : null],
    ["Skipped", run.skipReason],
    ["Submitted", run.submittedAt ? fullTime.format(new Date(run.submittedAt)) : null],
  ]);
}

function reportsSection(run) {
  const reports = run.reports ?? [];
  const metrics = Object.entries(run.metrics ?? {}).filter(([name]) => name !== "peakMemoryMb");
  if (!reports.length && !metrics.length) return null;
  return section(`Reports${reports.length ? ` (${reports.length})` : ""}`,
    h("div", { class: "card" },
      metrics.length ? facts(metrics.map(([name, value]) => [words(name), metric(name, value)])) : null,
      reports.map(reportView)));
}

function words(name) {
  const bare = name.replace(/Mb$/, "").replace(/Bytes$/, "").replace(/(.)Seconds$/, "$1 time").replace(/^seconds$/, "time");
  return bare.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase().replace(/\b(cpu|gpu|io|rss)\b/g, (word) => word.toUpperCase()).replace(/^./, (c) => c.toUpperCase());
}

function metric(name, value) {
  if (typeof value !== "number") return String(value);
  if (/mb$/i.test(name)) return mib(value);
  if (/bytes$/i.test(name)) return bytes(value);
  if (/seconds$/i.test(name)) return duration(value);
  return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
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

function logView(runId) {
  const log = state.logs.get(runId);
  if (!log || log.loading) return h("p", { class: "muted" }, "Loading the log…");
  if (log.error) {
    return h("div", {}, banner(`Could not load the log: ${log.error}`),
      h("div", { class: "actions" }, h("button", { onclick: () => loadLog(runId, { force: true }) }, "Try again")));
  }
  const data = log.data;
  const lines = data.lines ?? [];
  const errorsOnly = state.ui.logErrorsOnly && data.errorCount > 0;
  const firstError = lines.findIndex((line) => line.level === "error");
  const pre = h("div", { class: `log${state.ui.logWrap ? " wrap" : ""}${errorsOnly ? " errors-only" : ""}`, role: "log", tabindex: "0", "aria-label": "Log tail" },
    lines.map((line, index) => h("div", { class: `log-line ${line.level}`, id: `L${index + 1}` },
      h("span", { class: "n", "aria-hidden": "true" }, index + 1), h("span", { class: "t" }, line.text || " "))));
  return h("div", {},
    h("div", { class: "log-tools" },
      h("span", { class: data.errorCount ? "chip critical" : "chip" }, `${data.errorCount} error line${data.errorCount === 1 ? "" : "s"}`),
      h("span", { class: "muted" },
        `${lines.length} line${lines.length === 1 ? "" : "s"}${data.truncated ? ` (the last ${lines.length}; ${bytes(data.bytes)} in all)` : ""}`,
        data.partial ? " · still being written" : "",
        data.fetchedAt ? ` · ${relative(data.fetchedAt)}` : ""),
      firstError >= 0 ? h("button", { class: "link", id: "log-first-error", onclick: () => {
        state.ui.logErrorsOnly = false;
        render();
        const target = document.getElementById(`L${firstError + 1}`);
        target?.scrollIntoView({ block: "center" });
        target?.classList.add("flash");
      } }, "Jump to first error") : null,
      h("label", {}, h("input", { type: "checkbox", id: "log-errors", checked: errorsOnly, disabled: !data.errorCount,
        onchange: (event) => { state.ui.logErrorsOnly = event.target.checked; render(); } }), "Errors only"),
      h("label", {}, h("input", { type: "checkbox", id: "log-wrap", checked: state.ui.logWrap,
        onchange: (event) => { state.ui.logWrap = event.target.checked; render(); } }), "Wrap"),
      h("button", { class: "link", onclick: () => loadLog(runId, { force: true }) }, "Reload")),
    lines.length ? pre : h("p", { class: "muted" }, "The log is empty."));
}

// Every job on a 24-hour UTC grid with Irish time beside it (§7.5): a grid
// on wide screens, a list by hour on phones. Hourly jobs, interval jobs and
// switched-off jobs each get one line rather than a cell in every column.

import {
  LOCAL_NAME, jobHref, jobState, localHours, pad, scheduleText, slotsByHour, timetableModel, zoneOffsetMinutes,
} from "./lib.js";
import { chip, emptyState, h, section, state } from "./ui.js";

export function timetablePage() {
  const jobs = state.snapshot.jobs ?? [];
  const model = timetableModel(jobs);
  const local = localHours();
  const currentHour = new Date().getUTCHours();
  const offset = zoneOffsetMinutes(Date.now()) / 60;
  const sameZone = offset === 0;
  return h("div", { class: "page timetable-page" },
    h("h1", {}, "Timetable"),
    h("p", { class: "muted small" }, `Times are UTC, the control plane's clock.${sameZone ? ` ${LOCAL_NAME} is UTC today.` : ` ${LOCAL_NAME} is UTC${offset > 0 ? "+" : "−"}${Math.abs(offset)} today: shown with each hour.`}`),
    model.hourly.length ? section("Every hour", h("ul", { class: "list compact", role: "list" }, model.hourly.map(({ job, minutes }) => h("li", {},
      h("a", { class: "item", href: jobHref(job.id) },
        h("span", { class: "mono minutes" }, minutes.map((minute) => `:${pad(minute)}`).join(" ")),
        h("span", { class: "item-title grow" }, job.id), jobChip(job)))))) : null,
    model.daily.length ? section("At set hours",
      grid(model, local, currentHour),
      byHour(model, local, currentHour)) : null,
    model.interval.length ? section("On an interval", h("ul", { class: "list compact", role: "list" }, model.interval.map((job) => h("li", {},
      h("a", { class: "item", href: jobHref(job.id) }, h("span", { class: "mono minutes" }, `every ${job.schedule.every}`), h("span", { class: "item-title grow" }, job.id), jobChip(job)))))) : null,
    model.unscheduled.length ? h("p", { class: "off-line" }, `Run now only: ${model.unscheduled.map((job) => job.id).join(", ")}`) : null,
    model.off.length ? h("p", { class: "off-line" }, `Off (${model.off.length}): `, model.off.map((job, index) => [index ? ", " : "", h("a", { href: jobHref(job.id) }, job.id)])) : null,
    !jobs.length ? emptyState("No jobs yet.") : null);
}

function jobChip(job) {
  const status = jobState(job);
  if (status === "paused") return chip({ label: "Paused", tone: "warning", icon: "❚❚" });
  if (job.blocked) return chip({ label: "Blocked", tone: "warning", icon: "⊘" }, job.blocked);
  return null;
}

/** The desktop grid: a row per job, a column per UTC hour, its minutes in the cell. */
function grid(model, local, currentHour) {
  return h("div", { class: "tt-grid-wrap" }, h("table", { class: "tt-grid" },
    h("caption", { class: "visually-hidden" }, "Daily slots by UTC hour"),
    h("thead", {},
      h("tr", {}, h("th", { scope: "col", class: "tt-job" }, "Job"), Array.from({ length: 24 }, (_, hour) => h("th", { scope: "col", class: hour === currentHour ? "now" : "" },
        h("span", { class: "utc" }, pad(hour)), local[hour] !== pad(hour) ? h("span", { class: "local", title: LOCAL_NAME }, local[hour]) : null)))),
    h("tbody", {}, model.daily.map(({ job, slots }) => h("tr", { class: jobState(job) === "paused" ? "paused" : "" },
      h("th", { scope: "row", class: "tt-job" }, h("a", { href: jobHref(job.id), title: scheduleText(job.schedule) }, job.id), jobChip(job)),
      slots.map((minutes, hour) => h("td", { class: `${minutes.length ? "slot" : ""}${hour === currentHour ? " now" : ""}` },
        minutes.length ? h("span", { title: `${job.id} at ${minutes.map((minute) => `${pad(hour)}:${pad(minute)}`).join(", ")} UTC` }, minutes.map((minute) => `:${pad(minute)}`).join(" ")) : null)))))));
}

/** The phone's list: each UTC hour that has slots, with its Irish hour. */
function byHour(model, local, currentHour) {
  return h("ol", { class: "tt-hours", role: "list" }, slotsByHour(model).map(({ hour, entries }) => h("li", { class: hour === currentHour ? "now" : "" },
    h("div", { class: "tt-hour" }, h("span", { class: "mono" }, `${pad(hour)}:00 UTC`), local[hour] !== pad(hour) ? h("span", { class: "muted small" }, `${local[hour]}:00 ${LOCAL_NAME}`) : null),
    h("ul", { role: "list" }, entries.map(({ job, minute }) => h("li", {},
      h("a", { href: jobHref(job.id) }, h("span", { class: "mono" }, `${pad(hour)}:${pad(minute)}`), " ", job.id), jobChip(job)))))));
}

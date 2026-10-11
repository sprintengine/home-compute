#!/usr/bin/env node
// A stand-in for a project's timetable command (Wingfoil's `macmini.sh jobs set`):
//   fake-timetable.mjs CONFIG JOB [--enabled true|false] [--hours every|H,H] [--minutes M,M]
// rewrites CONFIG's job in place and answers with one JSON line. Like Wingfoil's,
// it refuses minutes off a five-minute mark.
import { readFileSync, writeFileSync } from "node:fs";

const [configFile, id, ...flags] = process.argv.slice(2);
const refuse = (error) => {
  console.log(JSON.stringify({ ok: false, error }));
  process.exit(2);
};
const config = JSON.parse(readFileSync(configFile, "utf8"));
const job = config.jobs.find((candidate) => candidate.id === id);
if (!job) refuse(`No job '${id}' in the timetable`);
for (let index = 0; index < flags.length; index += 2) {
  const [flag, value] = [flags[index], flags[index + 1]];
  if (flag === "--enabled") {
    if (value === "false") job.enabled = false;
    else delete job.enabled;
  } else if (flag === "--hours") {
    if (value === "every") delete job.schedule.at.hours;
    else job.schedule.at.hours = value.split(",").map(Number);
  } else if (flag === "--minutes") {
    const minutes = value.split(",").map(Number);
    if (minutes.some((minute) => minute % 5)) refuse("minutes must fall on a 5-minute mark");
    job.schedule.at.minutes = minutes;
  } else {
    refuse(`unknown flag ${flag}`);
  }
}
writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, restartRequired: true }));

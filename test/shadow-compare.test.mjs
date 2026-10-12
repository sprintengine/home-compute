// Shadow mode's check (§9 phase 0): the hosted slots against the live controller's submissions.
import assert from "node:assert/strict";
import test from "node:test";
import { compare } from "../cloud/scripts/shadow-compare.mjs";

const T = Date.parse("2026-10-12T16:00:00Z");
const min = (minutes) => T + minutes * 60_000;
const jobs = [
  { id: "blend", enabled: true, schedule: { at: { minutes: [5] } } },
  { id: "gfs", enabled: true, schedule: { at: { hours: [16], minutes: [0] } } },
  { id: "aifs", enabled: false, schedule: { at: { minutes: [25] } } },
  { id: "hello", enabled: true, schedule: null },
];

test("every slot the controller submitted matches a hosted row, and nothing is left over", () => {
  const hosted = [{ job_id: "blend", slot_at: min(5) }, { job_id: "blend", slot_at: min(65) }, { job_id: "gfs", slot_at: min(0) }];
  const submissions = [
    { job: "blend", at: min(5) + 4_000, startedAt: min(5) + 4_100, finishedAt: min(5) + 15_000 },
    { job: "blend", at: min(65) + 3_000, startedAt: null, finishedAt: null },
    { job: "gfs", at: min(0) + 2_000, startedAt: min(0) + 2_100, finishedAt: min(4) },
  ];
  const result = compare({ jobs, hosted, submissions, start: min(0), end: min(90) });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.rows, [
    { job: "blend", expected: 2, hosted: 2, matched: 2, coalesced: 0 },
    { job: "gfs", expected: 1, hosted: 1, matched: 1, coalesced: 0 },
  ]);
});

test("names a hosted gap, a missed submission, an extra one, and counts a slot the controller coalesced", () => {
  const hosted = [{ job_id: "blend", slot_at: min(5) }, { job_id: "blend", slot_at: min(125) }, { job_id: "gfs", slot_at: min(0) }, { job_id: "gfs", slot_at: min(30) }];
  const submissions = [
    { job: "blend", at: min(5) + 1_000, startedAt: min(5) + 2_000, finishedAt: min(70) }, // still running at 01:05: 01:05 coalesced
    { job: "blend", at: min(30), startedAt: null, finishedAt: null }, // no such slot
  ];
  const result = compare({ jobs, hosted, submissions, start: min(0), end: min(130) });
  assert.deepEqual(result.problems.sort(), [
    "blend: hosted has no row for the 2026-10-12T17:05:00Z slot",
    "blend: the controller submitted at 2026-10-12T16:30:00Z, which is no hosted slot",
    "blend: the controller submitted nothing for the 2026-10-12T18:05:00Z slot",
    "gfs: hosted recorded 2026-10-12T16:30:00Z, which the timetable does not have",
    "gfs: the controller submitted nothing for the 2026-10-12T16:00:00Z slot",
  ].sort());
  assert.deepEqual(result.rows.find((row) => row.job === "blend"), { job: "blend", expected: 3, hosted: 2, matched: 1, coalesced: 1 });
});

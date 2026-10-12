import assert from "node:assert/strict";
import test from "node:test";
import { normaliseJob } from "../src/core/job.mjs";
import { materialise, nextSlot, previousSlot, upcomingAt } from "../src/core/schedule.mjs";

const at = (time) => Date.parse(time);
const job = (overrides = {}) => ({
  ...normaliseJob({ id: "harmonie", image: "x", schedule: { at: { hours: [8, 10], minutes: [20] } }, ...overrides }),
  paused: overrides.paused ?? false,
});

/** Applies materialise's answer to a state, as the repository does with SQL. */
function apply(state, result, ids = { next: 1 }) {
  const next = { ...state, lastSlotAt: result.lastSlotAt };
  if (result.expire.includes(state.due?.id)) next.due = null;
  for (const slot of result.slots) {
    if (slot.state === "due") next.due = { id: `r${ids.next++}`, dueAt: slot.dueAt };
  }
  return next;
}

test("at slots are UTC and wrap across midnight", () => {
  const schedule = { hours: [3, 21], minutes: [30] };
  assert.equal(previousSlot(schedule, at("2026-10-11T02:00:00Z")), at("2026-10-10T21:30:00Z"));
  assert.equal(previousSlot(schedule, new Date("2026-10-11T03:30:00Z")), at("2026-10-11T03:30:00Z"), "a Date works as before");
  assert.equal(nextSlot(schedule, at("2026-10-11T21:30:00Z")), at("2026-10-12T03:30:00Z"));
  assert.equal(nextSlot({ minutes: [5] }, at("2026-10-11T10:05:00Z")), at("2026-10-11T11:05:00Z"), "no hours means every hour");
  assert.equal(previousSlot({ hours: [10] }, at("2026-10-11T10:59:00Z")), at("2026-10-11T10:00:00Z"), "no minutes means :00");
});

test("a slot is materialised once, however often the cron runs", () => {
  const harmonie = job();
  const now = at("2026-10-11T08:20:05Z");
  const first = materialise(harmonie, { lastSlotAt: at("2026-10-10T10:20:00Z") }, now);
  assert.deepEqual(first.slots, [{ slotAt: at("2026-10-11T08:20:00Z"), dueAt: at("2026-10-11T08:20:00Z"), state: "due", skipReason: null, preferredUntil: null }]);
  assert.equal(first.lastSlotAt, at("2026-10-11T08:20:00Z"));
  assert.equal(first.nextDueAt, at("2026-10-11T10:20:00Z"));
  const state = apply({ lastSlotAt: at("2026-10-10T10:20:00Z") }, first);
  const again = materialise(harmonie, state, now + 30_000);
  assert.deepEqual(again.slots, [], "the second cron in the minute finds nothing new");
  assert.equal(again.lastSlotAt, first.lastSlotAt);
  assert.deepEqual(materialise(harmonie, state, at("2026-10-11T10:19:59Z")).slots, [], "nor does any minute before the next slot");
});

test("a job that never ran is due at its latest slot, as the local controller does", () => {
  const result = materialise(job(), {}, at("2026-10-11T09:00:00Z"));
  assert.equal(result.slots[0].slotAt, at("2026-10-11T08:20:00Z"));
  assert.equal(result.slots[0].state, "due");
});

test("slots missed during downtime collapse into one run", () => {
  const blend = job({ schedule: { at: { minutes: [5] } } });
  const result = materialise(blend, { lastSlotAt: at("2026-10-11T02:05:00Z") }, at("2026-10-11T09:30:00Z"));
  assert.equal(result.slots.length, 1);
  assert.equal(result.slots[0].slotAt, at("2026-10-11T09:05:00Z"));
});

test("coalesce: a slot waits behind an active run, and folds into a waiting one", () => {
  const harmonie = job();
  const now = at("2026-10-11T10:20:01Z");
  const base = { lastSlotAt: at("2026-10-11T08:20:00Z") };
  const behindActive = materialise(harmonie, { ...base, active: { id: "r1", state: "running" } }, now);
  assert.equal(behindActive.slots[0].state, "due", "it becomes due and waits for the active run");
  const behindDue = materialise(harmonie, { ...base, due: { id: "r1", dueAt: at("2026-10-11T08:20:00Z") } }, now);
  assert.deepEqual([behindDue.slots[0].state, behindDue.slots[0].skipReason], ["skipped", "coalesced"]);
  assert.equal(behindDue.lastSlotAt, at("2026-10-11T10:20:00Z"));
});

test("skip: a slot that finds its job running is recorded as an overlap", () => {
  const harmonie = job({ policy: { overlap: "skip" } });
  const result = materialise(harmonie, { lastSlotAt: at("2026-10-11T08:20:00Z"), active: { id: "r1", state: "running" } }, at("2026-10-11T10:20:00Z"));
  assert.deepEqual([result.slots[0].state, result.slots[0].skipReason], ["skipped", "overlap"]);
  const idle = materialise(harmonie, { lastSlotAt: at("2026-10-11T08:20:00Z") }, at("2026-10-11T10:20:00Z"));
  assert.equal(idle.slots[0].state, "due");
});

test("catch-up latest keeps a waiting run however late; none expires it after maxLateness", () => {
  const waiting = { lastSlotAt: at("2026-10-11T08:20:00Z"), due: { id: "r1", dueAt: at("2026-10-11T08:20:00Z") } };
  const latest = materialise(job(), waiting, at("2026-10-11T09:59:00Z"));
  assert.deepEqual(latest.expire, []);

  const strict = job({ policy: { catchUp: "none" }, timeouts: { maxLatenessSeconds: 3600 } });
  assert.deepEqual(materialise(strict, waiting, at("2026-10-11T09:20:00Z")).expire, [], "exactly at the limit is still on time");
  const expired = materialise(strict, waiting, at("2026-10-11T09:20:01Z"));
  assert.deepEqual(expired.expire, ["r1"]);
  assert.deepEqual(expired.slots, []);

  // With the stale run gone, the next slot is due rather than coalesced into it.
  const next = materialise(strict, waiting, at("2026-10-11T10:20:00Z"));
  assert.deepEqual(next.expire, ["r1"]);
  assert.equal(next.slots[0].state, "due");

  // After downtime, a slot already older than the limit is recorded as expired, not run.
  const late = materialise(strict, { lastSlotAt: at("2026-10-10T10:20:00Z") }, at("2026-10-11T09:30:00Z"));
  assert.deepEqual([late.slots[0].state, late.slots[0].skipReason], ["skipped", "expired"]);

  const unbounded = job({ policy: { catchUp: "none" } });
  assert.deepEqual(materialise(unbounded, waiting, at("2026-10-12T09:00:00Z")).expire, [], "no limit, no expiry");
});

test("paused, disabled and globally paused jobs run nothing but keep their place", () => {
  const before = { lastSlotAt: at("2026-10-11T08:20:00Z") };
  const now = at("2026-10-11T10:21:00Z");
  const paused = materialise(job({ paused: true }), before, now);
  assert.deepEqual([paused.slots[0].state, paused.slots[0].skipReason], ["skipped", "paused-at-slot"]);
  assert.equal(paused.lastSlotAt, at("2026-10-11T10:20:00Z"));

  const global = materialise(job(), before, now, { globalPause: true });
  assert.deepEqual([global.slots[0].state, global.slots[0].skipReason], ["skipped", "paused-at-slot"]);

  const disabled = materialise(job({ enabled: false }), before, now);
  assert.deepEqual(disabled.slots, [], "a disabled job records nothing");
  assert.equal(disabled.lastSlotAt, at("2026-10-11T10:20:00Z"), "but its place still advances");

  // Resuming after the pause does not replay the slot that passed meanwhile.
  assert.deepEqual(materialise(job(), { lastSlotAt: paused.lastSlotAt }, at("2026-10-11T10:40:00Z")).slots, []);
  assert.equal(materialise(job(), { lastSlotAt: paused.lastSlotAt }, at("2026-10-12T08:20:00Z")).slots[0].state, "due");
});

test("a preferred machine gets the wait it asked for", () => {
  const preferring = job({ placement: { preferMachines: ["mac-mini"], preferWaitSeconds: 120 } });
  const [slot] = materialise(preferring, {}, at("2026-10-11T08:20:00Z")).slots;
  assert.equal(slot.preferredUntil, at("2026-10-11T08:22:00Z"));
  const [fallback] = materialise(job({ placement: { preferMachines: ["mac-mini"] } }), {}, at("2026-10-11T08:20:00Z")).slots;
  assert.equal(fallback.preferredUntil, at("2026-10-11T08:25:00Z"), "the default wait is 300 s");
});

test("every: due from completion, once per interval, never while a run waits or runs", () => {
  const sweep = job({ schedule: { every: "6h" } });
  const fresh = materialise(sweep, {}, at("2026-10-11T10:00:30Z"));
  assert.equal(fresh.slots[0].slotAt, at("2026-10-11T10:00:00Z"), "a job that never ran is due on the current minute");
  assert.equal(fresh.nextDueAt, null, "nothing more until it finishes");
  assert.equal(materialise(sweep, {}, at("2026-10-11T10:00:59Z")).slots[0].slotAt, fresh.slots[0].slotAt,
    "a second cron in the same minute names the same slot");

  const running = { lastSlotAt: at("2026-10-11T10:00:00Z"), active: { id: "r1", state: "running" } };
  assert.deepEqual(materialise(sweep, running, at("2026-10-11T17:00:00Z")), { slots: [], expire: [], lastSlotAt: running.lastSlotAt, nextDueAt: null });

  const finished = { lastSlotAt: at("2026-10-11T10:00:00Z"), lastFinishedAt: at("2026-10-11T10:30:00Z") };
  const early = materialise(sweep, finished, at("2026-10-11T16:29:59Z"));
  assert.deepEqual(early.slots, []);
  assert.equal(early.nextDueAt, at("2026-10-11T16:30:00Z"), "six hours after it finished");
  assert.equal(materialise(sweep, finished, at("2026-10-11T16:30:00Z")).slots[0].slotAt, at("2026-10-11T16:30:00Z"));

  const afterDowntime = materialise(sweep, finished, at("2026-10-12T05:00:00Z"));
  assert.equal(afterDowntime.slots.length, 1);
  assert.equal(afterDowntime.slots[0].slotAt, at("2026-10-12T04:30:00Z"), "the latest whole interval, not a backlog");

  const paused = materialise({ ...sweep, paused: true }, finished, at("2026-10-11T16:31:00Z"));
  assert.equal(paused.slots[0].skipReason, "paused-at-slot");
  assert.equal(paused.nextDueAt, at("2026-10-11T22:30:00Z"), "a paused interval job keeps its rhythm");
  const resumed = materialise(sweep, { ...finished, lastSlotAt: paused.lastSlotAt }, at("2026-10-11T16:40:00Z"));
  assert.deepEqual(resumed.slots, [], "resuming does not run the skipped slot");
});

test("a job without a schedule only runs when asked", () => {
  assert.deepEqual(materialise(job({ schedule: null }), {}, at("2026-10-11T10:00:00Z")).slots, []);
});

test("upcomingAt is what people see: nothing while paused, waiting or running", () => {
  const now = at("2026-10-11T09:00:00Z");
  const state = { lastSlotAt: at("2026-10-11T08:20:00Z") };
  assert.equal(upcomingAt(job(), state, now), at("2026-10-11T10:20:00Z"));
  assert.equal(upcomingAt(job({ paused: true }), state, now), null);
  assert.equal(upcomingAt(job(), state, now, { globalPause: true }), null);
  assert.equal(upcomingAt(job({ enabled: false }), state, now), null);
  assert.equal(upcomingAt(job(), { ...state, due: { id: "r1" } }, now), null);
  assert.equal(upcomingAt(job({ schedule: { every: "1h" } }), { lastFinishedAt: at("2026-10-11T08:30:00Z") }, now), at("2026-10-11T09:30:00Z"));
});

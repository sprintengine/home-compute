import assert from "node:assert/strict";
import test from "node:test";
import { ACTIVE_STATES, RUN_STATES, TERMINAL_STATES, transition } from "../src/core/run.mjs";

const T = 1_791_700_000_000;
const run = (state, extra = {}) => ({ id: "r_1", jobId: "ecmwf", state, ...extra });
const report = { format: "json-lines", trackEvent: "forecast_complete", trackBy: "model" };

const EVENTS = {
  claim: { type: "claim", machineId: "m_1", leaseExpiresAt: T + 90_000, at: T },
  "starting-vm": { type: "phase", phase: "starting-vm", at: T },
  pulling: { type: "phase", phase: "pulling", at: T },
  running: { type: "phase", phase: "running", at: T },
  reporting: { type: "phase", phase: "reporting", at: T },
  renew: { type: "renew", leaseExpiresAt: T + 180_000 },
  complete: { type: "complete", exitCode: 0, reports: [], at: T },
  timeout: { type: "timeout", at: T },
  expire: { type: "expire", at: T },
  skip: { type: "skip", reason: "expired", at: T },
  cancel: { type: "cancel", at: T },
};

/** Every state each event may leave from; anything else must be refused. */
const LEGAL = {
  claim: ["due"],
  "starting-vm": ["claimed", "starting-vm"],
  pulling: ["claimed", "starting-vm", "pulling"],
  running: ["claimed", "starting-vm", "pulling", "running"],
  reporting: ["claimed", "starting-vm", "pulling", "running", "reporting"],
  renew: ACTIVE_STATES,
  complete: [...ACTIVE_STATES, "lost"],
  timeout: ["running", "reporting"],
  expire: ACTIVE_STATES,
  skip: ["due"],
  cancel: ["due", ...ACTIVE_STATES],
};

test("every event is allowed from exactly the states the design gives it", () => {
  for (const [name, event] of Object.entries(EVENTS)) {
    for (const state of RUN_STATES) {
      const legal = LEGAL[name].includes(state);
      if (legal) {
        assert.doesNotThrow(() => transition(run(state), event), `${name} from ${state}`);
      } else {
        assert.throws(() => transition(run(state), event), (error) => error.code === "illegal_transition" && error.status === 409,
          `${name} from ${state} must be refused`);
      }
    }
  }
});

test("terminal states take no event at all", () => {
  for (const state of TERMINAL_STATES) {
    for (const event of Object.values(EVENTS)) assert.throws(() => transition(run(state), event), /cannot take/);
  }
});

test("a run moves forward through its phases, which may be skipped but never revisited", () => {
  let current = transition(run("due"), EVENTS.claim);
  assert.deepEqual([current.state, current.machineId, current.claimedAt, current.leaseExpiresAt], ["claimed", "m_1", T, T + 90_000]);
  current = transition(current, { type: "phase", phase: "running", at: T + 5000 });
  assert.deepEqual([current.state, current.startedAt, current.vmStartedAt], ["running", T + 5000, undefined], "a Docker host skips the VM and the pull");
  assert.equal(transition(current, { type: "phase", phase: "running", at: T + 9000 }), current, "a repeated phase is a heartbeat");
  assert.throws(() => transition(current, EVENTS.pulling), /never go back/);
  assert.throws(() => transition(current, { type: "phase", phase: "sleeping" }), /unknown phase/);
  assert.throws(() => transition(run("due"), { type: "claim" }), /names its machine/);
  current = transition(current, { type: "phase", phase: "reporting", at: T + 7000 });
  assert.equal(current.reportingAt, T + 7000);
});

test("completion settles the state and the outcome from the facts", () => {
  const running = run("running", { leaseExpiresAt: T + 1 });
  const published = transition(running, {
    type: "complete", exitCode: 0, at: T, report,
    reports: [{ event: "forecast_complete", model: "ecmwf", run: "2026101100" }],
  });
  assert.deepEqual([published.state, published.outcome, published.finishedAt, published.leaseExpiresAt, published.recovered],
    ["succeeded", "published", T, null, false]);
  const unchanged = transition(running, { type: "complete", exitCode: 0, report, reports: [{ event: "forecast_unchanged" }] });
  assert.deepEqual([unchanged.state, unchanged.outcome], ["succeeded", "unchanged"], "ran, nothing new");
  const exited = transition(running, { type: "complete", exitCode: 2, reports: [] });
  assert.deepEqual([exited.state, exited.outcome, exited.error], ["failed", "failed", "exited with 2"]);
  const refused = transition(running, { type: "complete", exitCode: null, failed: true, error: "pull failed: manifest unknown" });
  assert.deepEqual([refused.state, refused.outcome, refused.error], ["failed", "failed", "pull failed: manifest unknown"],
    "a run that failed before it had an exit code");
  const reported = transition(running, { type: "complete", exitCode: 0, reports: [{ event: "forecast_failed", error: "HTTP 503" }] });
  assert.deepEqual([reported.state, reported.error], ["failed", "HTTP 503"], "a *_failed report fails a zero exit");
  const oom = transition(running, { type: "complete", exitCode: 137, oomKilled: true });
  assert.deepEqual([oom.state, oom.oomKilled, oom.error], ["failed", true, "out of memory"]);
  const timedOut = transition(running, { type: "complete", exitCode: 143, timedOut: true, error: "timed out after 3900 s" });
  assert.deepEqual([timedOut.state, timedOut.outcome, timedOut.error], ["timed-out", "failed", "timed out after 3900 s"]);
});

test("a lost run that reports late is recovered", () => {
  const lost = transition(run("running", { machineId: "m_1", leaseExpiresAt: T }), EVENTS.expire);
  assert.deepEqual([lost.state, lost.leaseExpiresAt, lost.machineId], ["lost", null, "m_1"]);
  assert.throws(() => transition(lost, EVENTS.cancel), /already finished/);
  assert.throws(() => transition(lost, EVENTS.running), /active run/);
  const recovered = transition(lost, { type: "complete", exitCode: 0, reports: [], at: T + 60_000 });
  assert.deepEqual([recovered.state, recovered.outcome, recovered.recovered, recovered.finishedAt], ["succeeded", "completed", true, T + 60_000]);
  const failed = transition(lost, { type: "complete", exitCode: 1 });
  assert.deepEqual([failed.state, failed.recovered], ["failed", true]);
});

test("the server's backstops: timeouts, skips and cancels", () => {
  const timedOut = transition(run("running", { leaseExpiresAt: T }), EVENTS.timeout);
  assert.deepEqual([timedOut.state, timedOut.outcome, timedOut.timedOut, timedOut.leaseExpiresAt], ["timed-out", "failed", true, null]);
  const skipped = transition(run("due"), { type: "skip", reason: "expired", at: T });
  assert.deepEqual([skipped.state, skipped.skipReason, skipped.finishedAt], ["skipped", "expired", T]);
  assert.throws(() => transition(run("due"), { type: "skip", reason: "bored" }), /unknown reason/);
  const cancelled = transition(run("pulling", { leaseExpiresAt: T }), EVENTS.cancel);
  assert.deepEqual([cancelled.state, cancelled.leaseExpiresAt, cancelled.finishedAt], ["cancelled", null, T]);
  assert.throws(() => transition(run("due"), { type: "dance" }), /unknown event/);
});

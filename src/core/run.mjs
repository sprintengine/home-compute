// A hosted run's life (§3.1 of docs/hosted-control-plane.md):
//
//   due ─claim→ claimed → starting-vm → pulling → running → reporting → succeeded | failed | timed-out
//    │                (phases may be skipped, never revisited)
//    ├─skip→ skipped (coalesced | overlap | expired | paused-at-slot)
//    └─cancel→ cancelled ←cancel─ any non-terminal state
//   lease expired while claimed…reporting → lost ─(late complete)→ succeeded | failed, recovered
//
// `transition` is pure: it returns the run as the event leaves it, or throws a
// TransitionError for an event the run's state does not allow.

import { reportedError, runOutcome } from "./reports.mjs";

/** Claimed or later and not finished: the states `runs_one_active` allows one of per job. */
export const ACTIVE_STATES = ["claimed", "starting-vm", "pulling", "running", "reporting"];
export const NON_TERMINAL_STATES = ["due", ...ACTIVE_STATES];
export const TERMINAL_STATES = ["succeeded", "failed", "timed-out", "cancelled", "skipped"];
export const RUN_STATES = [...NON_TERMINAL_STATES, ...TERMINAL_STATES, "lost"];
export const SKIP_REASONS = ["coalesced", "overlap", "expired", "paused-at-slot"];

const PHASE_FIELDS = {
  "starting-vm": "vmStartedAt",
  pulling: "pullStartedAt",
  running: "startedAt",
  reporting: "reportingAt",
};
const PHASES = Object.keys(PHASE_FIELDS);

export class TransitionError extends Error {
  constructor(run, event, reason) {
    super(`A ${run.state} run cannot take ${event.type}${event.phase ? ` (${event.phase})` : ""}: ${reason}`);
    this.code = "illegal_transition";
    this.status = 409;
  }
}

export function isActive(state) {
  return ACTIVE_STATES.includes(state);
}

export function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}

/** The state and outcome a finished run's facts give it. */
function settle({ exitCode, oomKilled, timedOut, reports = [], report, error }) {
  const outcome = runOutcome({ exitCode, oomKilled, timedOut, reports, report });
  let message = error ?? null;
  if (outcome === "failed" && !message) {
    message = reportedError(reports)
      ?? (timedOut ? "timed out" : oomKilled ? "out of memory" : exitCode !== undefined && exitCode !== null && exitCode !== 0 ? `exited with ${exitCode}` : null);
  }
  return { state: timedOut ? "timed-out" : outcome === "failed" ? "failed" : "succeeded", outcome, error: message };
}

/**
 * The run after `event`. Events (`at` is the server's receipt time, epoch ms):
 *
 * - `{type: "claim", machineId, leaseExpiresAt, at}`: due → claimed.
 * - `{type: "phase", phase, at}`: forward through starting-vm, pulling,
 *   running, reporting; a phase may be skipped (Docker hosts have no VM to
 *   start; a cached image needs no pull). Repeating the current phase is a
 *   heartbeat and changes nothing.
 * - `{type: "renew", leaseExpiresAt}`: extends an active run's lease.
 * - `{type: "complete", exitCode, oomKilled, timedOut, reports, report, error, at}`:
 *   active → succeeded | failed | timed-out; lost → the same with `recovered`.
 * - `{type: "timeout", at}`: the server's backstop for a started run → timed-out.
 * - `{type: "expire", at}`: its lease ran out while claimed…reporting → lost.
 * - `{type: "skip", reason, at}`: a due run that will not run (expired, say) → skipped.
 * - `{type: "cancel", at}`: any non-terminal state → cancelled.
 */
export function transition(run, event) {
  const { state } = run;
  const at = event.at ?? null;
  const refuse = (reason) => { throw new TransitionError(run, event, reason); };
  switch (event.type) {
    case "claim":
      if (state !== "due") refuse("only a due run can be claimed");
      if (!event.machineId) refuse("a claim names its machine");
      return { ...run, state: "claimed", machineId: event.machineId, leaseExpiresAt: event.leaseExpiresAt ?? null, claimedAt: at };
    case "phase": {
      if (!PHASES.includes(event.phase)) refuse(`unknown phase ${JSON.stringify(event.phase)}`);
      if (!isActive(state)) refuse("only an active run moves through phases");
      if (event.phase === state) return run;
      if (PHASES.indexOf(event.phase) < PHASES.indexOf(state)) refuse("phases never go back");
      return { ...run, state: event.phase, [PHASE_FIELDS[event.phase]]: at };
    }
    case "renew":
      if (!isActive(state)) refuse("only an active run holds a lease");
      return { ...run, leaseExpiresAt: event.leaseExpiresAt };
    case "complete": {
      if (!isActive(state) && state !== "lost") refuse("only an active or lost run can complete");
      const settled = settle(event);
      return {
        ...run,
        ...settled,
        exitCode: event.exitCode ?? null,
        oomKilled: Boolean(event.oomKilled),
        timedOut: Boolean(event.timedOut),
        finishedAt: at,
        leaseExpiresAt: null,
        recovered: state === "lost" || Boolean(run.recovered),
      };
    }
    case "timeout":
      if (state !== "running" && state !== "reporting") refuse("only a started run can time out");
      return { ...run, state: "timed-out", outcome: "failed", timedOut: true, error: run.error ?? "timed out", finishedAt: at, leaseExpiresAt: null };
    case "expire":
      if (!isActive(state)) refuse("only an active run holds a lease to lose");
      return { ...run, state: "lost", leaseExpiresAt: null };
    case "skip":
      if (state !== "due") refuse("only a due run can be skipped");
      if (!SKIP_REASONS.includes(event.reason)) refuse(`unknown reason ${JSON.stringify(event.reason)}`);
      return { ...run, state: "skipped", skipReason: event.reason, finishedAt: at };
    case "cancel":
      if (!NON_TERMINAL_STATES.includes(state)) refuse("the run has already finished");
      return { ...run, state: "cancelled", finishedAt: at, leaseExpiresAt: null };
    default:
      return refuse("unknown event");
  }
}

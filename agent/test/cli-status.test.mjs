// The terminal side of the local status API: status, status --json,
// history, watch, pause, resume, drain and restart, against a running agent
// (and without one), plus the formatting they share.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { Agent } from "../src/agent.mjs";
import { main } from "../src/cli.mjs";
import { RunHistory } from "../src/history.mjs";
import { FakeRuntime } from "../src/runtime/fake.mjs";
import { duration, formatStatus, historyLine, outcomeText } from "../src/status-format.mjs";
import { startStatusServer } from "../src/status-server.mjs";
import { claimFor, CONFIG, controlPlane, events, runId, tempState, until } from "./support.mjs";

function io() {
  const out = [];
  const error = [];
  return { out: (text) => out.push(text), error: (text) => error.push(text), stdin: Readable.from([""]), lines: out, errors: error, isTTY: false,
    sleep: async () => {} };
}

async function running(t, { runtime = new FakeRuntime() } = {}) {
  const state = await tempState(t);
  const plane = controlPlane();
  const agent = new Agent({ state, config: { ...CONFIG }, credential: "hca_x", runtime, fetch: plane.fetch, log: events() });
  await agent.start();
  t.after(() => agent.kill());
  const server = await startStatusServer({ agent, token: await state.statusToken(), port: 0 });
  t.after(() => server.close());
  await state.saveConfig({ ...CONFIG, statusPort: server.port });
  return { state, plane, agent, server };
}

test("status shows what runs now and the recent runs; --json is the API's answer plus history", async (t) => {
  const runtime = new FakeRuntime({ scripts: { bad: { output: ["Error: HTTP 503 from the source"], exitCode: 1 }, slow: { output: ["…", { cpuPct: 40, memoryBytes: 300 * 1048576 }], hang: true } } });
  const { state, plane, agent } = await running(t, { runtime });
  plane.claims.push(claimFor(runId(), {}, { jobId: "bad" }));
  await agent.syncOnce();
  await agent.idle();
  const slow = runId();
  plane.claims.push(claimFor(slow, {}, { jobId: "slow" }));
  await agent.syncOnce();
  await until(() => agent.runs.get(slow)?.stats.samples > 0);

  const text = io();
  assert.equal(await main(["status", "--state-dir", state.dir], text), 0, text.errors.join("\n"));
  const printed = text.lines.join("\n");
  assert.match(printed, /^box \(m_.*\) → https:\/\/core\.test$/m);
  assert.match(printed, /^taking jobs: yes$/m);
  assert.match(printed, /^now: slow \(r_\w+\) running \d+s · CPU 40% · 300 MiB of 256 MiB$/m);
  assert.match(printed, /^recent:\n {2}✗ bad .* exit 1: Error: HTTP 503 from the source$/m);

  const json = io();
  assert.equal(await main(["status", "--json", "--state-dir", state.dir], json), 0);
  const answer = JSON.parse(json.lines.join("\n"));
  assert.deepEqual([answer.running, answer.statusApi, answer.current[0].job, answer.history[0].job, answer.history[0].passed], [true, 1, "slow", "bad", false]);

  const history = io();
  assert.equal(await main(["history", "--limit", "5", "--state-dir", state.dir], history), 0);
  assert.match(history.lines[0], /^✗ bad /);
  assert.equal(await main(["history", "--limit", "0", "--state-dir", state.dir], io()), 1);
});

test("pause, resume, drain and restart from the command line; --token-file and --status-port reach an agent whose state is elsewhere", async (t) => {
  const { state, agent, server } = await running(t);
  const pause = io();
  assert.equal(await main(["pause", "--state-dir", state.dir], pause), 0, pause.errors.join("\n"));
  assert.match(pause.lines[0], /^Paused/);
  assert.equal(agent.paused, true);
  assert.equal((await state.readLocalState()).paused, true);
  const status = io();
  await main(["status", "--state-dir", state.dir], status);
  assert.match(status.lines.join("\n"), /^taking jobs: no \(paused on this machine since \d\d:\d\d\)$/m);

  // Another user: no readable state directory, only a copy of the token.
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), "hc-other-user-"));
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  const copy = path.join(elsewhere, "agent-status-token");
  await writeFile(copy, `${await state.statusToken()}\n`, { mode: 0o600 });
  const resume = io();
  assert.equal(await main(["resume", "--state-dir", path.join(elsewhere, "none"), "--token-file", copy, "--status-port", String(server.port)], resume), 0,
    resume.errors.join("\n"));
  assert.equal(agent.paused, false);
  const drain = io();
  assert.equal(await main(["drain", "--state-dir", state.dir], drain), 0);
  assert.equal(agent.draining, true);
  assert.equal(await main(["drain", "--cancel", "--state-dir", state.dir], io()), 0);
  assert.equal(agent.draining, false);
  const restart = io();
  assert.equal(await main(["restart", "--state-dir", state.dir], restart), 0);
  await until(() => agent.restartRequested);
  assert.match(restart.lines[0], /^Restarting/);
});

test("without a running agent: status says so and shows the history file; control commands fail; watch keeps trying", async (t) => {
  const state = await tempState(t);
  await state.saveConfig({ ...CONFIG, statusPort: 1 });
  await state.statusToken();
  await new RunHistory(state.dir).append({ v: 1, type: "run", run: "r_1", job: "gfs", outcome: "published", finishedAt: new Date().toISOString(), durationMs: 64_000,
    published: [{ key: "gfs", run: "2026101812" }] });
  const status = io();
  assert.equal(await main(["status", "--state-dir", state.dir], status), 1);
  assert.match(status.lines.join("\n"), /not running[\s\S]*recent:\n {2}✓ gfs .* 1m 04s {2}published gfs 2026101812/);
  const json = io();
  assert.equal(await main(["status", "--json", "--state-dir", state.dir], json), 1);
  assert.deepEqual([JSON.parse(json.lines.join("\n")).running, JSON.parse(json.lines.join("\n")).history.length], [false, 1]);
  const pause = io();
  assert.equal(await main(["pause", "--state-dir", state.dir], pause), 1);
  assert.match(pause.errors[0], /not running/);
  const watch = io();
  assert.equal(await main(["watch", "--count", "2", "--state-dir", state.dir], watch), 0);
  assert.equal(watch.lines.length, 1, "unchanged text is printed once when not on a terminal");
  assert.match(watch.lines[0], /not running/);
});

test("watch redraws a running agent's status on a terminal", async (t) => {
  const { state } = await running(t);
  const watch = { ...io(), isTTY: true };
  assert.equal(await main(["watch", "--count", "2", "--interval", "0.01", "--state-dir", state.dir], watch), 0);
  assert.equal(watch.lines.length, 2);
  assert.ok(watch.lines.every((line) => line.startsWith("\x1b[H\x1b[2J") && /taking jobs: yes/.test(line)));
});

test("formatting: durations, outcomes and a status with every reason not to claim", () => {
  assert.deepEqual([duration(42_000), duration(245_000), duration(3_780_000), duration(undefined)], ["42s", "4m 05s", "1h 03m", "?"]);
  assert.equal(outcomeText({ outcome: "failed", exitCode: null, error: "pull failed: denied" }), "pull failed: denied");
  assert.equal(outcomeText({ outcome: "failed", exitCode: 137, oomKilled: true }), "exit 137: out of memory");
  assert.equal(outcomeText({ outcome: "cancelled" }), "cancelled");
  assert.ok(historyLine({ passed: false, job: "x", outcome: "failed", error: "e".repeat(300) }).length <= 100);
  const text = formatStatus({
    name: "box", machineId: "m_1", server: "https://core", connection: "offline", lastSyncAt: null, nextSyncAt: null, clockSkewMs: null,
    notClaimingBecause: ["draining", "drained-on-dashboard", "full"], runtime: { kind: "fake", ok: true }, current: [], runs: [], outbox: 1, upcoming: [],
    lastError: "https://core is unreachable: ECONNREFUSED",
  });
  assert.match(text, /^taking jobs: no \(draining before a restart; drained from the dashboard\)$/m);
  assert.match(text, /^now: nothing running$/m);
  assert.match(text, /^last error: https:\/\/core is unreachable/m);
});

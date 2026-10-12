// The daemon's log lines carry their time (controller.log had none).
import assert from "node:assert/strict";
import test from "node:test";
import { stampConsole, stampLine } from "../src/log.mjs";

const NOW = new Date("2026-10-12T16:05:05.368Z");

test("a JSON event gets `at` first; other lines get the time in front; an event with `at` is left alone", () => {
  assert.equal(stampLine('{"event":"job_submitted","job":"blend"}', NOW), '{"at":"2026-10-12T16:05:05.368Z","event":"job_submitted","job":"blend"}');
  assert.equal(stampLine("home-compute: boom", NOW), "2026-10-12T16:05:05.368Z home-compute: boom");
  assert.equal(stampLine('{"at":"x","event":"e"}', NOW), '{"at":"x","event":"e"}');
  assert.equal(stampLine("{not json", NOW), "2026-10-12T16:05:05.368Z {not json");
  assert.equal(stampLine("[1,2]", NOW), "2026-10-12T16:05:05.368Z [1,2]");
});

test("the daemon's console stamps every log and error line, and can be undone", () => {
  const written = [];
  const target = { log: (...args) => written.push(["log", ...args]), error: (...args) => written.push(["error", ...args]), info() {}, warn() {} };
  const undo = stampConsole(target, () => NOW);
  target.log(JSON.stringify({ event: "job_finished", job: "gfs" }));
  target.error(JSON.stringify({ event: "status_error", error: "timeout" }));
  target.log({ object: true });
  undo();
  target.log("plain");
  assert.deepEqual(written, [
    ["log", '{"at":"2026-10-12T16:05:05.368Z","event":"job_finished","job":"gfs"}'],
    ["error", '{"at":"2026-10-12T16:05:05.368Z","event":"status_error","error":"timeout"}'],
    ["log", { object: true }],
    ["log", "plain"],
  ]);
});

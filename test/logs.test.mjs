import assert from "node:assert/strict";
import test from "node:test";
import { classifyLines, tailLines } from "../src/logs.mjs";

test("error lines, tracebacks, warnings and reports are told apart", () => {
  const levels = classifyLines([
    "Fetching ICON-EU 2026101106",
    "WARNING: frame +071h arrived late",
    "Traceback (most recent call last):",
    '  File "/app/run.py", line 12, in main',
    "    publish()",
    "botocore.exceptions.ClientError: An error occurred (SlowDown)",
    "carrying on",
    "ERROR could not reach the bucket",
    '{"level": "error", "msg": "boom"}',
    '{"event": "forecast_failed", "model": "gfs"}',
    '{"event": "forecast_complete", "model": "gfs", "seconds": 4}',
    "retries 3, failures 1",
    "ValueError: bad grid",
  ]).map((line) => line.level);
  assert.deepEqual(levels, [
    "info", "warning", "error", "error", "error", "error", "info", "error", "error", "error", "report", "info", "error",
  ]);
});

test("tailLines keeps the end and says how much it left out", () => {
  assert.deepEqual(tailLines("a\nb\nc\n", 2), { lines: ["b", "c"], omitted: 1 });
  assert.deepEqual(tailLines("a\r\nb", 5), { lines: ["a", "b"], omitted: 0 });
  assert.deepEqual(tailLines("", 5), { lines: [], omitted: 0 });
});

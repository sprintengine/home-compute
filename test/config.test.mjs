import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseDuration, readEnvFile, validateConfig } from "../src/config.mjs";

test("parseDuration accepts explicit units", () => {
  assert.equal(parseDuration("30s"), 30_000);
  assert.equal(parseDuration("15m"), 900_000);
  assert.equal(parseDuration("2h"), 7_200_000);
  assert.equal(parseDuration("1d"), 86_400_000);
  assert.throws(() => parseDuration("15"), /Invalid duration/);
  assert.throws(() => parseDuration("0m"), /greater than zero/);
});

test("validateConfig rejects duplicate job IDs", () => {
  const job = { id: "forecast", schedule: { every: "15m" }, task: { image: "example/image" } };
  assert.throws(() => validateConfig({ jobs: [job, { ...job }] }), /Duplicate job id/);
});

test("readEnvFile reads comments, quotes, and empty optional values", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "home-compute-test-"));
  const filename = path.join(directory, ".env");
  await writeFile(filename, "# comment\nIMAGE='registry/image:tag'\nEMPTY=\nREGION=eu-west-1\n");
  assert.deepEqual(await readEnvFile(filename), {
    IMAGE: "registry/image:tag",
    EMPTY: "",
    REGION: "eu-west-1",
  });
});

test("validateConfig accepts UTC slots and rejects malformed ones", async () => {
  const { validateConfig } = await import("../src/config.mjs");
  const base = (schedule) => ({ jobs: [{ id: "a", schedule, task: { image: "x" } }] });
  validateConfig(base({ at: { hours: [3, 9], minutes: [30] } }));
  validateConfig(base({ at: { minutes: [45] }, timezone: "UTC" }));
  assert.throws(() => validateConfig(base({ at: { hours: [24] } })), /0 to 23/);
  assert.throws(() => validateConfig(base({ at: { minutes: [] } })), /non-empty/);
  assert.throws(() => validateConfig(base({ at: {}, every: "1h" })), /exactly one/);
  assert.throws(() => validateConfig(base({ at: {}, timezone: "Europe/Dublin" })), /UTC/);
});

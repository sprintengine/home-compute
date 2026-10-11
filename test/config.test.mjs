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

test("dashboard, history and timetable sections are checked", async () => {
  const { validateConfig } = await import("../src/config.mjs");
  const base = (extra) => ({ jobs: [{ id: "a", schedule: { every: "1h" }, task: { image: "x" } }], ...extra });
  validateConfig(base({
    history: { keep: 50 },
    dashboard: { allowedLogins: ["me@example.com"], allowedLoginsEnv: "LOGINS", hosts: ["mac.example.ts.net"], sessionHours: 24 },
    timetable: { command: ["./macmini.sh", "jobs", "set"], timeoutSeconds: 60 },
  }));
  assert.throws(() => validateConfig(base({ history: { keep: 0 } })), /keep/);
  assert.throws(() => validateConfig(base({ dashboard: { allowedLogins: "me" } })), /allowedLogins/);
  assert.throws(() => validateConfig(base({ dashboard: { allowedLoginsEnv: "bad-name" } })), /allowedLoginsEnv/);
  assert.throws(() => validateConfig(base({ timetable: { command: "macmini.sh jobs set" } })), /non-empty array/);
  assert.throws(() => validateConfig(base({ timetable: { command: ["macmini.sh"] } })), /must be a path/);
  assert.throws(() => validateConfig(base({ timetable: { command: ["./x"], timeoutSeconds: 0 } })), /timeoutSeconds/);
});

test("a reload names what it changes and what needs a restart", async () => {
  const { configDifferences, dashboardSettings } = await import("../src/config.mjs");
  const job = (id, every = "1h") => ({ id, schedule: { every }, task: { image: "x" } });
  const differences = configDifferences(
    { pollEvery: "30s", jobs: [job("a"), job("b"), job("c")] },
    { pollEvery: "1m", jobs: [job("a"), job("b", "2h"), job("d")] },
  );
  assert.deepEqual(differences, { added: ["d"], removed: ["c"], changed: ["b"], restartRequired: ["pollEvery"] });
  assert.deepEqual(dashboardSettings({ dashboard: { allowedLogins: ["a@x"], allowedLoginsEnv: "L" } }, { L: "b@x, c@x" }).allowedLogins,
    ["a@x", "b@x", "c@x"]);
  assert.deepEqual(dashboardSettings({}, {}).allowedLogins, []);
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveTimetableCommand, runTimetableCommand, timetableArguments } from "../src/timetable.mjs";

const FAKE = path.resolve(import.meta.dirname, "fixtures/fake-timetable.mjs");
const slots = { id: "gfs", schedule: { at: { hours: [4, 10], minutes: [0] } }, task: { image: "x" } };

test("timetable changes become checked arguments, never request text", () => {
  assert.deepEqual(timetableArguments(slots, { enabled: false }), ["gfs", "--enabled", "false"]);
  assert.deepEqual(timetableArguments(slots, { hours: [22, 4, 4, 10], minutes: [30, 0] }),
    ["gfs", "--hours", "4,10,22", "--minutes", "0,30"]);
  assert.deepEqual(timetableArguments(slots, { hours: "every" }), ["gfs", "--hours", "every"]);
  for (const [changes, message] of [
    [{}, /Nothing to change/],
    [{ enabled: "false" }, /true or false/],
    [{ hours: [24] }, /0 to 23/],
    [{ hours: ["4; rm -rf /"] }, /whole numbers/],
    [{ minutes: [] }, /non-empty/],
    [{ minutes: [1.5] }, /whole numbers/],
    [{ memory: "8Gb" }, /Unknown timetable field memory/],
    [[], /must be an object/],
  ]) {
    assert.throws(() => timetableArguments(slots, changes), message, JSON.stringify(changes));
  }
  const interval = { id: "sweep", schedule: { every: "1h" }, task: { image: "x" } };
  assert.throws(() => timetableArguments(interval, { minutes: [5] }), /interval/);
  assert.deepEqual(timetableArguments(interval, { enabled: true }), ["sweep", "--enabled", "true"]);
});

test("the command is resolved against the configuration's directory", () => {
  const command = resolveTimetableCommand({ filename: "/srv/wingfoil/home-compute.json", timetable: { command: ["./macmini.sh", "jobs", "set"] } });
  assert.deepEqual(command, { file: "/srv/wingfoil/macmini.sh", args: ["jobs", "set"], cwd: "/srv/wingfoil" });
  assert.equal(resolveTimetableCommand({ filename: "/a/b.json" }), undefined);
});

test("the command's answer and refusals come back as such", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "home-compute-timetable-"));
  const configFile = path.join(directory, "config.json");
  await writeFile(configFile, JSON.stringify({ jobs: [structuredClone(slots)] }));
  const command = { file: FAKE, args: [configFile], cwd: directory };

  assert.deepEqual(await runTimetableCommand(command, ["gfs", "--minutes", "5,35"]), { ok: true, restartRequired: true });
  assert.deepEqual(JSON.parse(await readFile(configFile, "utf8")).jobs[0].schedule.at.minutes, [5, 35]);

  await assert.rejects(() => runTimetableCommand(command, ["gfs", "--minutes", "7"]),
    (error) => error.status === 422 && /5-minute mark/.test(error.message));
  await assert.rejects(() => runTimetableCommand({ ...command, file: path.join(directory, "missing") }, ["gfs"]),
    (error) => error.status === 500 && /failed/.test(error.message));
});

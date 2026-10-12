// The state directory, the outbox, log capture and the image policy.
import assert from "node:assert/strict";
import { chmod, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { LogCapture } from "../src/capture.mjs";
import { Outbox } from "../src/outbox.mjs";
import { isLocalImage, specRefusal } from "../src/policy.mjs";
import { defaultStateDir, parseEnvFile } from "../src/state.mjs";
import { CONFIG, runId, tempState } from "./support.mjs";

const mode = async (file) => (await stat(file)).mode & 0o777;

test("the state directory defaults per OS and can be set", () => {
  const home = "/home/me";
  assert.equal(defaultStateDir({ platform: "darwin", env: {}, home }), "/home/me/Library/Application Support/home-compute");
  assert.equal(defaultStateDir({ platform: "linux", env: {}, home, uid: 0, canWrite: () => false }), "/etc/home-compute");
  assert.equal(defaultStateDir({ platform: "linux", env: {}, home, uid: 1000, canWrite: () => true }), "/etc/home-compute");
  assert.equal(defaultStateDir({ platform: "linux", env: {}, home, uid: 1000, canWrite: () => false }), "/home/me/.local/state/home-compute");
  assert.equal(defaultStateDir({ platform: "linux", env: { XDG_STATE_HOME: "/x" }, home, uid: 1000, canWrite: () => false }), "/x/home-compute");
  assert.equal(defaultStateDir({ platform: "win32", env: {}, home }), "/home/me/.home-compute");
  assert.equal(defaultStateDir({ platform: "darwin", env: { HC_AGENT_STATE_DIR: "/tmp/hc" }, home }), "/tmp/hc");
});

test("configuration, credential, status token and local state are 0600 in a 0700 directory", async (t) => {
  const state = await tempState(t);
  await state.saveConfig({ ...CONFIG, caps: { maxRuns: 1 } });
  await state.writeCredential("hca_secret");
  const token = await state.statusToken();
  await state.writeLocalState({ drain: true });
  assert.equal(await mode(state.dir), 0o700);
  for (const file of [state.configPath, state.credentialPath, state.statusTokenPath, state.localStatePath]) assert.equal(await mode(file), 0o600, file);
  assert.equal(await state.readCredential(), "hca_secret");
  assert.equal(await state.statusToken(), token, "made once");
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.deepEqual((await state.loadConfig()).caps, { maxRuns: 1 });
  assert.deepEqual(await state.permissionProblems(), []);
  await chmod(state.credentialPath, 0o644);
  assert.deepEqual((await state.permissionProblems()).map((problem) => [problem.mode, problem.expected]), [["644", "600"]]);
  await assert.rejects(state.saveConfig({ ...CONFIG, runtime: "podman" }), /runtime must be one of/);
});

test("the env file holds local secrets as NAME=value lines", () => {
  const values = parseEnvFile(`# local secrets\nAPI_TOKEN=abc def\nexport QUOTED="x=y"\nSINGLE='z'\nnot a line\n\nEMPTY=`);
  assert.deepEqual(Object.fromEntries(values), { API_TOKEN: "abc def", QUOTED: "x=y", SINGLE: "z", EMPTY: "" });
});

test("the outbox keeps a record as a 0600 file until it is removed", async (t) => {
  const state = await tempState(t);
  const outbox = new Outbox(state);
  const id = runId();
  await outbox.put(id, { exitCode: 0 });
  assert.deepEqual(await outbox.ids(), [id]);
  assert.equal(await mode(outbox.pathOf(id)), 0o600);
  assert.deepEqual(await outbox.get(id), { exitCode: 0 });
  await outbox.remove(id);
  assert.deepEqual(await outbox.ids(), []);
  assert.throws(() => outbox.pathOf("../../etc/passwd"), /Not a run id/);
});

test("run records and old local logs", async (t) => {
  const state = await tempState(t);
  const id = runId();
  await state.writeRunRecord(id, { startedAt: 1 });
  assert.deepEqual([...(await state.readRunRecords()).entries()], [[id, { startedAt: 1 }]]);
  await state.removeRunRecord(id);
  assert.equal((await state.readRunRecords()).size, 0);
  await writeFile(state.logPath(id), "old");
  const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000);
  await utimes(state.logPath(id), eightDaysAgo, eightDaysAgo);
  assert.equal(await state.pruneLogs(), 1);
});

test("output is redacted on arrival, bounded in the tail, and its reports are kept apart from the tail", async (t) => {
  const state = await tempState(t);
  const secret = "fake-s3cr3t/value";
  const file = state.logPath(runId());
  const capture = new LogCapture({ secrets: [secret], file });
  capture.push(`connecting with ${secret}`);
  capture.push(`encoded ${Buffer.from(secret).toString("base64")} and ${encodeURIComponent(secret)}`);
  capture.push(JSON.stringify({ event: "forecast_complete", model: "ecmwf", token: secret }));
  capture.push("Authorization: Bearer abcdefghijklmnopqrstuvwxyz");
  for (let index = 0; index < 1200; index += 1) capture.push(`line ${index} ${"x".repeat(80)}`);
  capture.push("y".repeat(10_000));
  const running = capture.pendingTail();
  assert.ok(running.text.length <= 32 * 1024 && running.text.split("\n").length <= 200);
  assert.equal(running.truncated, true);
  assert.equal(running.linesTotal, 1205);
  assert.match(running.text, /…\[line cut\]$/, "a long line is cut");
  capture.markSent(running.version);
  assert.equal(capture.pendingTail(), null, "unchanged since the last sync");
  capture.push("one more");
  assert.ok(capture.pendingTail());
  const final = capture.finalTail();
  assert.ok(final.text.length <= 64 * 1024 && final.text.split("\n").length <= 500);
  assert.ok(!final.text.includes("forecast_complete"), "the report scrolled out of the tail");
  assert.deepEqual(capture.reports, [{ event: "forecast_complete", model: "ecmwf", token: "<redacted>" }]);
  await capture.close();
  const saved = gunzipSync(await readFile(file)).toString();
  assert.ok(!saved.includes(secret) && !saved.includes(encodeURIComponent(secret)) && !saved.includes(Buffer.from(secret).toString("base64")));
  assert.match(saved, /^connecting with <redacted>\nencoded <redacted> and <redacted>\n/);
  assert.match(saved, /Bearer <redacted>/);
  assert.equal(await mode(file), 0o600);
});

test("the machine's policy: allowImages, local images, networks", () => {
  assert.equal(isLocalImage("wingfoil-forecast:local"), true);
  assert.equal(isLocalImage("alpine"), true);
  assert.equal(isLocalImage("user/app"), true);
  assert.equal(isLocalImage("ghcr.io/sprintengine/wingfoil@sha256:1"), false);
  assert.equal(isLocalImage("localhost:5000/x"), false);
  const config = { allowImages: ["ghcr.io/sprintengine/*"], allowLocalImages: false };
  assert.equal(specRefusal({ image: "ghcr.io/sprintengine/wingfoil@sha256:1", network: "bridge" }, config), null);
  assert.match(specRefusal({ image: "ghcr.io/evil/miner:latest" }, config), /allowImages/);
  assert.match(specRefusal({ image: "wingfoil-forecast:local" }, config), /allowLocalImages/);
  assert.equal(specRefusal({ image: "wingfoil-forecast:local" }, { allowImages: ["*"], allowLocalImages: true }), null);
  assert.match(specRefusal({ image: "ghcr.io/sprintengine/x", network: "host" }, config), /network host/);
});

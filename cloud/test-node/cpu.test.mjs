// CPU per request, estimated: workerd's clock is too coarse for the Workers'
// own CPU time, so this measures the JavaScript a request runs (D1 waiting is
// not CPU) with process.cpuUsage, warm, on the real Wingfoil timetable. The
// Free plan allows 10 ms per request; the design's target is p99 < 4 ms.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { jobFromV1, planImport, validatePreset } from "../../src/core/importer.mjs";
import { materialise } from "../../src/core/schedule.mjs";
import { verifyAccessJwt } from "../src/access.mjs";
import { clientRun } from "../src/snapshot.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const readJson = async (file) => JSON.parse(await readFile(path.join(ROOT, file), "utf8"));

/** Mean CPU milliseconds per call of `operation`, after a warm-up. */
async function cpuMs(operation, rounds = 200) {
  for (let index = 0; index < 20; index += 1) await operation();
  const start = process.cpuUsage();
  for (let index = 0; index < rounds; index += 1) await operation();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000 / rounds;
}

test("the hot paths of a request cost well under the 10 ms CPU limit", async () => {
  const config = await readJson("test/fixtures/wingfoil-home-compute.json");
  const preset = validatePreset(await readJson("presets/wingfoil.json"));
  const variables = { WINGFOIL_IMAGE: "ghcr.io/sprintengine/wingfoil-forecast@sha256:abc" };
  const jobs = config.jobs.map((v1) => jobFromV1(v1, { preset, variables }).job);
  const existing = Object.fromEntries(jobs.map((job) => [job.id, job]));
  const now = Date.parse("2026-10-11T10:20:05Z");

  const results = {};
  results.importPlan = await cpuMs(() => {
    const incoming = config.jobs.map((v1) => jobFromV1(v1, { preset, variables }).job);
    return planImport({ incoming, existing, baseline: existing });
  });
  results.cronMaterialise = await cpuMs(() => jobs.map((job) => materialise({ ...job, paused: false },
    { lastSlotAt: now - 3_600_000, due: { id: "r_1", dueAt: now - 600_000 } }, now)));
  const row = {
    id: "r_01M4NY315G5RXDH30FP5J39JFF", job_id: "ecmwf", job_revision: 1, slot_at: now, source: "schedule", state: "succeeded",
    outcome: "published", attempt: 1, due_at: now, started_at: now + 60_000, finished_at: now + 400_000, exit_code: 0,
    peak_memory_bytes: 400_000_000, metrics_json: '{"seconds":300,"peakRssBytes":380000000}',
    published_json: '[{"key":"ecmwf","run":"2026101100"}]', recovered: 0, created_at: now, updated_at: now,
  };
  results.snapshotRuns = await cpuMs(() => Array.from({ length: 105 }, () => clientRun(row)));

  // One Access JWT check with the team's key already cached: an RSA-2048 signature verification.
  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", publicKey);
  const seconds = Math.floor(Date.now() / 1000);
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${part({ alg: "RS256", kid: "k" })}.${part({ aud: ["a"], email: "me@example.com", exp: seconds + 3600, iss: "https://t.cloudflareaccess.com" })}`;
  const signature = Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(unsigned))).toString("base64url");
  const settings = { team: "t.cloudflareaccess.com", audience: "a", issuer: "https://t.cloudflareaccess.com", certsUrl: "https://cpu.test/certs" };
  const fetcher = async () => Response.json({ keys: [{ ...jwk, kid: "k" }] });
  results.accessJwt = await cpuMs(() => verifyAccessJwt(`${unsigned}.${signature}`, settings, { fetcher }));

  console.log(JSON.stringify({ event: "cpu_ms_per_call", ...Object.fromEntries(Object.entries(results).map(([key, ms]) => [key, Number(ms.toFixed(3))])) }));
  for (const [name, ms] of Object.entries(results)) assert.ok(ms < 4, `${name} took ${ms} ms of CPU`);
});

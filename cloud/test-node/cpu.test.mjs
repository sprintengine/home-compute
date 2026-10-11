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
import { boundedReports, reportMetrics } from "../../src/core/history.mjs";
import { sha256Hex } from "../../src/core/protocol.mjs";
import { redactValue } from "../../src/core/redact.mjs";
import { publishedEntries, trackPublished } from "../../src/core/reports.mjs";
import { verifyAccessJwt } from "../src/access.mjs";
import { parseComplete, parseSync } from "../src/agent-body.mjs";
import { clientRun } from "../src/snapshot.mjs";
import { chooseClaims, redactPatterns } from "../src/sync.mjs";

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

  // The agent API's JavaScript: a busy sync (two runs, each with a full 32 KB tail, checked and redacted again),
  // a claim decision over 20 due runs and 21 jobs, a completion (64 KB tail, 32 KB of reports), a credential hash.
  const tail = Array.from({ length: 200 }, (_, index) => `2026-11-02T08:20:${String(index % 60).padStart(2, "0")}Z INFO step ${index} ${"x".repeat(120)}`)
    .join("\n").slice(0, 32 * 1024);
  const syncBody = JSON.stringify({
    protocol: 1, agentVersion: "0.2.0", agentTime: now,
    machine: { drain: false, vm: { kind: "colima", state: "running" }, free: { cpus: 2, memoryMiB: 4096, diskMiB: 30_000, runs: 0 }, health: { docker: "ok" } },
    runs: ["r_01M4NY315G5RXDH30FP5J39JF1", "r_01M4NY315G5RXDH30FP5J39JF2"].map((id) => ({
      id, phase: "running", stats: { peakMemoryBytes: 4e8, cpuPct: 90 }, logTail: { text: tail, bytesTotal: 90_000, truncated: true, errorCount: 0 },
    })),
    claim: true,
  });
  results.agentSync = await cpuMs(() => {
    const parsed = parseSync(JSON.parse(syncBody));
    return parsed.runs.map((run) => redactPatterns(run.logTail.text));
  }, 100);
  const jobMap = new Map(jobs.map((job) => [job.id, { ...job, paused: false, revision: 1 }]));
  const due = jobs.slice(0, 20).map((job, index) => ({ id: `r_${index}`, job_id: job.id, source: "schedule", due_at: now - index * 1000,
    preferred_until: now + 60_000, attempt: 1 }));
  const fleet = [{ id: "m_1", name: "mac-mini", labels: { arch: "arm64" }, lastSeenAt: now, drain: false, health: { docker: "ok" } },
    { id: "m_2", name: "linux", labels: { arch: "amd64" }, lastSeenAt: now, drain: false, health: { docker: "ok" } }];
  results.agentClaim = await cpuMs(() => chooseClaims({ due, jobs: jobMap, machine: fleet[0], machines: fleet, globalPause: false, now,
    free: { cpus: 4, memoryMiB: 6144, diskMiB: 40_000, runs: 2 } }));
  const reports = Array.from({ length: 120 }, (_, index) => ({ event: "forecast_complete", model: `model-${index}`, run: "2026110200",
    seconds: 300, frames: 120, peakRssBytes: 4e8, note: "x".repeat(150) }));
  const completeBody = JSON.stringify({ protocol: 1, exitCode: 0, reports, logTail: { text: `${tail}\n${tail}`, bytesTotal: 900_000, truncated: true },
    stats: { peakMemoryBytes: 4e8, samples: 100 }, durations: { durationMs: 300_000 }, image: { ref: "x", digest: "sha256:1" } });
  const report = { format: "json-lines", trackEvent: "forecast_complete", trackBy: "model" };
  results.agentComplete = await cpuMs(() => {
    const record = parseComplete(JSON.parse(completeBody));
    const kept = boundedReports(redactValue(record.reports, redactPatterns));
    redactPatterns(record.logTail.text);
    return [reportMetrics(kept), publishedEntries(kept, report, "ecmwf"), trackPublished({}, kept, report, { fallbackKey: "ecmwf", at: "t" })];
  }, 100);
  results.agentCredential = await cpuMs(() => sha256Hex(`hca_m_01M4NY315G5RXDH30FP5J39JFF_${"A".repeat(43)}`));

  console.log(JSON.stringify({ event: "cpu_ms_per_call", ...Object.fromEntries(Object.entries(results).map(([key, ms]) => [key, Number(ms.toFixed(3))])) }));
  for (const [name, ms] of Object.entries(results)) assert.ok(ms < 4, `${name} took ${ms} ms of CPU`);
});

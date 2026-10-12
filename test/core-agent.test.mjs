// The pure rules the agent protocol shares between hc-core and the agent:
// placement, the sync interval, retries, credentials, redaction of encoded
// secrets, tail bounds and error extraction.
import assert from "node:assert/strict";
import test from "node:test";
import { boundLines, extractError } from "../src/core/logs.mjs";
import {
  claimBlockers, effectiveFree, fits, machineAvailable, nextSyncDelay, placementRefusal, preferredUntil, secretsRefused, subtract,
} from "../src/core/placement.mjs";
import {
  newCredential, newJoinToken, JOIN_TOKEN, OFFLINE_MS, parseCredential, sha256Hex, SYNC_BUSY_MS, SYNC_IDLE_MS,
} from "../src/core/protocol.mjs";
import { createRedactor, secretForms } from "../src/core/redact.mjs";
import { failedRetry, lostRetry } from "../src/core/run.mjs";

const NOW = 1_791_700_000_000;
const machine = (name, extra = {}) => ({
  id: `m_${name}`, name, labels: { os: "darwin", arch: "arm64" }, lastSeenAt: NOW - 10_000, drain: false, health: { docker: "ok" }, ...extra,
});
const job = (placement = {}) => ({ id: "ecmwf", placement, secretEnv: {} });

test("labels must all match; preferred machines have a run to themselves until preferred_until", () => {
  const mac = machine("mac-mini");
  const linux = machine("linux-box", { labels: { os: "linux", arch: "amd64" } });
  const machines = [mac, linux];
  const run = { preferredUntil: NOW + 60_000 };
  assert.equal(placementRefusal(job({ requireLabels: { arch: "arm64" } }), run, linux, { machines, now: NOW }), "labels");
  assert.equal(placementRefusal(job({ requireLabels: { arch: "arm64" } }), run, mac, { machines, now: NOW }), null);

  const preferring = job({ preferMachines: ["mac-mini"], preferWaitSeconds: 60 });
  assert.equal(preferredUntil(preferring, NOW), NOW + 60_000);
  assert.equal(preferredUntil(job(), NOW), null);
  assert.equal(placementRefusal(preferring, run, mac, { machines, now: NOW }), null);
  assert.equal(placementRefusal(preferring, run, linux, { machines, now: NOW }), "preferred");
  assert.equal(placementRefusal(preferring, run, linux, { machines, now: NOW + 60_000 }), null, "the window ends");

  // The exception: every preferred machine offline, draining or unhealthy.
  const offline = [{ ...mac, lastSeenAt: NOW - OFFLINE_MS - 1 }, linux];
  const draining = [{ ...mac, drain: true }, linux];
  const drainingLocally = [{ ...mac, health: { docker: "ok", localDrain: true } }, linux];
  const unhealthy = [{ ...mac, health: { docker: "unreachable" } }, linux];
  const vmFailed = [{ ...mac, health: { docker: "ok", vm: "failed" } }, linux];
  for (const others of [offline, draining, drainingLocally, unhealthy, vmFailed]) {
    assert.equal(placementRefusal(preferring, run, linux, { machines: others, now: NOW }), null);
  }
  assert.equal(machineAvailable(mac, NOW), true);
  assert.equal(machineAvailable({ ...mac, revokedAt: NOW }, NOW), false);
});

test("capacity: a run fits the machine's free figures, capped by the dashboard's caps less what it holds", () => {
  const free = { cpus: 4, memoryMiB: 6144, diskMiB: 40_000, runs: 2 };
  assert.equal(fits({ cpus: 1, memoryMiB: 1024, diskMiB: 12_288 }, free), true);
  assert.equal(fits({ cpus: 1, memoryMiB: 8192, diskMiB: 1 }, free), false);
  assert.equal(fits({ cpus: 1, memoryMiB: 1 }, { ...free, runs: 0 }), false);
  assert.deepEqual(subtract(free, { cpus: 1, memoryMiB: 1024, diskMiB: 0 }), { cpus: 3, memoryMiB: 5120, diskMiB: 40_000, runs: 1 });
  const capped = effectiveFree(free, { memoryMiB: 3072, maxRuns: 1 }, [{ cpus: 1, memoryMiB: 1024 }]);
  assert.deepEqual(capped, { cpus: 4, memoryMiB: 2048, diskMiB: 40_000, runs: 0 });
  assert.deepEqual(effectiveFree(free, {}, []), free);
});

test("a vault reference blocks claims until the vault holds that secret; local ones never do", () => {
  assert.deepEqual(claimBlockers({ secretEnv: { TOKEN: "local:TOKEN" } }), []);
  const vaulted = { secretEnv: { A: "vault:wingfoil-r2", B: "vault:wingfoil-r2", C: "vault:other" } };
  assert.match(claimBlockers(vaulted)[0], /not set: other, wingfoil-r2$/);
  assert.match(claimBlockers(vaulted, new Map([["wingfoil-r2", { allowedLabels: {} }]]))[0], /not set: other$/);
  assert.deepEqual(claimBlockers(vaulted, new Map([["wingfoil-r2", { allowedLabels: {} }], ["other", { allowedLabels: {} }]])), []);
});

test("a secret goes only to machines whose labels match its allowed labels", () => {
  const secrets = new Map([["r2", { allowedLabels: { site: "home" } }], ["open", { allowedLabels: {} }]]);
  const vaulted = { secretEnv: { A: "vault:r2", B: "vault:open", C: "vault:unset" } };
  assert.deepEqual(secretsRefused(vaulted, { labels: { site: "home", os: "darwin" } }, secrets), []);
  assert.deepEqual(secretsRefused(vaulted, { labels: { site: "cloud" } }, secrets), ["r2"]);
  assert.deepEqual(secretsRefused(vaulted, { labels: {} }, secrets), ["r2"], "a secret that is not set is a blocker, not a refusal");
});

test("the server sets the sync interval: 10 s busy, else 30 s or 2 s after the next slot", () => {
  assert.equal(nextSyncDelay({ busy: true, events: [NOW + 1000], now: NOW }), SYNC_BUSY_MS);
  assert.equal(nextSyncDelay({ busy: false, events: [], now: NOW }), SYNC_IDLE_MS);
  assert.equal(nextSyncDelay({ busy: false, events: [NOW + 10_000, NOW + 5_000], now: NOW }), 7_000);
  assert.equal(nextSyncDelay({ busy: false, events: [NOW + 120_000], now: NOW }), SYNC_IDLE_MS);
  assert.equal(nextSyncDelay({ busy: false, events: [NOW - 5_000], now: NOW }), SYNC_IDLE_MS, "a past event is not polled for");
});

test("lost runs are retried at once before they started, and after the grace only when idempotent", () => {
  const policy = { retry: { maxAttempts: 3, onLostRunning: false, lostGraceSeconds: 600 } };
  assert.deepEqual(lostRetry({ attempt: 1, startedAt: null, lostAt: NOW }, policy, NOW), { retry: true, at: NOW });
  assert.deepEqual(lostRetry({ attempt: 3, startedAt: null, lostAt: NOW }, policy, NOW), { retry: false, reason: "max-attempts" });
  assert.deepEqual(lostRetry({ attempt: 1, startedAt: NOW - 1, lostAt: NOW }, policy, NOW), { retry: false, reason: "started" });
  const idempotent = { retry: { ...policy.retry, onLostRunning: true } };
  assert.deepEqual(lostRetry({ attempt: 1, startedAt: NOW - 1, lostAt: NOW }, idempotent, NOW + 599_999), { retry: false, at: NOW + 600_000 });
  assert.deepEqual(lostRetry({ attempt: 1, startedAt: NOW - 1, lostAt: NOW }, idempotent, NOW + 600_000), { retry: true, at: NOW + 600_000 });
  assert.deepEqual(lostRetry({ attempt: 1, startedAt: null }, {}, NOW), { retry: true, at: NOW }, "defaults apply");
});

test("failed runs are retried only as often as onFailed says, after the backoff", () => {
  const policy = { retry: { onFailed: 1, backoffSeconds: 60 } };
  assert.deepEqual(failedRetry({ state: "failed", attempt: 1 }, policy, NOW), { retry: true, at: NOW + 60_000 });
  assert.deepEqual(failedRetry({ state: "timed-out", attempt: 1 }, policy, NOW), { retry: true, at: NOW + 60_000 });
  assert.equal(failedRetry({ state: "failed", attempt: 2 }, policy, NOW).retry, false);
  assert.equal(failedRetry({ state: "succeeded", attempt: 1 }, policy, NOW).retry, false);
  assert.equal(failedRetry({ state: "failed", attempt: 1 }, {}, NOW).retry, false, "none by default");
});

test("credentials and join tokens: their shapes, and SHA-256 as stored", async () => {
  const credential = newCredential("m_01J0000000000000000000000A");
  assert.match(credential, /^hca_m_01J0000000000000000000000A_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(parseCredential(credential), { machineId: "m_01J0000000000000000000000A" });
  for (const bad of [null, "", "hca_m_x_y", `${credential}x`, credential.replace("hca_", "hcj_"), "Bearer " + credential]) {
    assert.equal(parseCredential(bad), null, String(bad));
  }
  assert.match(newJoinToken(), JOIN_TOKEN);
  assert.notEqual(newJoinToken(), newJoinToken());
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("secret values are redacted in their URL-encoded and base64 forms too", () => {
  const secret = "s3cr3t/value+with=chars";
  const forms = secretForms([secret, "ab"]);
  const redact = createRedactor(forms);
  const encoded = Buffer.from(secret).toString("base64");
  const text = `plain ${secret} url ${encodeURIComponent(secret)} b64 ${encoded} b64url ${Buffer.from(secret).toString("base64url")} short ab`;
  const redacted = redact(text);
  assert.ok(!redacted.includes(secret) && !redacted.includes(encodeURIComponent(secret)) && !redacted.includes(encoded.replace(/=+$/, "")));
  assert.match(redacted, /short ab$/);
  assert.equal((redacted.match(/<redacted>/g) ?? []).length, 4);
});

test("tails keep the newest lines within both bounds", () => {
  const lines = Array.from({ length: 10 }, (_, index) => `line ${index}`);
  assert.deepEqual(boundLines(lines, { lines: 3, bytes: 1000 }), { lines: ["line 7", "line 8", "line 9"], truncated: true });
  assert.deepEqual(boundLines(lines, { lines: 100, bytes: 14 }), { lines: ["line 8", "line 9"], truncated: true });
  assert.deepEqual(boundLines(["a"], { lines: 5, bytes: 100 }), { lines: ["a"], truncated: false });
});

test("a failed run's error comes from its reports, a traceback, error lines, then OOM, timeout and exit code", () => {
  const traceback = ["starting", "Traceback (most recent call last):", '  File "x.py", line 1', "ValueError: bad grid", "after"];
  assert.equal(extractError([], { reports: [{ event: "forecast_failed", error: "HTTP 503" }] }).error, "HTTP 503");
  const fromTraceback = extractError(traceback, { exitCode: 1 });
  assert.equal(fromTraceback.error, "ValueError: bad grid");
  assert.equal(fromTraceback.errorDetail, traceback.slice(1, 4).join("\n"));
  assert.equal(extractError(["ok", "ERROR: disk full", "bye"], { exitCode: 2 }).error, "ERROR: disk full");
  assert.equal(extractError(["ok"], { oomKilled: true, memoryLimitBytes: 1024 ** 3, exitCode: 137 }).error, "out of memory (limit 1 GiB)");
  assert.equal(extractError(["ok"], { oomKilled: true, memoryLimitBytes: 64 * 1048576 }).error, "out of memory (limit 64 MiB)");
  assert.equal(extractError(["ok"], { timedOut: true, runSeconds: 3900, exitCode: 143 }).error, "timed out after 3900 s");
  assert.equal(extractError(["ok"], { exitCode: 3 }).error, "exited with 3");
  assert.deepEqual(extractError(["ok"], { exitCode: 0 }), { error: null, errorDetail: null });
  const long = extractError(Array.from({ length: 100 }, (_, index) => `ERROR ${"x".repeat(100)} ${index}`), { maxDetail: 500 });
  assert.equal(long.errorDetail.length, 500);
});

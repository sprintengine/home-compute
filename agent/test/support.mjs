// Test support: temporary state directories, a quiet logger that remembers
// events, and a stand-in control plane behind a fetch function.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StateDir } from "../src/state.mjs";

export async function tempState(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hc-agent-test-"));
  t?.after?.(() => rm(dir, { recursive: true, force: true }));
  const state = new StateDir(path.join(dir, "state"));
  await state.ensure();
  return state;
}

export function events() {
  const seen = [];
  const log = (event, fields = {}) => seen.push({ event, ...fields });
  log.seen = seen;
  log.names = () => seen.map((entry) => entry.event);
  return log;
}

/**
 * A fetch that answers from `handler({method, path, body, headers})`, which
 * returns `{status, body}` (an object becomes JSON, a string is sent as is)
 * or throws to simulate the network failing. Every request is kept.
 */
export function stubFetch(handler) {
  const requests = [];
  const fetch = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const request = {
      method: init.method ?? "GET", path: pathname, headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : null,
    };
    requests.push(request);
    const answer = await handler(request);
    const text = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body ?? {});
    return new Response(text, { status: answer.status ?? 200, headers: { "content-type": "application/json" } });
  };
  fetch.requests = requests;
  return fetch;
}

export const CONFIG = {
  server: "https://core.test", machineId: "m_01J00000000000000000000000", name: "box", runtime: "fake", caps: {},
  allowImages: ["*"], allowLocalImages: false, envFile: null, statusPort: 0, stopGraceSeconds: 0.2, statsIntervalSeconds: 0.02,
  pullTimeoutSeconds: 5, fake: {},
};

let counter = 0;
/** A run id that passes RUN_ID: `r_` and 26 Crockford characters. */
export function runId() {
  counter += 1;
  return `r_01J${String(counter).padStart(23, "0")}`;
}

/** A claim as a sync answer carries it. */
export function claimFor(id, spec = {}, run = {}) {
  return {
    run: { id, jobId: run.jobId ?? "job", attempt: 1, source: "manual", dueAt: 0, leaseExpiresAt: 0, ...run },
    spec: {
      image: "ghcr.io/example/worker@sha256:abc", entrypoint: null, args: [], env: {}, secretEnv: {}, localEnv: [],
      resources: { cpus: 1, memoryMiB: 256, diskMiB: 100 }, runSeconds: 60, network: "bridge", report: null, ...spec,
    },
  };
}

export async function until(check, { timeoutMs = 5000, everyMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

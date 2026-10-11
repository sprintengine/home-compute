// The Docker Engine API over its unix socket (§4.3): what the agent asks
// Docker every few seconds (stats), once per run (inspect, wait) or per sync
// (ping, info) goes here rather than to a `docker` process, so sampling a
// container spawns nothing. Unversioned paths: the daemon answers in its own
// API version, which is all the fields used here have in common since 1.41.

import http from "node:http";

export class EngineError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = "EngineError";
    this.status = status;
    this.code = code;
  }
}

/** The socket a `DOCKER_HOST` names: `unix:///path` → `/path`. Other schemes are not supported. */
export function socketPathOf(host) {
  const text = String(host ?? "");
  if (text.startsWith("unix://")) return text.slice("unix://".length);
  if (text.startsWith("/")) return text;
  throw new Error(`DOCKER_HOST ${text} is not a unix socket; the agent talks to Docker only over a local socket`);
}

/** Query parameters, JSON-encoding objects (the API's `filters`). */
function query(parameters = {}) {
  const entries = Object.entries(parameters).filter(([, value]) => value !== undefined && value !== null);
  if (!entries.length) return "";
  return `?${entries.map(([key, value]) => `${key}=${encodeURIComponent(typeof value === "object" ? JSON.stringify(value) : String(value))}`).join("&")}`;
}

export class Engine {
  /** `socketPath`: the daemon's socket. `timeoutMs`: for ordinary requests (wait has none). */
  constructor({ socketPath, timeoutMs = 30_000 }) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  /** One request; resolves `{status, body}` (JSON parsed when it is JSON). Network failures reject with an EngineError. */
  request(method, path, { parameters, timeoutMs = this.timeoutMs, signal } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new EngineError("aborted", { code: "ABORTED" }));
        return;
      }
      const request = http.request({
        socketPath: this.socketPath, method, path: `${path}${query(parameters)}`, headers: { host: "docker" }, agent: false,
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", (error) => reject(new EngineError(error.message, { code: error.code })));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body = text;
          if (/json/.test(response.headers["content-type"] ?? "") && text) {
            try {
              body = JSON.parse(text);
            } catch {
              // Kept as text.
            }
          }
          resolve({ status: response.statusCode, body });
        });
      });
      const abort = () => request.destroy(new EngineError("aborted", { code: "ABORTED" }));
      signal?.addEventListener("abort", abort, { once: true });
      if (timeoutMs) request.setTimeout(timeoutMs, () => request.destroy(new EngineError(`Docker did not answer ${method} ${path} within ${timeoutMs} ms`, { code: "ETIMEDOUT" })));
      request.on("error", (error) => {
        signal?.removeEventListener("abort", abort);
        if (error instanceof EngineError) reject(error);
        else reject(new EngineError(`Docker is not reachable at ${this.socketPath}: ${error.message}`, { code: error.code }));
      });
      request.on("close", () => signal?.removeEventListener("abort", abort));
      request.end();
    });
  }

  /** The body of a 2xx answer, null for a 404, else an EngineError with Docker's message. */
  async call(method, path, options) {
    const { status, body } = await this.request(method, path, options);
    if (status === 404) return null;
    if (status < 200 || status >= 300) {
      const message = typeof body === "object" && body?.message ? body.message : String(body).trim().slice(0, 300);
      throw new EngineError(`Docker answered ${status} to ${method} ${path}: ${message}`, { status });
    }
    return body;
  }

  async ping(options) {
    const body = await this.call("GET", "/_ping", options);
    if (body === null) throw new EngineError("Docker's /_ping is missing", { status: 404 });
    return true;
  }

  info() {
    return this.call("GET", "/info");
  }

  version() {
    return this.call("GET", "/version");
  }

  inspectContainer(id) {
    return this.call("GET", `/containers/${encodeURIComponent(id)}/json`);
  }

  /** Every container (running or not) carrying `label` (a key, or `key=value`). */
  async listContainers(label) {
    return (await this.call("GET", "/containers/json", { parameters: { all: 1, filters: { label: [label] } } })) ?? [];
  }

  /** Waits until the container is not running (no timeout); `signal` gives up. Null when it does not exist. */
  waitContainer(id, signal) {
    return this.call("POST", `/containers/${encodeURIComponent(id)}/wait`, { parameters: { condition: "not-running" }, timeoutMs: 0, signal });
  }

  /** One stats sample, without waiting for a second one (§4.6). */
  stats(id) {
    return this.call("GET", `/containers/${encodeURIComponent(id)}/stats`, { parameters: { stream: "false", "one-shot": "true" } });
  }

  /** An image by reference or id, or null when it is not here. */
  inspectImage(reference) {
    return this.call("GET", `/images/${reference}/json`);
  }
}

/**
 * A sample as the agent keeps it (§4.6), from the Engine's stats: memory is
 * `usage − inactive_file` (what `docker stats` shows; cgroup v2's
 * `inactive_file`, v1's `total_inactive_file`); CPU is the share of one CPU
 * since `previous` (`{cpuNs, at}`), or since the container started for the
 * first sample; `cpuSeconds` is the container's total CPU time.
 */
export function sampleFromStats(raw, { previous = null, startedAt = null, now = Date.now() } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const memory = raw.memory_stats ?? {};
  const counters = memory.stats ?? {};
  const inactive = counters.inactive_file ?? counters.total_inactive_file ?? 0;
  const memoryBytes = typeof memory.usage === "number" ? Math.max(0, Math.round(memory.usage - inactive)) : null;
  const cpuNs = raw.cpu_stats?.cpu_usage?.total_usage;
  const sample = { memoryBytes, memoryLimitBytes: typeof memory.limit === "number" && memory.limit > 0 ? memory.limit : null, cpuPct: null, cpuSeconds: null };
  if (typeof cpuNs === "number") {
    sample.cpuSeconds = Math.round(cpuNs / 1e6) / 1e3;
    const since = previous ? { cpuNs: previous.cpuNs, at: previous.at } : typeof startedAt === "number" ? { cpuNs: 0, at: startedAt } : null;
    if (since && now > since.at) sample.cpuPct = Math.max(0, Math.round(((cpuNs - since.cpuNs) / ((now - since.at) * 1e6)) * 1000) / 10);
    sample.raw = { cpuNs, at: now };
  }
  return sample;
}

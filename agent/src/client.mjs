// The agent's side of hc-core's API (§4.2, §7): enrol, sync and complete,
// over HTTPS with the machine's bearer credential. Failures are sorted into
// what the agent does about them:
//
// - `backoff`: the network, a 5xx, a 429 or Cloudflare's 1027 (the daily
//   request limit). Try again later, with exponential backoff and jitter.
// - `revoked`: 401/403. Claim nothing, finish current runs, keep results.
// - `upgrade`: 426. The protocol is too old; self-update (M7).
// - `rejected`: any other 4xx. That request will never succeed as it is.

import { PROTOCOL } from "../../src/core/protocol.mjs";
import { AGENT_VERSION } from "./version.mjs";

const REQUEST_TIMEOUT_MS = 30_000;

export class ControlPlaneError extends Error {
  constructor(kind, message, { status = null, code = null } = {}) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

function classify(status, body, text) {
  const code = body?.code ?? body?.error ?? null;
  if (status === 426) return "upgrade";
  if (status === 401 || status === 403) return "revoked";
  // Error 1027 (Workers daily limit) arrives as a Cloudflare page; treat it as a 429 whatever its status.
  if (status === 429 || status >= 500 || /\b1027\b/.test(text ?? "") && status !== 200) return "backoff";
  if (status >= 400) return "rejected";
  return code ? "rejected" : "backoff";
}

export class ControlPlaneClient {
  /**
   * `server`: hc-core's base URL. `credential()`: the current credential
   * (read on every request, so a rotation takes effect at once). `fetch`:
   * the global fetch unless a test gives its own.
   */
  constructor({ server, credential = () => null, fetch = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS }) {
    if (!server) throw new Error("No control plane URL (server) is configured");
    this.server = String(server).replace(/\/+$/, "");
    this.credential = credential;
    this.fetch = fetch;
    this.timeoutMs = timeoutMs;
  }

  async request(path, { method = "POST", body, auth = true } = {}) {
    const credential = auth ? this.credential() : null;
    if (auth && !credential) throw new ControlPlaneError("revoked", "This machine has no credential; enrol it first");
    const headers = { "user-agent": `home-compute-agent/${AGENT_VERSION}`, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (credential) headers.authorization = `Bearer ${credential}`;
    let response;
    let text;
    try {
      response = await this.fetch(`${this.server}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      throw new ControlPlaneError("backoff", `${this.server} is unreachable: ${error.cause?.code ?? error.message}`);
    }
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // A Cloudflare error page, say.
    }
    if (response.ok && parsed !== null) return { status: response.status, body: parsed, credential };
    const kind = response.ok ? "backoff" : classify(response.status, parsed, text);
    const error = new ControlPlaneError(kind, `${method} ${path}: ${response.status} ${parsed?.error ?? text?.slice(0, 200) ?? ""}`.trim(),
      { status: response.status, code: parsed?.code ?? null });
    error.credential = credential;
    throw error;
  }

  /**
   * A request that, on a 401, is tried once more if the credential changed
   * meanwhile: a request sent with the old credential after a rotation was
   * promoted is not a revocation.
   */
  async authed(path, body) {
    try {
      return await this.request(path, { body });
    } catch (error) {
      if (error.kind === "revoked" && error.credential && error.credential !== this.credential()) return this.request(path, { body });
      throw error;
    }
  }

  health() {
    return this.request("/health", { method: "GET", auth: false });
  }

  enrol({ joinToken, name, facts }) {
    return this.request("/agent/v1/enrol", { body: { protocol: PROTOCOL, joinToken, name, facts, publicFacts: {} }, auth: false });
  }

  sync(body) {
    return this.authed("/agent/v1/sync", { protocol: PROTOCOL, ...body });
  }

  complete(runId, record) {
    return this.authed(`/agent/v1/runs/${encodeURIComponent(runId)}/complete`, { protocol: PROTOCOL, ...record });
  }
}

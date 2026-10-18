// hc-web: the dashboard (static assets) and the human API, behind Cloudflare
// Access. Every /v1 request carries an Access JWT, verified here (§5); its
// email or service-token name maps to a role; and every state change passes
// the CSRF checks the local controller applies (src/core/csrf.mjs).

import { csrfRefusal } from "../../src/core/csrf.mjs";
import {
  accessSettings, AccessError, allows, csrfTokenFor, identityOf, roleOf, verifyAccessJwt,
} from "./access.mjs";
import * as api from "./api.mjs";
import { getContainers } from "./containers.mjs";
import * as fleet from "./fleet-api.mjs";
import * as vault from "./secrets.mjs";
import { alertState, testAlertStatements } from "./alerts.mjs";
import { readSettings } from "./db.mjs";
import { errorResponse, HttpError, iso, json, readJson } from "./http.mjs";

const JOB = "([a-z0-9][a-z0-9-]{0,62})";
const RUN = "(r_[0-9A-Za-z]{26})";
const MACHINE = "(m_[0-9A-Za-z]{26})";
const SECRET = "([a-z0-9][a-z0-9._-]{0,62})";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** [method, path pattern, role needed, handler]. Mutating routes are everything but GET. */
export const ROUTES = [
  ["GET", "/v1/snapshot", "viewer", api.snapshot],
  ["GET", "/v1/changes", "viewer", api.changes],
  ["GET", `/v1/jobs/${JOB}`, "viewer", api.getJob],
  ["PUT", `/v1/jobs/${JOB}`, "admin", api.putJob],
  ["PATCH", `/v1/jobs/${JOB}/timetable`, "operator", api.patchTimetable],
  // The local controller's verb, which today's dashboard and menu bar app send.
  ["POST", `/v1/jobs/${JOB}/timetable`, "operator", api.patchTimetable],
  ["PATCH", `/v1/jobs/${JOB}/placement`, "operator", (context) => api.patchDefinition(context, "placement")],
  ["PATCH", `/v1/jobs/${JOB}/resources`, "operator", (context) => api.patchDefinition(context, "resources")],
  // What runs is an admin's choice: an operator may move and size work, not change it.
  ["PATCH", `/v1/jobs/${JOB}/image`, "admin", (context) => api.patchDefinition(context, "image")],
  ["POST", `/v1/jobs/${JOB}/run`, "operator", api.runJob],
  ["POST", `/v1/jobs/${JOB}/pause`, "operator", (context) => api.setPaused(context, true)],
  ["POST", `/v1/jobs/${JOB}/resume`, "operator", (context) => api.setPaused(context, false)],
  ["GET", `/v1/jobs/${JOB}/runs`, "viewer", api.listRuns],
  ["GET", `/v1/runs/${RUN}`, "viewer", api.getRun],
  ["GET", `/v1/runs/${RUN}/logs`, "viewer", api.runLogs],
  ["POST", `/v1/runs/${RUN}/cancel`, "operator", api.cancelRun],
  ["POST", `/v1/runs/${RUN}/retry`, "operator", api.retryRun],
  ["GET", "/v1/containers", "viewer", getContainers],
  ["GET", "/v1/machines", "viewer", fleet.listMachines],
  ["GET", `/v1/machines/${MACHINE}`, "viewer", fleet.getMachine],
  ["GET", `/v1/machines/${MACHINE}/runs`, "viewer", fleet.machineRuns],
  // Drain is an operator's; anything else in the body needs an admin (checked in the handler).
  ["PATCH", `/v1/machines/${MACHINE}`, "operator", fleet.patchMachine],
  ["DELETE", `/v1/machines/${MACHINE}`, "admin", fleet.revokeMachine],
  ["POST", "/v1/join-tokens", "admin", fleet.createJoinToken],
  ["POST", "/v1/pause-all", "operator", (context) => api.patchSettings(context, { globalPause: true })],
  ["POST", "/v1/resume-all", "operator", (context) => api.patchSettings(context, { globalPause: false })],
  ["GET", "/v1/settings", "admin", api.getSettings],
  ["PATCH", "/v1/settings", "admin", async (context) => api.patchSettings(context, await readJson(context.request, { maxBytes: 16 * 1024 }))],
  ["GET", "/v1/audit", "admin", api.audit],
  // The vault (§5): names, hints and labels only; values go in and never come out.
  ["GET", "/v1/secrets", "admin", vault.listSecrets],
  ["PUT", `/v1/secrets/${SECRET}`, "admin", vault.putSecret],
  ["DELETE", `/v1/secrets/${SECRET}`, "admin", vault.deleteSecret],
  ["GET", "/v1/alerts", "viewer", async ({ db, now }) => json(200, await alertState(db, now, { resolvedSince: now - 7 * 86_400_000 }))],
  ["POST", "/v1/alerts/test", "admin", async ({ db, identity, ip, now }) => {
    const { id, statements } = testAlertStatements(db, { now, actor: identity.actor });
    await db.batch([...statements, db.prepare("INSERT INTO audit_log (at, actor, action, target, ip) VALUES (?, ?, 'alert.test', ?, ?)")
      .bind(now, identity.actor, id, ip)]);
    return json(202, { id, detail: "The control plane's next cron minute emails it, then resolves it." });
  }],
  ["POST", "/v1/import", "admin", api.importHandler],
].map(([method, path, role, handler]) => ({ method, pattern: new RegExp(`^${path}$`), role, handler }));

function route(method, pathname) {
  let pathMatched = false;
  for (const candidate of ROUTES) {
    const match = pathname.match(candidate.pattern);
    if (!match) continue;
    pathMatched = true;
    if (candidate.method === method || (method === "HEAD" && candidate.method === "GET")) {
      return { ...candidate, params: { id: match[1] } };
    }
  }
  return pathMatched ? { methodNotAllowed: true } : null;
}

/**
 * The request's identity, from its Access JWT. Only for `wrangler dev`:
 * DEV_ACCESS_EMAIL stands in for Access when the request's own host is
 * loopback, which a deployed Worker's never is.
 */
async function authenticate(request, env, url, now) {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token && env.DEV_ACCESS_EMAIL && LOCAL_HOSTS.has(url.hostname)) {
    const email = String(env.DEV_ACCESS_EMAIL).toLowerCase();
    return { kind: "user", actor: email, login: email, subject: `dev:${email}`, issuedAt: 0, expiresAt: null, dev: true };
  }
  return identityOf(await verifyAccessJwt(token, accessSettings(env), { now }));
}

/** Static files: the dashboard asks for /assets/<file>; the assets directory is the dashboard folder itself. */
async function asset(request, env, url) {
  if (!env.ASSETS) return json(404, { error: "not_found" });
  if (url.pathname.startsWith("/assets/")) {
    return env.ASSETS.fetch(new Request(new URL(url.pathname.slice("/assets".length), url), request));
  }
  return env.ASSETS.fetch(request);
}

async function respond(request, env, now) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/v1/")) return asset(request, env, url);
  if (url.pathname === "/v1/health") return json(200, { status: "ok", service: "hc-web" });

  let identity;
  try {
    identity = await authenticate(request, env, url, now);
  } catch (error) {
    if (!(error instanceof AccessError)) throw error;
    console.warn(JSON.stringify({ event: "access_rejected", reason: error.reason, path: url.pathname }));
    if (url.pathname === "/v1/session") return json(401, { authenticated: false, tokenLogin: false, access: true });
    return json(401, { error: "unauthorized" });
  }
  const { roles } = await readSettings(env.DB, ["roles"]);
  const role = roleOf(identity.login, { roles, bootstrapAdmins: env.BOOTSTRAP_ADMINS });
  // As with the local controller's tokenless local client, a dev request without an Origin (curl, the CLI) is not a browser.
  const browser = identity.kind === "user" && !(identity.dev && !request.headers.get("origin"));
  // Every person gets a token (a page's own GETs carry no Origin); only service tokens never need one.
  const csrfToken = identity.kind === "user" ? await csrfTokenFor(identity, env.CSRF_KEY) : null;

  if (url.pathname === "/v1/session") {
    if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
    return json(200, {
      authenticated: true,
      method: "access",
      kind: identity.kind,
      login: identity.login,
      role,
      ...(csrfToken ? { csrfToken } : {}),
      ...(identity.expiresAt ? { expiresAt: iso(identity.expiresAt * 1000) } : {}),
    });
  }
  const found = route(request.method, url.pathname);
  if (!found) return json(404, { error: "not_found" });
  if (found.methodNotAllowed) return json(405, { error: "method_not_allowed" });
  if (!role) return json(403, { error: "no_role", login: identity.login });
  if (!allows(role, found.role)) return json(403, { error: "forbidden", role, needs: found.role });
  if (!["GET", "HEAD"].includes(request.method)) {
    if (browser && !env.CSRF_KEY) throw new HttpError(500, "CSRF_KEY is not set");
    const refusal = csrfRefusal({
      contentType: request.headers.get("content-type"),
      origin: request.headers.get("origin"),
      hosts: [url.host],
      fetchSite: request.headers.get("sec-fetch-site"),
      browser,
      token: request.headers.get("x-hc-csrf") ?? request.headers.get("x-csrf-token"),
      expected: csrfToken,
    });
    if (refusal) return json(403, { error: "csrf_check_failed", reason: refusal });
  }
  return found.handler({
    db: env.DB, env, request, url, params: found.params, identity, role, now,
    ip: request.headers.get("cf-connecting-ip"),
  });
}

/** hc-web's answer to a request; `now` (epoch ms) is for tests. */
export async function handle(request, env, { now = Date.now() } = {}) {
  try {
    return await respond(request, env, now);
  } catch (error) {
    return errorResponse(error);
  }
}

export default {
  fetch: (request, env) => handle(request, env),
};

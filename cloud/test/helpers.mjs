// Test helpers: a test Access team (its own RSA keys, served as the team's
// JWKS through a mocked fetch), JWT minting, and requests to hc-web's handler
// as a browser or a service token would send them.

import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vitest";
import { clearAccessKeys } from "../src/access.mjs";
import core from "../src/hc-core.mjs";
import { handle } from "../src/hc-web.mjs";

export const TEAM = env.ACCESS_TEAM_DOMAIN;
export const AUD = env.ACCESS_AUD;
export const CERTS = `https://${TEAM}/cdn-cgi/access/certs`;
export const ORIGIN = "https://hc.example.com";
export const OWNER = "owner@example.com";
export const KID = "test-key-1";

const algorithm = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
export const teamKey = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
export const strangerKey = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);

function base64Url(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function teamJwks() {
  const jwk = await crypto.subtle.exportKey("jwk", teamKey.publicKey);
  return { keys: [{ kid: KID, kty: "RSA", alg: "RS256", use: "sig", n: jwk.n, e: jwk.e }], public_cert: { kid: KID } };
}

/** Serves the team's certificates; any other outbound fetch fails the test. Returns the spy. */
export function mockCertificates() {
  clearAccessKeys();
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input?.url ?? input);
    if (url === CERTS) return Response.json(await teamJwks());
    throw new Error(`Unexpected fetch ${url}`);
  });
}

export async function mintJwt(claims, { kid = KID, key = teamKey.privateKey, alg = "RS256" } = {}) {
  const header = base64Url(JSON.stringify({ alg, kid, typ: "JWT" }));
  const payload = base64Url(JSON.stringify(claims));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64Url(signature)}`;
}

const seconds = () => Math.floor(Date.now() / 1000);

export function userClaims(email, extra = {}) {
  return { aud: [AUD], email, exp: seconds() + 3600, iat: seconds(), iss: `https://${TEAM}`, sub: `sub-${email}`, type: "app", ...extra };
}

export function serviceClaims(commonName, extra = {}) {
  return { aud: [AUD], common_name: commonName, exp: seconds() + 3600, iat: seconds(), iss: `https://${TEAM}`, sub: "", type: "app", ...extra };
}

const tokens = new Map();
const csrfTokens = new Map();

/** One JWT per identity for the whole file, as a browser keeps one Access session. */
async function tokenFor(identity) {
  if (!tokens.has(identity)) {
    tokens.set(identity, await mintJwt(identity.startsWith("service:") ? serviceClaims(identity.slice(8)) : userClaims(identity)));
  }
  return tokens.get(identity);
}

/**
 * A request to hc-web, as `identity` (an email, "service:<name>", or null for
 * none). Mutations get what a same-origin dashboard fetch sends (JSON, Origin,
 * Sec-Fetch-Site and the CSRF token) unless `browser: false` or overridden.
 */
export async function call(path, { method = "GET", body, identity = OWNER, headers = {}, browser = true, now } = {}) {
  const all = { ...headers };
  if (identity) all["cf-access-jwt-assertion"] ??= await tokenFor(identity);
  const mutating = !["GET", "HEAD"].includes(method);
  if (mutating) {
    // A header given as undefined is left out: that is how a test says "without it".
    if (!("content-type" in all)) all["content-type"] = "application/json";
    if (browser && identity && !identity.startsWith("service:")) {
      if (!("origin" in all)) all.origin = ORIGIN;
      if (!("sec-fetch-site" in all)) all["sec-fetch-site"] = "same-origin";
      if (!("x-hc-csrf" in all)) {
        if (!csrfTokens.has(identity)) csrfTokens.set(identity, (await call("/v1/session", { identity })).body.csrfToken);
        all["x-hc-csrf"] = csrfTokens.get(identity);
      }
    }
    for (const [name, value] of Object.entries(all)) if (value === undefined) delete all[name];
  }
  const request = new Request(`${ORIGIN}${path}`, {
    method,
    headers: all,
    body: body === undefined ? (mutating ? "{}" : undefined) : typeof body === "string" ? body : JSON.stringify(body),
  });
  const started = performance.now();
  const response = await handle(request, env, now === undefined ? {} : { now });
  const elapsed = performance.now() - started;
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: response.status, body: parsed, headers: response.headers, elapsed };
}

export async function resetDatabase() {
  await env.DB.batch(["run_logs", "runs", "schedule_state", "jobs", "machines", "join_tokens", "secrets", "audit_log", "settings"]
    .map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
}

/** Runs hc-core's scheduled handler as the cron would, at `time` (epoch ms or ISO). */
export async function cron(time) {
  const scheduledTime = typeof time === "number" ? time : Date.parse(time);
  const controller = createScheduledController({ scheduledTime, cron: "* * * * *" });
  const ctx = createExecutionContext();
  const summary = await core.scheduled(controller, env, ctx);
  await waitOnExecutionContext(ctx);
  return summary;
}

export async function rows(sql, ...params) {
  return (await env.DB.prepare(sql).bind(...params).all()).results;
}

/** A small job definition for PUT /v1/jobs/:id. */
export function definition(overrides = {}) {
  return { image: "ghcr.io/example/worker@sha256:0123", schedule: { at: { hours: [8, 10], minutes: [20] } }, ...overrides };
}

export async function createJob(id, overrides = {}, options = {}) {
  const response = await call(`/v1/jobs/${id}`, { method: "PUT", body: definition(overrides), ...options });
  if (response.status !== 201) throw new Error(`create ${id}: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body;
}

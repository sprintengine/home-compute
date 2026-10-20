// People reach hc-web through a Cloudflare Access application. Access puts a
// signed JWT in `Cf-Access-Jwt-Assertion`, and Cloudflare's docs require the
// origin to check it itself: RS256 against the team's keys (chosen by `kid`),
// the team as issuer, and the application's AUD tag as audience. The keys are
// cached in the isolate, so a request costs one signature check.
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/

const KEY_TTL_MS = 60 * 60_000;
const REFETCH_GAP_MS = 60_000;
const CLOCK_SKEW_SECONDS = 60;
const encoder = new TextEncoder();

/** Keys per certificate URL: `{keys: Map(kid → CryptoKey), fetchedAt, pending}`. */
const caches = new Map();

export class AccessError extends Error {
  constructor(reason) {
    super(`Access token rejected: ${reason}`);
    this.reason = reason;
    this.status = 401;
  }
}

function base64UrlBytes(text) {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodePart(text, what) {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlBytes(text)));
  } catch {
    throw new AccessError(`malformed ${what}`);
  }
}

/** The team domain, the AUD tag and, rarely, another certificate URL, from the Worker's environment. */
export function accessSettings(env) {
  // A pasted URL (`http://team.cloudflareaccess.com/`) is the same hostname. Any scheme, then trailing slashes.
  const team = String(env.ACCESS_TEAM_DOMAIN ?? "").trim().replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "");
  const audience = String(env.ACCESS_AUD ?? "").trim();
  return {
    team,
    audience,
    issuer: team ? `https://${team}` : "",
    certsUrl: String(env.ACCESS_CERTS_URL ?? "").trim() || (team ? `https://${team}/cdn-cgi/access/certs` : ""),
  };
}

async function fetchKeys(certsUrl, fetcher) {
  const response = await fetcher(certsUrl, { headers: { accept: "application/json" } });
  if (!response.ok) throw new AccessError(`certificates unavailable (HTTP ${response.status})`);
  const body = await response.json();
  const keys = new Map();
  for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
    if (jwk?.kty !== "RSA" || typeof jwk.kid !== "string") continue;
    const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    keys.set(jwk.kid, key);
  }
  return keys;
}

/**
 * The key for `kid`: from the cache while it is fresh, else fetched again. An
 * unknown `kid` refetches (Access rotates keys) at most once a minute, so a
 * stream of forged kids cannot turn into a stream of fetches.
 */
async function keyFor(kid, certsUrl, { now, fetcher }) {
  let cache = caches.get(certsUrl);
  if (!cache) caches.set(certsUrl, (cache = { keys: new Map(), fetchedAt: 0, pending: null }));
  const stale = now - cache.fetchedAt > KEY_TTL_MS;
  const unknown = !cache.keys.has(kid) && now - cache.fetchedAt > REFETCH_GAP_MS;
  if (stale || unknown) {
    cache.pending ??= fetchKeys(certsUrl, fetcher).then((keys) => {
      cache.keys = keys;
      cache.fetchedAt = now;
    }).finally(() => { cache.pending = null; });
    try {
      await cache.pending;
    } catch (error) {
      // Keep using the keys we have if a refresh fails; with none, nothing verifies.
      if (!cache.keys.size) throw error instanceof AccessError ? error : new AccessError("certificates unavailable");
    }
  }
  return cache.keys.get(kid);
}

/** Forgets cached keys (tests, and a deliberate key rotation). */
export function clearAccessKeys() {
  caches.clear();
}

/**
 * The verified claims of an Access JWT, or an AccessError saying why not.
 * `now` is epoch ms; `fetcher` fetches the certificates (the global fetch).
 */
export async function verifyAccessJwt(token, settings, { now = Date.now(), fetcher = (...args) => fetch(...args) } = {}) {
  if (!settings.team || !settings.audience) throw new AccessError("Access is not configured (ACCESS_TEAM_DOMAIN, ACCESS_AUD)");
  if (typeof token !== "string" || !token) throw new AccessError("missing");
  const parts = token.split(".");
  if (parts.length !== 3) throw new AccessError("malformed token");
  const header = decodePart(parts[0], "header");
  if (header.alg !== "RS256") throw new AccessError("unexpected algorithm");
  if (typeof header.kid !== "string" || !header.kid) throw new AccessError("no key id");
  const claims = decodePart(parts[1], "claims");
  const key = await keyFor(header.kid, settings.certsUrl, { now, fetcher });
  if (!key) throw new AccessError("unknown key id");
  let signature;
  try {
    signature = base64UrlBytes(parts[2]);
  } catch {
    throw new AccessError("malformed signature");
  }
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, encoder.encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw new AccessError("bad signature");
  if (claims.iss !== settings.issuer) throw new AccessError("wrong issuer");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(settings.audience)) throw new AccessError("wrong audience");
  const seconds = now / 1000;
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS < seconds) throw new AccessError("expired");
  if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_SECONDS > seconds) throw new AccessError("not yet valid");
  return claims;
}

/**
 * Who the claims are: a person (`email`) or a service token (`common_name`,
 * the token's client id). `actor` is what the audit log records.
 */
export function identityOf(claims) {
  if (typeof claims.email === "string" && claims.email) {
    const email = claims.email.toLowerCase();
    return { kind: "user", actor: email, login: email, subject: String(claims.sub ?? email), issuedAt: claims.iat ?? 0, expiresAt: claims.exp };
  }
  if (typeof claims.common_name === "string" && claims.common_name) {
    return { kind: "service", actor: `service:${claims.common_name}`, login: `service:${claims.common_name}`, expiresAt: claims.exp };
  }
  throw new AccessError("no identity in token");
}

// ---------- Roles

export const ROLES = ["viewer", "operator", "admin"];

/** Logins in BOOTSTRAP_ADMINS, lower-cased, in order, without duplicates. */
export function bootstrapAdminList(value) {
  const seen = new Set();
  const admins = [];
  for (const item of String(value ?? "").split(/[\s,]+/)) {
    const login = item.trim().toLowerCase();
    if (!login || seen.has(login)) continue;
    seen.add(login);
    admins.push(login);
  }
  return admins;
}

/**
 * A role by login, from the `roles` setting (`{"me@example.com": "admin",
 * "service:<client-id>": "operator"}`) and the BOOTSTRAP_ADMINS var.
 * Bootstrap logins are always admin, whatever the map says. Anyone else
 * Access let in has no role.
 */
export function roleOf(login, { roles = {}, bootstrapAdmins = "" } = {}) {
  const name = String(login ?? "");
  if (bootstrapAdminList(bootstrapAdmins).includes(name.toLowerCase())) return "admin";
  const folded = name.toLowerCase();
  const role = roles?.[name] ?? Object.entries(roles ?? {}).find(([key]) => String(key).toLowerCase() === folded)?.[1];
  return ROLES.includes(role) ? role : null;
}

/**
 * Why `proposed` (a roles map already checked for shape) must be refused, or
 * null when it is safe to store. Bootstrap admins stay admin even if the map
 * omits them. The caller cannot drop their own admin role, and someone must
 * remain admin.
 */
export function rolesRefusal(proposed, { actor, bootstrapAdmins = "" } = {}) {
  const admins = bootstrapAdminList(bootstrapAdmins);
  for (const [login, role] of Object.entries(proposed ?? {})) {
    if (admins.includes(String(login).toLowerCase()) && role !== "admin") {
      return `${login} is a bootstrap admin and always stays admin`;
    }
  }
  const remains = admins.length > 0 || Object.values(proposed ?? {}).includes("admin");
  if (!remains) return "At least one admin must remain";
  if (roleOf(actor, { roles: proposed, bootstrapAdmins }) !== "admin") return "That would remove your own admin role";
  return null;
}

export function allows(role, needed) {
  return ROLES.indexOf(role) >= ROLES.indexOf(needed) && ROLES.includes(role);
}

// ---------- CSRF tokens for browser identities

const csrfKeys = new Map();

/** `HMAC(CSRF_KEY, sub + iat)`: stable for one Access session, useless for another. */
export async function csrfTokenFor(identity, secret) {
  if (!secret) return null;
  let key = csrfKeys.get(secret);
  if (!key) {
    key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    csrfKeys.set(secret, key);
  }
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${identity.subject}.${identity.issuedAt}`)));
  return btoa(String.fromCharCode(...mac)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

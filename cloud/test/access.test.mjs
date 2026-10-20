import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accessSettings, clearAccessKeys, roleOf, rolesRefusal, verifyAccessJwt } from "../src/access.mjs";
import { handle } from "../src/hc-web.mjs";
import {
  AUD, call, CERTS, KID, mintJwt, mockCertificates, OWNER, resetDatabase, rows, serviceClaims, strangerKey, TEAM, teamJwks, userClaims,
} from "./helpers.mjs";

const settings = accessSettings(env);
let certificates;

beforeEach(async () => {
  await resetDatabase();
  certificates = mockCertificates();
});
afterEach(() => certificates.mockRestore());

async function rejection(token, options) {
  try {
    await verifyAccessJwt(token, settings, options);
  } catch (error) {
    return error.reason;
  }
  return "accepted";
}

describe("Access JWT validation", () => {
  it("accepts a token signed by the team's key for this application", async () => {
    const claims = await verifyAccessJwt(await mintJwt(userClaims(OWNER)), settings);
    expect(claims.email).toBe(OWNER);
    expect(settings).toEqual({ team: TEAM, audience: AUD, issuer: `https://${TEAM}`, certsUrl: CERTS });
  });

  it("rejects a wrong audience, issuer, key id, signature or algorithm, and expired or early tokens", async () => {
    const seconds = Math.floor(Date.now() / 1000);
    expect(await rejection(undefined)).toBe("missing");
    expect(await rejection("not-a-jwt")).toBe("malformed token");
    expect(await rejection(await mintJwt(userClaims(OWNER, { aud: ["another-app"] })))).toBe("wrong audience");
    expect(await rejection(await mintJwt(userClaims(OWNER, { iss: "https://evil.cloudflareaccess.com" })))).toBe("wrong issuer");
    expect(await rejection(await mintJwt(userClaims(OWNER), { kid: "rotated-away" }))).toBe("unknown key id");
    expect(await rejection(await mintJwt(userClaims(OWNER), { key: strangerKey.privateKey }))).toBe("bad signature");
    expect(await rejection(await mintJwt(userClaims(OWNER), { alg: "HS256" }))).toBe("unexpected algorithm");
    expect(await rejection(await mintJwt(userClaims(OWNER, { exp: seconds - 120 })))).toBe("expired");
    expect(await rejection(await mintJwt(userClaims(OWNER, { exp: undefined })))).toBe("expired");
    expect(await rejection(await mintJwt(userClaims(OWNER, { nbf: seconds + 600 })))).toBe("not yet valid");
    // Tampering with the claims after signing breaks the signature.
    const [header, , signature] = (await mintJwt(userClaims("viewer@example.com"))).split(".");
    const forged = btoa(JSON.stringify(userClaims(OWNER))).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    expect(await rejection(`${header}.${forged}.${signature}`)).toBe("bad signature");
    const none = `${btoa(JSON.stringify({ alg: "none", kid: KID })).replace(/=+$/, "")}.${forged}.`;
    expect(await rejection(none)).toBe("unexpected algorithm");
  });

  it("caches the team's keys, and refetches for an unknown kid at most once a minute", async () => {
    clearAccessKeys();
    const token = await mintJwt(userClaims(OWNER, { exp: Math.floor(Date.now() / 1000) + 86_400 }));
    const now = Date.now();
    for (let index = 0; index < 5; index += 1) await verifyAccessJwt(token, settings, { now });
    expect(certificates).toHaveBeenCalledTimes(1);
    const unknown = await mintJwt(userClaims(OWNER), { kid: "forged" });
    for (let index = 0; index < 5; index += 1) await rejection(unknown, { now: now + 1000 });
    expect(certificates).toHaveBeenCalledTimes(1);
    await rejection(unknown, { now: now + 61_000 });
    expect(certificates).toHaveBeenCalledTimes(2);
    await verifyAccessJwt(token, settings, { now: now + 61_000 + 3_600_001 });
    expect(certificates).toHaveBeenCalledTimes(3, "keys are refreshed hourly");
  });

  it("uses the keys it has if a refresh fails, and fails closed without any", async () => {
    clearAccessKeys();
    const token = await mintJwt(userClaims(OWNER, { exp: Math.floor(Date.now() / 1000) + 86_400 }));
    const now = Date.now();
    await verifyAccessJwt(token, settings, { now });
    const down = async () => new Response("down", { status: 503 });
    await expect(verifyAccessJwt(token, settings, { now: now + 7_200_000, fetcher: down })).resolves.toMatchObject({ email: OWNER });
    clearAccessKeys();
    expect(await rejection(token, { now, fetcher: down })).toBe("certificates unavailable (HTTP 503)");
    expect(await rejection(token, { now, fetcher: async () => Response.json({ keys: [] }) })).toBe("unknown key id");
    expect(JSON.stringify(await teamJwks())).not.toMatch(/"d"/, "the test JWKS holds no private key material");
  });

  it("refuses everything when Access is not configured", async () => {
    await expect(verifyAccessJwt(await mintJwt(userClaims(OWNER)), accessSettings({}))).rejects.toThrow(/not configured/);
  });

  it("strips any URL scheme and trailing slashes from the team domain", () => {
    const host = "team.cloudflareaccess.com";
    for (const team of [host, `https://${host}`, `http://${host}/`, `HTTPS://${host}//`]) {
      expect(accessSettings({ ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: " aud-tag " })).toEqual({
        team: host,
        audience: "aud-tag",
        issuer: `https://${host}`,
        certsUrl: `https://${host}/cdn-cgi/access/certs`,
      });
    }
  });
});

describe("hc-web authentication and roles", () => {
  it("answers 401 without a valid token, on every API path", async () => {
    for (const path of ["/v1/snapshot", "/v1/jobs/x", "/v1/audit", "/v1/import"]) {
      expect((await call(path, { identity: null })).status, path).toBe(401);
    }
    expect((await call("/v1/session", { identity: null })).body).toEqual({ authenticated: false, tokenLogin: false, access: true });
    const expired = await mintJwt(userClaims(OWNER, { exp: Math.floor(Date.now() / 1000) - 3600 }));
    expect((await call("/v1/snapshot", { identity: null, headers: { "cf-access-jwt-assertion": expired } })).status).toBe(401);
    expect((await call("/v1/health", { identity: null })).status).toBe(200);
  });

  it("names the person, their role and their CSRF token", async () => {
    const { status, body } = await call("/v1/session");
    expect(status).toBe(200);
    expect(body).toMatchObject({ authenticated: true, method: "access", kind: "user", login: OWNER, role: "admin" });
    expect(body.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("maps emails and service tokens to roles from settings, and refuses anyone without one", async () => {
    expect((await call("/v1/snapshot", { identity: "stranger@example.com" })).body).toEqual({ error: "no_role", login: "stranger@example.com" });
    expect((await call("/v1/settings", {
      method: "PATCH",
      body: { roles: { "viewer@example.com": "viewer", "Operator@Example.com": "operator", "service:menubar.access": "operator" } },
    })).status).toBe(200);
    expect((await call("/v1/snapshot", { identity: "viewer@example.com" })).status).toBe(200);
    expect((await call("/v1/jobs/x/pause", { method: "POST", identity: "viewer@example.com" })).body)
      .toEqual({ error: "forbidden", role: "viewer", needs: "operator" });
    expect((await call("/v1/jobs/x/pause", { method: "POST", identity: "operator@example.com" })).status).toBe(404, "allowed, but no such job");
    expect((await call("/v1/jobs/x", { method: "PUT", identity: "operator@example.com", body: {} })).status).toBe(403);
    const session = await call("/v1/session", { identity: "service:menubar.access" });
    expect(session.body).toMatchObject({ kind: "service", login: "service:menubar.access", role: "operator" });
    expect(session.body.csrfToken).toBeUndefined();
    expect(roleOf("x@example.com", { roles: { "x@example.com": "root" } })).toBe(null, "unknown roles grant nothing");
    expect(roleOf("Owner@Example.com", { bootstrapAdmins: " owner@example.com, service:CLI " })).toBe("admin");
    expect(roleOf("service:CLI", { bootstrapAdmins: "service:cli" })).toBe("admin");
    expect(roleOf("service:CLI", { roles: { "service:cli": "operator" } })).toBe("operator");
  });

  it("adds, changes and removes roles, and audits only a change that passes CSRF", async () => {
    const forged = await call("/v1/settings", {
      method: "PATCH", headers: { "x-hc-csrf": undefined }, body: { roles: { "person@example.com": "admin" } },
    });
    expect(forged.body).toEqual({ error: "csrf_check_failed", reason: "csrf_token" });
    expect((await call("/v1/settings")).body.roles).toEqual({});
    expect(await rows("SELECT action FROM audit_log")).toEqual([]);

    for (const roles of [null, [], { "not-an-email": "viewer" }, { "service:": "viewer" }, { "a@b.com": "god" }, { "A@b.com": "admin", "a@b.com": "viewer" }]) {
      const refused = await call("/v1/settings", { method: "PATCH", body: { roles } });
      expect(refused.status, JSON.stringify(roles)).toBe(400);
    }
    expect(await rows("SELECT action FROM audit_log")).toEqual([], "a refused roles change is not audited");

    const added = await call("/v1/settings", { method: "PATCH", body: { roles: {
      "Person@Example.com": "viewer", "Service:Menubar.Access": "operator",
    } } });
    expect(added.status).toBe(200);
    expect(added.body.roles).toEqual({ "person@example.com": "viewer", "service:Menubar.Access": "operator" });
    expect(added.body.bootstrapAdmins).toEqual([OWNER]);
    expect(added.body.changed).toEqual(["roles"]);
    const audit = await call("/v1/audit?limit=1");
    expect(audit.body.entries[0]).toMatchObject({
      actor: OWNER, action: "settings.update", target: "roles",
      before: { roles: {} },
      after: { roles: { "person@example.com": "viewer", "service:Menubar.Access": "operator" } },
    });

    const changed = await call("/v1/settings", { method: "PATCH", body: { roles: {
      "person@example.com": "operator", "service:Menubar.Access": "admin",
    } } });
    expect(changed.body.roles).toEqual({ "person@example.com": "operator", "service:Menubar.Access": "admin" });
    expect((await call("/v1/session", { identity: "service:Menubar.Access" })).body.role).toBe("admin");

    const removed = await call("/v1/settings", { method: "PATCH", identity: "service:Menubar.Access", body: { roles: {
      "service:Menubar.Access": "admin",
    } } });
    expect(removed.status).toBe(200);
    expect(removed.body.roles).toEqual({ "service:Menubar.Access": "admin" });
    expect((await call("/v1/snapshot", { identity: "person@example.com" })).body.error).toBe("no_role");

    expect((await call("/v1/settings", { method: "PATCH", identity: "person@example.com", body: { roles: { "person@example.com": "admin" } } })).status).toBe(403);
    await call("/v1/settings", { method: "PATCH", body: { roles: { "op@example.com": "operator", "service:Menubar.Access": "admin" } } });
    expect((await call("/v1/settings", {
      method: "PATCH", identity: "op@example.com", body: { roles: { "op@example.com": "admin" } },
    })).body).toEqual({ error: "forbidden", role: "operator", needs: "admin" });
  });

  it("refuses a roles change that removes the last admin or the caller's own admin role", async () => {
    expect(rolesRefusal({}, { actor: OWNER, bootstrapAdmins: OWNER })).toBe(null);
    expect(rolesRefusal({ [OWNER]: "viewer" }, { actor: OWNER, bootstrapAdmins: OWNER })).toMatch(/bootstrap admin/);
    expect(rolesRefusal({}, { actor: "second@example.com", bootstrapAdmins: "" })).toBe("At least one admin must remain");
    expect(rolesRefusal({ "other@example.com": "admin" }, { actor: "second@example.com", bootstrapAdmins: "" })).toBe("That would remove your own admin role");

    const demoted = await call("/v1/settings", { method: "PATCH", body: { roles: { [OWNER]: "viewer", "second@example.com": "admin" } } });
    expect(demoted.status).toBe(400);
    expect(demoted.body.error).toMatch(/bootstrap admin/);
    expect((await call("/v1/settings")).body.roles).toEqual({});

    await call("/v1/settings", { method: "PATCH", body: { roles: { "second@example.com": "admin", "third@example.com": "admin" } } });
    const self = await call("/v1/settings", {
      method: "PATCH", identity: "second@example.com", body: { roles: { "third@example.com": "admin" } },
    });
    expect(self.status).toBe(400);
    expect(self.body.error).toBe("That would remove your own admin role");
    expect((await call("/v1/session", { identity: "second@example.com" })).body.role).toBe("admin");

    const byOther = await call("/v1/settings", {
      method: "PATCH", identity: "third@example.com", body: { roles: { "third@example.com": "admin" } },
    });
    expect(byOther.status).toBe(200);
    expect((await call("/v1/snapshot", { identity: "second@example.com" })).body).toEqual({ error: "no_role", login: "second@example.com" });

    const cleared = await call("/v1/settings", { method: "PATCH", body: { roles: {} } });
    expect(cleared.status).toBe(200, "a bootstrap admin can clear the map and still be admin");
    expect((await call("/v1/session")).body.role).toBe("admin");

    await call("/v1/settings", { method: "PATCH", body: { roles: { "second@example.com": "admin" } } });
    const bare = { ...env, BOOTSTRAP_ADMINS: "" };
    const last = await call("/v1/settings", {
      method: "PATCH", identity: "second@example.com", environment: bare, body: { roles: { "viewer@example.com": "viewer" } },
    });
    expect(last.status).toBe(400);
    expect(last.body.error).toBe("At least one admin must remain");
    expect((await call("/v1/settings")).body.roles).toEqual({ "second@example.com": "admin" });

    const service = await call("/v1/settings", { method: "PATCH", body: { roles: { "service:cli.access": "admin" } } });
    expect(service.status).toBe(200);
    const serviceLock = await call("/v1/settings", {
      method: "PATCH", identity: "service:cli.access", body: { roles: {} },
    });
    expect(serviceLock.status).toBe(400);
    expect(serviceLock.body.error).toBe("That would remove your own admin role");
  });

  it("takes DEV_ACCESS_EMAIL only on localhost, for wrangler dev", async () => {
    const devEnv = { ...env, DEV_ACCESS_EMAIL: "dev@example.com", BOOTSTRAP_ADMINS: "dev@example.com" };
    const local = await handle(new Request("http://localhost:8787/v1/session"), devEnv);
    const session = await local.json();
    expect(session).toMatchObject({ authenticated: true, login: "dev@example.com", role: "admin" });
    expect(session.csrfToken, "the dashboard's own GET has no Origin but still needs its token").toBeTruthy();
    const deployed = await handle(new Request("https://hc-web.example.workers.dev/v1/session", { headers: { host: "localhost" } }), devEnv);
    expect(deployed.status).toBe(401);
    // A local script (no Origin) may change things; a page from another origin still may not.
    const json = { "content-type": "application/json" };
    expect((await handle(new Request("http://localhost:8787/v1/pause-all", { method: "POST", headers: json, body: "{}" }), devEnv)).status).toBe(200);
    const page = await handle(new Request("http://localhost:8787/v1/resume-all",
      { method: "POST", headers: { ...json, origin: "https://evil.example" }, body: "{}" }), devEnv);
    expect(page.status).toBe(403);
  });

  it("accepts a service token's mutation without CSRF (it is not a browser), but only as JSON", async () => {
    await call("/v1/settings", { method: "PATCH", body: { roles: { "service:cli.access": "admin" } } });
    const ok = await call("/v1/pause-all", { method: "POST", identity: "service:cli.access" });
    expect(ok.status).toBe(200);
    const form = await call("/v1/resume-all", { method: "POST", identity: "service:cli.access", headers: { "content-type": "text/plain" } });
    expect(form.body).toEqual({ error: "csrf_check_failed", reason: "content_type" });
    const crossSite = await call("/v1/resume-all", { method: "POST", identity: "service:cli.access", headers: { origin: "https://evil.example" } });
    expect(crossSite.body.reason).toBe("origin");
  });
});

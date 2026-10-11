import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { originMatches } from "./core/csrf.mjs";

const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "::1"]);
const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "tailscale-user-login"];
const COOKIE = "hc_session";
const SECURE_COOKIE = `__Host-${COOKIE}`;
const LINK_SECONDS = 60;
const FAILURE_WINDOW_MS = 10 * 60_000;
const FAILURE_LIMIT = 10;

function equal(a, b) {
  const left = Buffer.from(String(a ?? ""));
  const right = Buffer.from(String(b ?? ""));
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The host name of a Host header value, lower-case, without port or IPv6 brackets. */
export function hostnameOf(host) {
  const value = String(host ?? "").trim().toLowerCase();
  if (value.startsWith("[")) return value.slice(1, value.indexOf("]"));
  return value.replace(/:\d+$/, "");
}

function header(request, name) {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function cookies(request) {
  const result = {};
  for (const part of String(header(request, "cookie") ?? "").split(";")) {
    const equals = part.indexOf("=");
    if (equals > 0) result[part.slice(0, equals).trim()] = part.slice(equals + 1).trim();
  }
  return result;
}

/**
 * Who a request is, for the API and the dashboard:
 *
 * - `token`: the API's bearer token, as the menu bar app and scripts send it.
 * - `tailscale`: a tailnet user `tailscale serve` vouched for. Only believed
 *   when the connection comes from this machine's loopback (where `tailscale
 *   serve` connects from) and the login is in the allow-list.
 * - `session`: a browser that signed in with the token, or through a one-time
 *   link the menu bar app opened; an HttpOnly, SameSite=Strict cookie (Secure
 *   whenever the browser reached us over HTTPS).
 * - `local`: no token is configured and the request came straight from this
 *   machine, not through a proxy: the controller's behaviour before tokens.
 *
 * Browser identities (everything but `token`) are only accepted for a Host
 * this controller answers to (loopback names, `*.ts.net`, and configured
 * hosts), which defeats DNS rebinding, and each carries a CSRF token that a
 * state-changing request must echo, from its own origin.
 */
export class DashboardAuth {
  constructor({ token, allowedLogins = [], hosts = [], sessionHours = 24 * 7, clock = () => Date.now() } = {}) {
    this.token = token || undefined;
    this.allowedLogins = new Set(allowedLogins.map((login) => login.trim().toLowerCase()).filter(Boolean));
    this.hosts = new Set(hosts.map((host) => hostnameOf(host)));
    this.sessionMs = sessionHours * 3_600_000;
    this.clock = clock;
    this.secret = randomBytes(32);
    this.sessions = new Map();
    this.links = new Map();
    this.failures = [];
  }

  isLoopbackPeer(request) {
    return LOOPBACK_PEERS.has(request.socket?.remoteAddress);
  }

  isProxied(request) {
    return PROXY_HEADERS.some((name) => header(request, name) !== undefined);
  }

  hostAllowed(request) {
    const name = hostnameOf(header(request, "host"));
    return LOOPBACK_NAMES.has(name) || name.endsWith(".ts.net") || this.hosts.has(name);
  }

  /**
   * Reached over HTTPS through a local proxy such as `tailscale serve`, which
   * says so in X-Forwarded-Proto. Without that, a Secure cookie could be one
   * the browser never stores (plain `tailscale serve --http`), so it is not.
   */
  isHttps(request) {
    if (!this.isLoopbackPeer(request) || !this.isProxied(request)) return false;
    return String(header(request, "x-forwarded-proto") ?? "").split(",")[0].trim() === "https";
  }

  /** The tailnet login `tailscale serve` attached, when it may be believed at all. */
  tailscaleLogin(request) {
    const login = header(request, "tailscale-user-login");
    if (!login || !this.isLoopbackPeer(request)) return undefined;
    return login.trim().toLowerCase();
  }

  csrfFor(subject) {
    return createHmac("sha256", this.secret).update(subject).digest("base64url");
  }

  session(request) {
    const jar = cookies(request);
    const id = jar[SECURE_COOKIE] ?? jar[COOKIE];
    if (!id) return undefined;
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (session.expires <= this.clock()) {
      this.sessions.delete(id);
      return undefined;
    }
    return { id, ...session };
  }

  /** The request's identity, or undefined. A wrong bearer token is never passed over for another method. */
  authenticate(request) {
    const authorization = header(request, "authorization");
    // Without a configured token a client's Authorization header means nothing, as before.
    if (authorization !== undefined && this.token) {
      return equal(authorization, `Bearer ${this.token}`) ? { method: "token" } : undefined;
    }
    if (this.hostAllowed(request)) {
      const login = this.tailscaleLogin(request);
      if (login && this.allowedLogins.has(login)) {
        return { method: "tailscale", login, csrf: this.csrfFor(`tailscale:${login}`) };
      }
      const session = this.session(request);
      if (session) return { method: "session", session: session.id, csrf: session.csrf, expires: session.expires };
    }
    if (!this.token && this.isLoopbackPeer(request) && !this.isProxied(request)
      && LOOPBACK_NAMES.has(hostnameOf(header(request, "host")))) {
      return { method: "local", csrf: this.csrfFor("local") };
    }
    return undefined;
  }

  /** Whether the request's Origin is the page it was sent to (the direct or the forwarded host). */
  sameOrigin(request) {
    return originMatches(header(request, "origin"), [header(request, "host"), header(request, "x-forwarded-host")]);
  }

  /**
   * Whether a state-changing request may go ahead. Bearer requests carry
   * their own proof. A browser identity needs its own origin, a same-origin
   * fetch, and its CSRF token; a tokenless local client without an Origin
   * (curl, a script) is not a browser and is let through as before.
   */
  allowsChange(request, identity) {
    if (identity.method === "token") return true;
    const fetchSite = header(request, "sec-fetch-site");
    if (fetchSite && fetchSite !== "same-origin") return false;
    if (identity.method === "local" && !header(request, "origin")) return true;
    return this.sameOrigin(request) && equal(header(request, "x-csrf-token"), identity.csrf);
  }

  createSession(method) {
    const id = randomBytes(32).toString("base64url");
    const session = { method, csrf: randomBytes(24).toString("base64url"), expires: this.clock() + this.sessionMs };
    this.sessions.set(id, session);
    // Sessions live in memory; forget expired ones as new ones arrive.
    for (const [key, value] of this.sessions) if (value.expires <= this.clock()) this.sessions.delete(key);
    return { id, ...session };
  }

  sessionCookie(request, id, maxAgeSeconds) {
    const secure = this.isHttps(request);
    return [
      `${secure ? SECURE_COOKIE : COOKIE}=${id}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
      ...(secure ? ["Secure"] : []),
    ].join("; ");
  }

  clearCookies(request) {
    return [this.sessionCookie(request, "", 0), `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`];
  }

  /** Signs in with the API token. Throttled after repeated failures. */
  login(token) {
    const now = this.clock();
    this.failures = this.failures.filter((time) => now - time < FAILURE_WINDOW_MS);
    if (this.failures.length >= FAILURE_LIMIT) return { error: "throttled" };
    if (!this.token) return { error: "no_token_configured" };
    if (typeof token !== "string" || !equal(token.trim(), this.token)) {
      this.failures.push(now);
      return { error: "invalid_token" };
    }
    return { session: this.createSession("token-login") };
  }

  /** A single-use code, good for a minute, that signs a browser in (the menu bar app's "Open dashboard"). */
  createLink() {
    const code = randomBytes(32).toString("base64url");
    const expires = this.clock() + LINK_SECONDS * 1000;
    this.links.set(code, expires);
    for (const [key, value] of this.links) if (value <= this.clock()) this.links.delete(key);
    return { code, expires };
  }

  redeemLink(code) {
    const expires = typeof code === "string" ? this.links.get(code) : undefined;
    if (expires === undefined) return undefined;
    this.links.delete(code);
    return expires > this.clock() ? this.createSession("link") : undefined;
  }

  logout(identity) {
    if (identity?.session) this.sessions.delete(identity.session);
  }
}

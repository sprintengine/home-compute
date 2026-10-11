import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { DashboardAuth } from "./auth.mjs";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
};
const DASHBOARD_DIRECTORY = path.resolve(import.meta.dirname, "../dashboard");
const DASHBOARD_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/assets/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/assets/app.css": ["app.css", "text/css; charset=utf-8"],
  "/assets/icon.svg": ["icon.svg", "image/svg+xml"],
  "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"],
};
const JOB = "([a-z0-9][a-z0-9-]{0,62})";

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { ...JSON_HEADERS, ...headers });
  response.end(`${JSON.stringify(body)}\n`);
}

function errorStatus(error) {
  if (Number.isInteger(error.status)) return error.status;
  if (/^Unknown job /.test(error.message)) return 404;
  if (/already has active/.test(error.message)) return 409;
  return 400;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

function events(request, response, service) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    // Proxies (tailscale serve among them) must pass each event on at once.
    "x-accel-buffering": "no",
  });
  response.write(`event: ready\ndata: ${JSON.stringify({ service: "home-compute" })}\n\n`);
  const unsubscribe = service.subscribe((event) => {
    response.write(`event: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`);
  });
  // A comment line now and then keeps idle proxies and phones from dropping the stream.
  const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 25_000);
  request.once("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

/**
 * The control API and, unless `dashboard.enabled` is false, the browser
 * dashboard: static files from `dashboard/` at `/`, signed in through
 * `/v1/session`. See DashboardAuth for who may do what.
 */
export function createApiServer({
  service, host = "127.0.0.1", port = 4786, token, dashboard = {}, logger = console, auth: providedAuth,
}) {
  const auth = providedAuth ?? new DashboardAuth({
    token,
    allowedLogins: dashboard.allowedLogins ?? [],
    hosts: dashboard.hosts ?? [],
    sessionHours: dashboard.sessionHours,
  });
  const dashboardEnabled = dashboard.enabled !== false;
  const files = new Map();

  async function serveFile(response, pathname) {
    const [name, type] = DASHBOARD_FILES[pathname];
    if (!files.has(name)) files.set(name, await readFile(path.join(DASHBOARD_DIRECTORY, name)));
    response.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
    response.end(files.get(name));
  }

  async function session(request, response, url) {
    if (url.pathname === "/v1/session/link") {
      // Only a holder of the API token (the menu bar app) may mint a sign-in link.
      const identity = auth.authenticate(request);
      if (request.method !== "POST" || identity?.method !== "token") {
        sendJson(response, identity ? 403 : 401, { error: identity ? "forbidden" : "unauthorized" });
        return;
      }
      const link = auth.createLink();
      const base = `${auth.isHttps(request) ? "https" : "http"}://${request.headers.host ?? `127.0.0.1:${port}`}`;
      sendJson(response, 201, {
        url: `${base}/login?code=${encodeURIComponent(link.code)}`,
        expiresAt: new Date(link.expires).toISOString(),
      });
      return;
    }
    if (request.method === "GET") {
      const identity = auth.authenticate(request);
      const seen = auth.tailscaleLogin(request);
      sendJson(response, 200, identity ? {
        authenticated: true,
        method: identity.method,
        ...(identity.login ? { login: identity.login } : {}),
        ...(identity.csrf ? { csrfToken: identity.csrf } : {}),
        ...(identity.expires ? { expiresAt: new Date(identity.expires).toISOString() } : {}),
      } : {
        authenticated: false,
        tokenLogin: Boolean(auth.token),
        ...(seen ? { tailscaleLogin: seen, tailscaleAllowed: false } : {}),
      });
      return;
    }
    if (!auth.hostAllowed(request) || !auth.sameOrigin(request)
      || (request.headers["sec-fetch-site"] && request.headers["sec-fetch-site"] !== "same-origin")) {
      sendJson(response, 403, { error: "forbidden" });
      return;
    }
    if (request.method === "POST") {
      const result = auth.login((await readJson(request)).token);
      if (result.error) {
        const status = result.error === "throttled" ? 429 : result.error === "no_token_configured" ? 409 : 401;
        logger.error(JSON.stringify({ event: "dashboard_login_failed", reason: result.error }));
        sendJson(response, status, { error: result.error });
        return;
      }
      response.setHeader("set-cookie", auth.sessionCookie(request, result.session.id, auth.sessionMs / 1000));
      sendJson(response, 200, {
        authenticated: true,
        method: "session",
        csrfToken: result.session.csrf,
        expiresAt: new Date(result.session.expires).toISOString(),
      });
      return;
    }
    if (request.method === "DELETE") {
      const identity = auth.authenticate(request);
      if (identity && auth.allowsChange(request, identity)) auth.logout(identity);
      response.setHeader("set-cookie", auth.clearCookies(request));
      sendJson(response, 200, { authenticated: false });
      return;
    }
    sendJson(response, 405, { error: "method_not_allowed" });
  }

  async function redeemLogin(request, response, url) {
    const created = auth.hostAllowed(request) ? auth.redeemLink(url.searchParams.get("code")) : undefined;
    if (created) response.setHeader("set-cookie", auth.sessionCookie(request, created.id, auth.sessionMs / 1000));
    response.writeHead(303, { location: created ? "/" : "/?signin=expired", "cache-control": "no-store" });
    response.end();
  }

  async function api(request, response, url) {
    if (request.method === "GET" && url.pathname === "/v1/health") {
      sendJson(response, 200, { status: "ok", service: "home-compute" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/snapshot") {
      sendJson(response, 200, await service.snapshot({ live: url.searchParams.get("live") !== "false" }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/events") {
      events(request, response, service);
      return;
    }
    let match = url.pathname.match(new RegExp(`^/v1/jobs/${JOB}/runs$`));
    if (request.method === "GET" && match) {
      const limit = url.searchParams.has("limit") ? Number.parseInt(url.searchParams.get("limit"), 10) || undefined : undefined;
      sendJson(response, 200, await service.runs(match[1], { limit }));
      return;
    }
    match = url.pathname.match(/^\/v1\/runs\/([^/]+)\/logs$/);
    if (request.method === "GET" && match) {
      sendJson(response, 200, await service.logs(decodeURIComponent(match[1]), { lines: url.searchParams.get("lines") ?? undefined }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/reload") {
      sendJson(response, 200, await service.reloadConfig({ reason: "request" }));
      return;
    }
    match = url.pathname.match(new RegExp(`^/v1/jobs/${JOB}/timetable$`));
    if (request.method === "POST" && match) {
      sendJson(response, 200, await service.setTimetable(match[1], await readJson(request)));
      return;
    }
    match = url.pathname.match(new RegExp(`^/v1/jobs/${JOB}/(run|pause|resume)$`));
    if (request.method === "POST" && match) {
      const [, id, action] = match;
      const result = action === "run"
        ? await service.run(id, (await readJson(request)).extraParameters ?? [])
        : await service.setPaused(id, action === "pause");
      sendJson(response, 202, result);
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://controller.invalid");
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
    try {
      if (dashboardEnabled && request.method === "GET" && Object.hasOwn(DASHBOARD_FILES, url.pathname)) {
        await serveFile(response, url.pathname);
        return;
      }
      if (dashboardEnabled && request.method === "GET" && url.pathname === "/login") {
        await redeemLogin(request, response, url);
        return;
      }
      if (url.pathname === "/v1/session" || url.pathname === "/v1/session/link") {
        await session(request, response, url);
        return;
      }
      const identity = auth.authenticate(request);
      if (!identity) {
        response.setHeader("www-authenticate", "Bearer");
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      if (!["GET", "HEAD"].includes(request.method) && !auth.allowsChange(request, identity)) {
        sendJson(response, 403, { error: "csrf_check_failed" });
        return;
      }
      await api(request, response, url);
    } catch (error) {
      logger.error(JSON.stringify({ event: "api_error", path: url.pathname, error: error.message }));
      if (!response.headersSent) sendJson(response, errorStatus(error), { error: error.message });
      else response.end();
    }
  });

  return {
    auth,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      const address = server.address();
      return { host, port: typeof address === "object" && address ? address.port : port };
    },
    async close() {
      if (!server.listening) return;
      const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}

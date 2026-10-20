// The agent's local status server (§4.7), for the menu bar and tray apps and
// `home-compute-agent status`. It listens on 127.0.0.1 only (there is no
// setting to change that), and every request must carry the token from the
// state directory's 0600 `status-token` file, so another user of the machine
// cannot use it either. It is read-mostly:
//
//   GET  /v1/status              the agent: connection, pause, the runs in hand with their stats
//   GET  /v1/history?limit=N     the newest N finished runs from history.jsonl (default 20, at most 500)
//   POST /v1/pause               claim nothing new until resumed; kept across restarts
//   POST /v1/resume
//   POST /v1/drain               {"drain": true|false}: finish what runs, report it, then restart
//   POST /v1/restart             restart now; running jobs carry on and are adopted
//
// and, as before, GET /status and POST /drain {"drain": bool} (the pause switch).
// A request naming another Host (DNS rebinding) or carrying an Origin (a
// browser page) is refused before the token is looked at; a POST needs a
// JSON content type. Answers are never cached.

import { createServer } from "node:http";
import { constantTimeEqual } from "../../src/core/csrf.mjs";

export const HISTORY_LIMIT_MAX = 500;
const LOOPBACK = new Set(["127.0.0.1"]);

function send(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

async function readBody(request, maxBytes = 1024) {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (text.length > maxBytes) throw new Error("too large");
  }
  return text ? JSON.parse(text) : {};
}

/** The Host header names this server: 127.0.0.1 or localhost, on its own port. */
export function hostAllowed(host, port) {
  if (typeof host !== "string") return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/**
 * Starts the server; resolves to `{port, close()}`. Port 0 picks a free port
 * (tests). `host` may only be 127.0.0.1: anything else throws, so a caller
 * can never put the server on a network interface.
 */
export async function startStatusServer({ agent, token, port, host = "127.0.0.1" }) {
  if (!LOOPBACK.has(host)) throw new Error(`the status server listens on 127.0.0.1 only, not ${host}`);
  if (typeof token !== "string" || token.length < 32) throw new Error("the status server needs a token of at least 32 characters");
  let listening = port;
  const server = createServer(async (request, response) => {
    try {
      if (!hostAllowed(request.headers.host, listening)) return send(response, 421, { error: "wrong_host" });
      if (request.headers.origin !== undefined) return send(response, 403, { error: "browsers_refused" });
      const presented = request.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
      if (!constantTimeEqual(presented, token)) return send(response, 401, { error: "unauthorized" });
      const url = new URL(request.url, "http://127.0.0.1");
      const { pathname } = url;
      if (request.method === "GET") {
        if (pathname === "/v1/status" || pathname === "/status" || pathname === "/") return send(response, 200, await agent.status());
        if (pathname === "/v1/history") {
          const asked = url.searchParams.get("limit");
          const limit = asked === null ? 20 : Number(asked);
          if (!Number.isInteger(limit) || limit < 0) return send(response, 400, { error: "limit must be a whole number" });
          return send(response, 200, { runs: await agent.history.recent(Math.min(limit, HISTORY_LIMIT_MAX)) });
        }
      }
      const action = {
        "/v1/pause": async () => agent.setPaused(true),
        "/v1/resume": async () => agent.setPaused(false),
        "/v1/drain": async (body) => {
          if (body.drain !== undefined && typeof body.drain !== "boolean") throw Object.assign(new Error("drain must be true or false"), { status: 400 });
          await agent.setDraining(body.drain ?? true);
        },
        // After the answer has gone: the restart closes this server.
        "/v1/restart": async () => () => agent.requestRestart("asked through the status server"),
        "/drain": async (body) => {
          if (typeof body.drain !== "boolean") throw Object.assign(new Error("drain must be true or false"), { status: 400 });
          await agent.setPaused(body.drain);
        },
      }[pathname];
      if (!action) return send(response, 404, { error: "not_found" });
      if (request.method !== "POST") return send(response, 405, { error: "method_not_allowed" });
      if (!/^application\/json\b/i.test(request.headers["content-type"] ?? "")) return send(response, 415, { error: "json_required" });
      const body = await readBody(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) return send(response, 400, { error: "the body must be a JSON object" });
      const after = await action(body);
      if (typeof after === "function") response.once("finish", after);
      return send(response, 200, await agent.status());
    } catch (error) {
      return send(response, error.status ?? 400, { error: error.message });
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  listening = server.address().port;
  return {
    port: listening,
    address: server.address().address,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

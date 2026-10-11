// The agent's local status server (§4.7): 127.0.0.1 only, read-only apart
// from POST /drain, and every request must carry the token from the state
// directory's 0600 `status-token` file. The menu bar app reads it.

import { createServer } from "node:http";
import { constantTimeEqual } from "../../src/core/csrf.mjs";

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
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

/** Starts the server; resolves to `{port, close()}`. Port 0 picks a free port (tests). */
export async function startStatusServer({ agent, token, port, host = "127.0.0.1" }) {
  const server = createServer(async (request, response) => {
    try {
      const presented = request.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
      if (!constantTimeEqual(presented, token)) return send(response, 401, { error: "unauthorized" });
      const { pathname } = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && (pathname === "/status" || pathname === "/")) return send(response, 200, await agent.status());
      if (pathname === "/drain") {
        if (request.method !== "POST") return send(response, 405, { error: "method_not_allowed" });
        if (!/^application\/json\b/i.test(request.headers["content-type"] ?? "")) return send(response, 415, { error: "json_required" });
        const body = await readBody(request);
        if (typeof body.drain !== "boolean") return send(response, 400, { error: "drain must be true or false" });
        await agent.setDrain(body.drain);
        return send(response, 200, await agent.status());
      }
      return send(response, 404, { error: "not_found" });
    } catch (error) {
      return send(response, 400, { error: error.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

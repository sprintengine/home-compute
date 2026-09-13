import { createServer } from "node:http";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function sendJson(response, status, body) {
  response.writeHead(status, JSON_HEADERS);
  response.end(`${JSON.stringify(body)}\n`);
}

function errorStatus(error) {
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

function authorized(request, token) {
  if (!token) return true;
  return request.headers.authorization === `Bearer ${token}`;
}

export function createApiServer({ service, host = "127.0.0.1", port = 4786, token, logger = console }) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (!authorized(request, token)) {
      response.setHeader("www-authenticate", "Bearer");
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }

    try {
      if (request.method === "GET" && url.pathname === "/v1/health") {
        sendJson(response, 200, { status: "ok", service: "home-compute" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        sendJson(response, 200, await service.snapshot({ live: url.searchParams.get("live") !== "false" }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/events") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        response.write(`event: ready\ndata: ${JSON.stringify({ service: "home-compute" })}\n\n`);
        const unsubscribe = service.subscribe((event) => {
          response.write(`event: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`);
        });
        request.once("close", unsubscribe);
        return;
      }

      const match = url.pathname.match(/^\/v1\/jobs\/([a-z0-9-]+)\/(run|pause|resume)$/);
      if (request.method === "POST" && match) {
        const [, id, action] = match;
        const result = action === "run"
          ? await service.run(id, (await readJson(request)).extraParameters ?? [])
          : await service.setPaused(id, action === "pause");
        sendJson(response, 202, result);
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      logger.error(JSON.stringify({ event: "api_error", path: url.pathname, error: error.message }));
      sendJson(response, errorStatus(error), { error: error.message });
    }
  });

  return {
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

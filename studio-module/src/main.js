const DEFAULT_ENDPOINT = "http://127.0.0.1:4786";

function connection(input) {
  const value = input && typeof input === "object" ? input : {};
  const parsed = new URL(typeof value.endpoint === "string" && value.endpoint.trim() ? value.endpoint : DEFAULT_ENDPOINT);
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) throw new Error("Home Compute endpoint must use http or https");
  if (parsed.username || parsed.password || parsed.hash || parsed.search) throw new Error("Home Compute endpoint cannot contain credentials, a query, or a fragment");
  return {
    endpoint: parsed.toString().replace(/\/$/, ""),
    token: typeof value.token === "string" ? value.token : "",
  };
}

async function request(input, method, path, body) {
  const { endpoint, token } = connection(input);
  const response = await fetch(`${endpoint}${path}`, {
    method,
    redirect: "error",
    headers: {
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Home Compute returned HTTP ${response.status}`);
  return payload;
}

function command(input, action) {
  const id = input && typeof input === "object" && typeof input.jobId === "string" ? input.jobId : "";
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) throw new Error("A valid Home Compute job id is required");
  return request(input, "POST", `/v1/jobs/${id}/${action}`, action === "run" ? { extraParameters: [] } : undefined);
}

export function registerMain(host) {
  host.registerIpc("home-compute:snapshot", (_event, input) => request(input, "GET", "/v1/snapshot"));
  host.registerIpc("home-compute:run", (_event, input) => command(input, "run"));
  host.registerIpc("home-compute:pause", (_event, input) => command(input, "pause"));
  host.registerIpc("home-compute:resume", (_event, input) => command(input, "resume"));
  host.registerIpc("home-compute:test-connection", (_event, input) => request(input, "GET", "/v1/health"));
}

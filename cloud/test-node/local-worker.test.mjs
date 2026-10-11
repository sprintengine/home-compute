// End to end against hc-web running locally, as a developer runs it:
// `wrangler d1 migrations apply --local`, then `wrangler dev` with local D1.
// A local JWKS server stands in for the Access team, and the CLI signs in
// with a service-token JWT from it (HC_ACCESS_JWT).
import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);
const CLOUD = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(CLOUD, "..");
const WRANGLER = path.join(ROOT, "node_modules/.bin/wrangler");
const CLI = path.join(ROOT, "src/cli.mjs");
const FIXTURE = path.join(ROOT, "test/fixtures/wingfoil-home-compute.json");
const TEAM = "local-test.cloudflareaccess.com";
const AUD = "local-test-aud";
const IMAGE = "ghcr.io/sprintengine/wingfoil-forecast@sha256:feedface";
const quiet = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" };

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function serviceToken(privateKey, commonName) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", kid: "local-1", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({ aud: [AUD], common_name: commonName, exp: now + 3600, iat: now, iss: `https://${TEAM}`, sub: "", type: "app" }));
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(privateKey).toString("base64url");
  return `${header}.${claims}.${signature}`;
}

async function waitFor(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${url} did not come up`);
}

test("the CLI imports Wingfoil's timetable into hc-web under wrangler dev, and the dashboard loads", { timeout: 180_000 }, async (context) => {
  const state = await mkdtemp(path.join(os.tmpdir(), "hc-cloud-dev-"));
  context.after(() => rm(state, { recursive: true, force: true }));

  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "local-1", alg: "RS256", use: "sig" }] };
  const certs = createServer((request, response) => {
    response.writeHead(request.url === "/cdn-cgi/access/certs" ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(jwks));
  });
  await new Promise((resolve) => certs.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => certs.close(resolve)));

  await execFile(WRANGLER, ["d1", "migrations", "apply", "home-compute", "--local", "-c", "wrangler.web.jsonc", "--persist-to", state],
    { cwd: CLOUD, env: quiet });

  const port = await freePort();
  const vars = {
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ACCESS_CERTS_URL: `http://127.0.0.1:${certs.address().port}/cdn-cgi/access/certs`,
    BOOTSTRAP_ADMINS: "service:cli.local-test",
    CSRF_KEY: "local-test-csrf-key",
  };
  const dev = spawn(WRANGLER, ["dev", "-c", "wrangler.web.jsonc", "--persist-to", state, "--port", String(port), "--ip", "127.0.0.1",
    "--log-level", "warn", ...Object.entries(vars).flatMap(([name, value]) => ["--var", `${name}:${value}`])],
  { cwd: CLOUD, env: quiet, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  dev.stdout.on("data", (chunk) => { output += chunk; });
  dev.stderr.on("data", (chunk) => { output += chunk; });
  context.after(() => new Promise((resolve) => {
    dev.once("exit", resolve);
    dev.kill("SIGTERM");
  }));
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(`${base}/v1/health`);
  } catch (error) {
    throw new Error(`${error.message}\n${output}`);
  }

  const token = serviceToken(privateKey, "cli.local-test");
  const cliEnv = { ...process.env, HC_URL: base, HC_ACCESS_JWT: token };
  const importArgs = [CLI, "cloud", "import", FIXTURE, "--preset", "wingfoil", "--image", IMAGE];

  const dry = await execFile(process.execPath, [...importArgs, "--dry-run"], { env: cliEnv });
  assert.match(dry.stdout, /^Import with preset wingfoil into http:\/\/127\.0\.0\.1:\d+ \(dry run: nothing written\)$/m);
  assert.match(dry.stdout, /^\+ ecmwf\s+create {2}at 08:20, 10:20 UTC · 1 CPU 1024 MiB · 3900 s$/m);
  assert.match(dry.stdout, /^\+ blend\s+create {2}hourly at :05 · 1 CPU 512 MiB · 1200 s$/m);
  assert.match(dry.stdout, /^\+ aifs\s+create {2}\(disabled\) at 00:25, 06:25, 12:25, 18:25 UTC/m);
  assert.match(dry.stdout, /^21 to create, 0 to update, 0 with kept edits, 0 unchanged\. Rerun without --dry-run to apply\.$/m);

  const headers = { "cf-access-jwt-assertion": token };
  const empty = await (await fetch(`${base}/v1/snapshot`, { headers })).json();
  assert.equal(empty.jobs?.length, 0, `a dry run writes nothing: ${JSON.stringify(empty)}`);

  const applied = await execFile(process.execPath, importArgs, { env: cliEnv });
  assert.match(applied.stdout, /^21 to create, 0 to update, 0 with kept edits, 0 unchanged\.$/m);
  const again = await execFile(process.execPath, importArgs, { env: cliEnv });
  assert.match(again.stdout, /^= ecmwf\s+unchanged$/m);
  assert.match(again.stdout, /^0 to create, 0 to update, 0 with kept edits, 21 unchanged\.$/m);

  const snapshot = await (await fetch(`${base}/v1/snapshot`, { headers })).json();
  assert.equal(snapshot.jobs?.length, 21, JSON.stringify(snapshot).slice(0, 500));
  const ecmwf = snapshot.jobs.find((job) => job.id === "ecmwf");
  assert.deepEqual([ecmwf.image, ecmwf.schedule, ecmwf.preset], [IMAGE, { at: { hours: [8, 10], minutes: [20] }, timezone: "UTC" }, "wingfoil"]);

  // Without a token, or with one from another team, the API refuses; the CLI says so and exits non-zero.
  await assert.rejects(execFile(process.execPath, [...importArgs, "--dry-run"], { env: { ...process.env, HC_URL: base } }), /HTTP 401/);
  assert.equal((await fetch(`${base}/v1/snapshot`)).status, 401);

  // The existing dashboard is served as static assets and asks for the snapshot it can read.
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<script type="module" src="\/assets\/app.js">/);
  const script = await fetch(`${base}/assets/app.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /javascript/);
  assert.match(await script.text(), /api\("\/v1\/snapshot"\)/);
  assert.equal((await fetch(`${base}/assets/app.css`)).status, 200);
  assert.equal((await fetch(`${base}/manifest.webmanifest`)).status, 200);
  assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
});

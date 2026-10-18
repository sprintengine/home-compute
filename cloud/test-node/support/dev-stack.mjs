// hc-web and hc-core under `wrangler dev`, as a developer runs them, sharing
// one local D1 in a scratch directory; a local JWKS server stands in for the
// Access team, so browsers can be signed in as different people (an admin, a
// viewer) with `Cf-Access-Jwt-Assertion`, as Access itself would send it.
// DEV_ACCESS_EMAIL is set too: a request without a JWT is that person.
// Used by the dashboard's browser tests and its screenshot script.
import { execFile as execFileCallback, spawn } from "node:child_process";
import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
export const CLOUD = path.resolve(import.meta.dirname, "../..");
export const ROOT = path.resolve(CLOUD, "..");
const WRANGLER = path.join(ROOT, "node_modules/.bin/wrangler");
const TEAM = "dashboard-test.cloudflareaccess.com";
const AUD = "dashboard-test-aud";
export const ADMIN = "owner@example.com";
export const DEV_USER = "dev@example.com";
const SEED_SERVICE = "seed.dashboard-test";
const quiet = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" };

export async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(url, output, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${url} did not come up:\n${output()}`);
}

function startWrangler(args, env) {
  const child = spawn(WRANGLER, args, { cwd: CLOUD, env, stdio: ["ignore", "pipe", "pipe"], detached: false });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  return { child, output: () => output.slice(-4000) };
}

function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

/**
 * Starts the stack. Returns `{web, core, jwtFor(email), api(path, {method, body}),
 * sql(text), cron(), close()}`; `api` is an admin service token (no CSRF needed).
 */
export async function startDevStack() {
  const state = await mkdtemp(path.join(os.tmpdir(), "hc-dashboard-"));
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "dash-1", alg: "RS256", use: "sig" }] };
  const certs = createServer((request, response) => {
    response.writeHead(request.url === "/cdn-cgi/access/certs" ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(jwks));
  });
  await new Promise((resolve) => certs.listen(0, "127.0.0.1", resolve));

  const sign = (claims) => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "dash-1", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ aud: [AUD], iss: `https://${TEAM}`, iat: now, exp: now + 6 * 3600, type: "app", ...claims })).toString("base64url");
    const signature = createSign("RSA-SHA256").update(`${header}.${body}`).sign(privateKey).toString("base64url");
    return `${header}.${body}.${signature}`;
  };

  await execFile(WRANGLER, ["d1", "migrations", "apply", "home-compute", "--local", "-c", "wrangler.web.jsonc", "--persist-to", state], { cwd: CLOUD, env: quiet });
  const [webPort, corePort, webInspector, coreInspector] = [await freePort(), await freePort(), await freePort(), await freePort()];
  const web = `http://127.0.0.1:${webPort}`;
  const core = `http://127.0.0.1:${corePort}`;
  const vars = {
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ACCESS_CERTS_URL: `http://127.0.0.1:${certs.address().port}/cdn-cgi/access/certs`,
    BOOTSTRAP_ADMINS: `${ADMIN},${DEV_USER},service:${SEED_SERVICE}`,
    CSRF_KEY: "dashboard-test-csrf-key",
    DEV_ACCESS_EMAIL: DEV_USER,
    CORE_URL: core,
  };
  const webProcess = startWrangler(["dev", "-c", "wrangler.web.jsonc", "--persist-to", state, "--port", String(webPort), "--ip", "127.0.0.1",
    "--inspector-port", String(webInspector), "--log-level", "warn", ...Object.entries(vars).flatMap(([name, value]) => ["--var", `${name}:${value}`])], quiet);
  let coreProcess = null;
  // hc-core's config names the deployed registry.cloudflare.com image, and wrangler dev signs in to
  // Cloudflare to resolve one even with containers off. A copy beside it (so its relative paths hold)
  // names the placeholder Dockerfile instead, which needs no sign-in and is never built here.
  const coreConfig = path.join(CLOUD, `wrangler.core.test-${process.pid}-${corePort}.jsonc`);
  await writeFile(coreConfig, (await readFile(path.join(CLOUD, "wrangler.core.jsonc"), "utf8"))
    .replace(/("image":\s*)"registry\.cloudflare\.com\/[^"]*"/g, '$1"./containers/placeholder.Dockerfile"'));
  const close = async () => {
    await Promise.all([stop(webProcess.child), coreProcess ? stop(coreProcess.child) : null]);
    await new Promise((resolve) => certs.close(resolve));
    await rm(state, { recursive: true, force: true });
    await rm(coreConfig, { force: true });
  };
  try {
    await waitFor(`${web}/v1/health`, webProcess.output);
    // One at a time: two workerd processes opening the shared local D1 at once can fail to start with SQLITE_BUSY.
    coreProcess = startWrangler(["dev", "-c", coreConfig, "--persist-to", state, "--port", String(corePort), "--ip", "127.0.0.1",
      // No Docker needed: the Cloudflare container classes are not started under wrangler dev.
      "--inspector-port", String(coreInspector), "--log-level", "warn", "--test-scheduled", "--enable-containers=false"], quiet);
    await waitFor(`${core}/health`, coreProcess.output);
  } catch (error) {
    await close();
    throw error;
  }

  const seedToken = sign({ common_name: SEED_SERVICE, sub: "" });
  return {
    web, core, state, close,
    jwtFor: (email) => sign({ email, sub: `sub-${email}` }),
    seedToken,

    /** hc-web's API as the seeding service token (an admin; service tokens need no CSRF token). */
    async api(target, { method = "GET", body } = {}) {
      const response = await fetch(`${web}${target}`, {
        method,
        headers: { "cf-access-jwt-assertion": seedToken, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      if (!response.ok) throw new Error(`${method} ${target}: ${response.status} ${text}`);
      return data;
    },

    /** SQL against the shared local D1 (what hc-web and hc-core read). */
    async sql(text) {
      const file = path.join(state, `seed-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`);
      await writeFile(file, text);
      const { stdout } = await execFile(WRANGLER, ["d1", "execute", "home-compute", "--local", "-c", "wrangler.web.jsonc", "--persist-to", state,
        "--file", file, "--json"], { cwd: CLOUD, env: quiet, maxBuffer: 16 * 1024 * 1024 });
      return JSON.parse(stdout);
    },

    /** One cron minute on hc-core. */
    async cron() {
      const response = await fetch(`${core}/__scheduled?cron=*+*+*+*+*`);
      return response.status;
    },
  };
}

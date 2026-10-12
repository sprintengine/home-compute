// `home-compute cloud …`: the CLI side of the hosted control plane. It talks
// to hc-web's API like any other non-browser client, with an Access service
// token (CF-Access-Client-Id/Secret) from the environment.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { readEnvFile, validateConfig } from "./config.mjs";

const PRESETS = path.resolve(import.meta.dirname, "../presets");
const TEMPLATE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

export const CLOUD_HELP = `Usage:
  home-compute cloud import FILE [--preset NAME|FILE] [--image REF] [--var NAME=VALUE]
                                 [--dry-run] [--force] [--paused] [--json]
                                 [--env-file FILE --upload-secrets [--labels k=v,…]]
  home-compute cloud secrets list [--json]
  home-compute cloud secrets put NAME [--labels k=v,…]        (the value is read from stdin)
  home-compute cloud secrets put-env FILE --preset NAME|FILE [--labels k=v,…]
  home-compute cloud secrets delete NAME
  home-compute cloud alert-test

Imports a v1 home-compute.json job set into the hosted control plane and
prints a per-job diff. --dry-run writes nothing. A field edited in the
dashboard since the last import is kept unless --force. --paused imports new
jobs paused. --image fills the \${…} variable in the file's images (Wingfoil's
\${WINGFOIL_IMAGE}); --var sets any such variable. With --upload-secrets the
preset's secrets are read from --env-file and put in the vault (as
"secrets put-env" does).

Secrets go to hc-web, which seals them with the vault's public key; nothing
can read them back. Values are never taken from the command line: "put"
reads stdin, "put-env" reads the preset's names from an env file. Only the
names are printed. --labels limits which machines may receive the secrets.
"alert-test" asks the control plane to send a test alert email.

Environment:
  HC_URL                     hc-web's base URL, such as https://hc-web.example.workers.dev
  HC_ACCESS_CLIENT_ID        an Access service token with the admin role
  HC_ACCESS_CLIENT_SECRET
  HC_ACCESS_JWT              instead, an Access JWT (cloudflared access token; local tests)
`;

function parseCloudArgs(argv) {
  const options = { positionals: [], variables: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      if (!argv[index + 1]) throw new Error(`${arg} needs a value`);
      return argv[++index];
    };
    if (arg === "--preset") options.preset = value();
    else if (arg === "--image") options.image = value();
    else if (arg === "--var") {
      const [name, ...rest] = value().split("=");
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || !rest.length) throw new Error("--var needs NAME=VALUE");
      options.variables[name] = rest.join("=");
    } else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--paused") options.paused = true;
    else if (arg === "--env-file") options.envFile = value();
    else if (arg === "--upload-secrets") options.uploadSecrets = true;
    else if (arg === "--labels") options.labels = parseLabelList(value());
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}`);
    else options.positionals.push(arg);
  }
  return options;
}

function parseLabelList(text) {
  const labels = {};
  for (const pair of String(text).split(",").map((item) => item.trim()).filter(Boolean)) {
    const match = pair.match(/^([^=\s]+)=(\S+)$/);
    if (!match) throw new Error(`--labels needs key=value pairs, not ${JSON.stringify(pair)}`);
    labels[match[1]] = match[2];
  }
  return labels;
}

async function readPreset(preset) {
  if (!preset) return undefined;
  const file = /[/\\]|\.json$/.test(preset) ? path.resolve(preset) : path.join(PRESETS, `${preset}.json`);
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read preset ${preset} (${file}): ${error.message}`);
  }
}

/** The headers that get a non-browser client through Access. */
export function accessHeaders(environment) {
  const headers = {};
  if (environment.HC_ACCESS_CLIENT_ID || environment.HC_ACCESS_CLIENT_SECRET) {
    if (!environment.HC_ACCESS_CLIENT_ID || !environment.HC_ACCESS_CLIENT_SECRET) {
      throw new Error("Set both HC_ACCESS_CLIENT_ID and HC_ACCESS_CLIENT_SECRET");
    }
    headers["cf-access-client-id"] = environment.HC_ACCESS_CLIENT_ID;
    headers["cf-access-client-secret"] = environment.HC_ACCESS_CLIENT_SECRET;
  }
  if (environment.HC_ACCESS_JWT) headers["cf-access-jwt-assertion"] = environment.HC_ACCESS_JWT;
  return headers;
}

function compact(value, limit = 100) {
  const text = JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function scheduleText(schedule) {
  if (!schedule) return "manual only";
  if (schedule.every) return `every ${schedule.every}`;
  const minutes = schedule.at.minutes.map((minute) => String(minute).padStart(2, "0"));
  if (!schedule.at.hours) return `hourly at :${minutes.join(", :")}`;
  return `at ${schedule.at.hours.flatMap((hour) => minutes.map((minute) => `${String(hour).padStart(2, "0")}:${minute}`)).join(", ")} UTC`;
}

/** The import's answer as a readable per-job diff. */
export function formatImport(result, { url } = {}) {
  const lines = [`Import${result.preset ? ` with preset ${result.preset}` : ""} into ${url ?? "the control plane"}${result.dryRun ? " (dry run: nothing written)" : ""}`];
  const width = Math.max(...result.jobs.map((job) => job.id.length));
  for (const job of result.jobs) {
    const name = job.id.padEnd(width);
    const after = Object.fromEntries(job.changes.map((change) => [change.field, change.after]));
    if (job.action === "create") {
      const resources = after.resources;
      lines.push(`+ ${name}  create  ${after.enabled ? "" : "(disabled) "}${scheduleText(after.schedule)} · ${resources.cpus} CPU ${resources.memoryMiB} MiB · ${after.timeouts.runSeconds} s`);
    } else if (job.action === "unchanged") {
      lines.push(`= ${name}  unchanged`);
    } else {
      lines.push(`${job.action === "update" ? "~" : "!"} ${name}  ${job.action}${job.changes.length ? `: ${job.changes.map((change) => change.field).join(", ")}` : ""}`);
      for (const change of job.changes) lines.push(`      ${change.field}: ${compact(change.before)} → ${compact(change.after)}`);
    }
    for (const kept of job.kept ?? []) {
      lines.push(`      kept ${kept.field} (edited since the last import): ${compact(kept.before)}; the file says ${compact(kept.after)}. --force overwrites it`);
    }
    for (const warning of job.warnings ?? []) lines.push(`      note: ${warning}`);
  }
  if (result.notInFile.length) lines.push(`Not in the file, left as they are: ${result.notInFile.join(", ")}`);
  const { create, update, kept, unchanged } = result.summary;
  lines.push(`${create} to create, ${update} to update, ${kept} with kept edits, ${unchanged} unchanged.${result.dryRun && (create || update) ? " Rerun without --dry-run to apply." : ""}`);
  return `${lines.join("\n")}\n`;
}

async function importCommand(options, { environment, fetcher, stdout }) {
  const [file] = options.positionals;
  if (!file || options.positionals.length > 1) throw new Error(`cloud import needs one FILE\n\n${CLOUD_HELP}`);
  const base = String(environment.HC_URL ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) throw new Error("Set HC_URL to hc-web's base URL (https://…)");
  const config = JSON.parse(await readFile(file, "utf8"));
  validateConfig(config, file);
  const variables = { ...options.variables };
  if (options.image) {
    for (const job of config.jobs) for (const [, name] of String(job.task.image).matchAll(TEMPLATE)) variables[name] ??= options.image;
  }
  const body = {
    config: { jobs: config.jobs },
    ...(options.preset ? { preset: await readPreset(options.preset) } : {}),
    variables,
    ...(options.force ? { force: true } : {}),
    ...(options.paused ? { pause: true } : {}),
  };
  const url = `${base}/v1/import${options.dryRun ? "?dryRun=1" : ""}`;
  const response = await fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...accessHeaders(environment) },
    body: JSON.stringify(body),
    redirect: "manual",
  });
  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    // Access answers an unauthenticated request with a redirect to its login page.
    throw new Error(`${url}: HTTP ${response.status}${response.status >= 300 && response.status < 400 ? " (Access sign-in: check the service token)" : ""}`);
  }
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}: ${result.error ?? text}`);
  stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : formatImport(result, { url: base }));
  return result;
}

function baseUrl(environment) {
  const base = String(environment.HC_URL ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) throw new Error("Set HC_URL to hc-web's base URL (https://…)");
  return base;
}

/** One JSON request to hc-web, through Access; an error says the status and hc-web's message, never a body sent. */
async function request(environment, fetcher, method, path, body) {
  const url = `${baseUrl(environment)}${path}`;
  const response = await fetcher(url, {
    method,
    headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...accessHeaders(environment) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "manual",
  });
  const text = await response.text();
  let result = null;
  try { result = text ? JSON.parse(text) : null; } catch { /* below */ }
  if (!response.ok) {
    const access = response.status >= 300 && response.status < 400 ? " (Access sign-in: check the service token)" : "";
    throw new Error(`${method} ${path}: HTTP ${response.status}${access}${result?.error ? `: ${result.error}` : ""}`);
  }
  return result;
}

/** The preset's secrets (`ENV → secret name`) whose values the env file has, and the names it lacks. */
export function secretsFromEnv(preset, values) {
  const found = [];
  const missing = [];
  for (const [envName, secretName] of Object.entries(preset?.secrets ?? {})) {
    if (typeof values[envName] === "string" && values[envName] !== "") found.push({ envName, secretName, value: values[envName] });
    else missing.push(envName);
  }
  return { found, missing };
}

async function uploadFromEnv(file, presetName, labels, { environment, fetcher, stdout }) {
  const preset = await readPreset(presetName);
  if (!preset?.secrets || !Object.keys(preset.secrets).length) throw new Error("The preset names no secrets");
  const { found, missing } = secretsFromEnv(preset, await readEnvFile(file));
  if (missing.length) throw new Error(`${file} has no value for ${missing.join(", ")}; nothing was uploaded`);
  for (const { envName, secretName, value } of found) {
    const result = await request(environment, fetcher, "PUT", `/v1/secrets/${encodeURIComponent(secretName)}`,
      { value, ...(labels ? { allowedLabels: labels } : {}) });
    const allowed = Object.entries(result?.allowedLabels ?? {}).map(([key, item]) => `${key}=${item}`).join(", ");
    stdout.write(`set ${secretName} (from ${envName})${result?.hint ? ` ${result.hint}` : ""}${allowed ? `, for machines with ${allowed}` : ""}\n`);
  }
  return found.map(({ secretName }) => secretName);
}

async function readValue(stdin) {
  let text = "";
  for await (const chunk of stdin) text += chunk;
  return text.replace(/\r?\n$/, "");
}

async function secretsCommand(options, { environment, fetcher, stdout, stdin }) {
  const [action, name, ...extra] = options.positionals;
  if (action === "list" && !name) {
    const result = await request(environment, fetcher, "GET", "/v1/secrets");
    if (options.json) {
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result;
    }
    stdout.write(`Vault: ${result.vault.configured ? `key ${result.vault.keyId}` : `not configured${result.vault.error ? ` (${result.vault.error})` : ""}`}\n`);
    for (const secret of result.secrets) {
      const labels = Object.entries(secret.allowedLabels).map(([key, value]) => `${key}=${value}`).join(",");
      stdout.write(`  ${secret.name}${secret.hint ? ` ${secret.hint}` : ""}${labels ? ` [${labels}]` : ""}${secret.staleKey ? " (sealed under an older key)" : ""} · used by ${secret.usedBy.join(", ") || "no job"} · ${secret.updatedAt} by ${secret.updatedBy}\n`);
    }
    for (const secret of result.missing) stdout.write(`  ${secret.name} NOT SET · needed by ${secret.usedBy.join(", ")}\n`);
    return result;
  }
  if (action === "put" && name && !extra.length) {
    if (!stdin || stdin.isTTY) throw new Error("secrets put reads the value from stdin: printf '%s' \"$VALUE\" | home-compute cloud secrets put NAME");
    const value = await readValue(stdin);
    if (!value) throw new Error("No value on stdin");
    const result = await request(environment, fetcher, "PUT", `/v1/secrets/${encodeURIComponent(name)}`,
      { value, ...(options.labels ? { allowedLabels: options.labels } : {}) });
    stdout.write(`set ${result.name}${result.hint ? ` ${result.hint}` : ""} (vault key ${result.keyId})\n`);
    return result;
  }
  if (action === "put-env" && name && !extra.length) {
    if (!options.preset) throw new Error("secrets put-env needs --preset (which env names map to which secrets)");
    return uploadFromEnv(name, options.preset, options.labels, { environment, fetcher, stdout });
  }
  if (action === "delete" && name && !extra.length) {
    const result = await request(environment, fetcher, "DELETE", `/v1/secrets/${encodeURIComponent(name)}`);
    stdout.write(`deleted ${result.name}\n`);
    return result;
  }
  throw new Error(`Unknown secrets command\n\n${CLOUD_HELP}`);
}

/** `home-compute cloud SUBCOMMAND …`. */
export async function cloudCommand(argv, { environment = process.env, fetcher = fetch, stdout = process.stdout, stdin = process.stdin } = {}) {
  const [subcommand, ...rest] = argv;
  const options = parseCloudArgs(rest);
  if (!subcommand || options.help || subcommand === "help") {
    stdout.write(CLOUD_HELP);
    return undefined;
  }
  if (subcommand === "import") {
    if (options.uploadSecrets && (!options.envFile || !options.preset)) throw new Error("--upload-secrets needs --env-file and --preset");
    const result = await importCommand(options, { environment, fetcher, stdout });
    if (options.uploadSecrets && !options.dryRun) await uploadFromEnv(options.envFile, options.preset, options.labels, { environment, fetcher, stdout });
    return result;
  }
  if (subcommand === "secrets") return secretsCommand(options, { environment, fetcher, stdout, stdin });
  if (subcommand === "alert-test") {
    const result = await request(environment, fetcher, "POST", "/v1/alerts/test", {});
    stdout.write(`${result.detail} (${result.id})\n`);
    return result;
  }
  throw new Error(`Unknown cloud command ${subcommand}\n\n${CLOUD_HELP}`);
}

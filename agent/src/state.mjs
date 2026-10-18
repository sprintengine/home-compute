// The agent's state directory (§4.7, §5): its configuration, its credential,
// the local secrets file for `local:` references, the status token, the
// outbox of unsent results and the records of runs in flight. The directory
// is 0700 and every file in it 0600, written atomically (a temporary file,
// then a rename), so a crash never leaves half a credential behind.

import { randomBytes } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_STATUS_PORT = 4787;
const LOG_KEEP_MS = 7 * 86_400_000;
export const RUNTIMES = ["fake", "docker", "colima", "process"];
const SANDBOXES = ["auto", "bwrap", "userns", "proot", "plain"];

/** What a configuration holds, with its defaults (README.md lists each field). */
export const DEFAULT_CONFIG = {
  server: null,
  machineId: null,
  name: null,
  runtime: "fake",
  caps: {},
  allowImages: [],
  allowLocalImages: false,
  envFile: null,
  statusPort: DEFAULT_STATUS_PORT,
  dashboardUrl: null,
  logFile: null,
  stopGraceSeconds: 30,
  statsIntervalSeconds: 3,
  pullTimeoutSeconds: 1200,
  docker: {},
  colima: {},
  process: {},
  caffeinate: "auto",
  fake: {},
};

const COLIMA_NUMBERS = ["diskGiB", "minCpus", "minMemoryMiB", "startTimeoutSeconds"];
const COLIMA_SECONDS = ["idleStopSeconds", "keepWarmSeconds"];

function writable(directory) {
  try {
    accessSync(directory, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where the agent keeps its state unless told (`--state-dir`,
 * `HC_AGENT_STATE_DIR`): `~/Library/Application Support/home-compute` on a
 * Mac; `/etc/home-compute` on Linux for root or when that directory exists
 * and is writable (the systemd install), else `~/.local/state/home-compute`;
 * `~/.home-compute` elsewhere.
 */
export function defaultStateDir({
  platform = process.platform, env = process.env, home = os.homedir(), uid = process.getuid?.(), canWrite = writable,
} = {}) {
  if (env.HC_AGENT_STATE_DIR) return path.resolve(env.HC_AGENT_STATE_DIR);
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "home-compute");
  if (platform === "linux") {
    if (uid === 0 || canWrite("/etc/home-compute")) return "/etc/home-compute";
    return path.join(env.XDG_STATE_HOME || path.join(home, ".local", "state"), "home-compute");
  }
  return path.join(home, ".home-compute");
}

/** `NAME=value` lines (`export`, quotes and `#` comments allowed): the local secrets `local:<NAME>` refers to. */
export function parseEnvFile(text) {
  const values = new Map();
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2];
    const quoted = value.match(/^"(.*)"$/) ?? value.match(/^'(.*)'$/);
    if (quoted) value = quoted[1];
    values.set(match[1], value);
  }
  return values;
}

function checkConfig(config) {
  if (!RUNTIMES.includes(config.runtime)) throw new Error(`runtime must be one of ${RUNTIMES.join(", ")}`);
  if (!Array.isArray(config.allowImages) || config.allowImages.some((pattern) => typeof pattern !== "string")) {
    throw new Error("allowImages must be a list of image patterns");
  }
  for (const key of ["stopGraceSeconds", "statsIntervalSeconds", "pullTimeoutSeconds"]) {
    if (typeof config[key] !== "number" || !(config[key] > 0)) throw new Error(`${key} must be a positive number`);
  }
  if (!Number.isInteger(config.statusPort) || config.statusPort < 0 || config.statusPort > 65_535) {
    throw new Error("statusPort must be a port number (0 to turn the status server off)");
  }
  if (config.dashboardUrl !== null && config.dashboardUrl !== undefined && !/^https?:\/\/[^\s]+$/i.test(String(config.dashboardUrl))) {
    throw new Error("dashboardUrl must be an http(s) URL (the dashboard, hc-web) or null");
  }
  if (config.logFile !== null && config.logFile !== undefined && (typeof config.logFile !== "string" || !config.logFile)) {
    throw new Error("logFile must be a path or null");
  }
  for (const section of ["docker", "colima", "caps", "process"]) {
    if (config[section] === null || typeof config[section] !== "object" || Array.isArray(config[section])) throw new Error(`${section} must be an object`);
  }
  if (config.process.sandbox !== undefined && !SANDBOXES.includes(config.process.sandbox)) {
    throw new Error(`process.sandbox must be one of ${SANDBOXES.join(", ")}`);
  }
  for (const key of COLIMA_NUMBERS) {
    const value = config.colima[key];
    if (value !== undefined && value !== null && !(typeof value === "number" && value > 0)) throw new Error(`colima.${key} must be a positive number`);
  }
  for (const key of COLIMA_SECONDS) {
    const value = config.colima[key];
    if (value !== undefined && value !== null && !(typeof value === "number" && value >= 0)) throw new Error(`colima.${key} must be a number of seconds (0 or more)`);
  }
  if (config.colima.profile !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(config.colima.profile))) {
    throw new Error("colima.profile must be a profile name");
  }
  if (config.colima.profile === "default") throw new Error("colima.profile must not be \"default\": the agent uses a profile of its own");
  if (![true, false, "auto"].includes(config.caffeinate)) throw new Error("caffeinate must be true, false or \"auto\"");
  return config;
}

export class StateDir {
  constructor(dir) {
    this.dir = path.resolve(dir);
    this.configPath = path.join(this.dir, "config.json");
    this.credentialPath = path.join(this.dir, "credential");
    this.defaultEnvPath = path.join(this.dir, "env");
    this.statusTokenPath = path.join(this.dir, "status-token");
    this.localStatePath = path.join(this.dir, "state.json");
    this.historyPath = path.join(this.dir, "history.jsonl");
    this.outboxDir = path.join(this.dir, "outbox");
    this.runsDir = path.join(this.dir, "runs");
  }

  async ensure() {
    for (const directory of [this.dir, this.outboxDir, this.runsDir]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }
  }

  /**
   * Writes `text` to `file` as 0600, atomically and durably: the data is
   * flushed before the rename and the directory after it, so a power cut
   * leaves either the old file or the new one, never an empty one.
   */
  async writeSecure(file, text) {
    const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.writeFile(text);
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    const directory = await open(path.dirname(file), "r").catch(() => null);
    if (directory) {
      await directory.sync().catch(() => {});
      await directory.close();
    }
  }

  async readText(file) {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async readJson(file) {
    const text = await this.readText(file);
    return text === null ? null : JSON.parse(text);
  }

  async loadConfig() {
    const stored = await this.readJson(this.configPath);
    if (!stored) return null;
    return checkConfig({ ...DEFAULT_CONFIG, ...stored });
  }

  async saveConfig(config) {
    await this.ensure();
    await this.writeSecure(this.configPath, `${JSON.stringify(checkConfig({ ...DEFAULT_CONFIG, ...config }), null, 2)}\n`);
  }

  async readCredential() {
    return (await this.readText(this.credentialPath))?.trim() || null;
  }

  async writeCredential(credential) {
    await this.ensure();
    await this.writeSecure(this.credentialPath, `${credential}\n`);
  }

  envPath(config) {
    return config?.envFile ? path.resolve(this.dir, config.envFile) : this.defaultEnvPath;
  }

  async readEnv(config) {
    return parseEnvFile(await this.readText(this.envPath(config)));
  }

  /** The bearer token of the local status server, made once. */
  async statusToken() {
    const existing = (await this.readText(this.statusTokenPath))?.trim();
    if (existing) return existing;
    await this.ensure();
    const token = randomBytes(32).toString("hex");
    await this.writeSecure(this.statusTokenPath, `${token}\n`);
    return token;
  }

  async readLocalState() {
    return (await this.readJson(this.localStatePath)) ?? {};
  }

  async writeLocalState(state) {
    await this.ensure();
    await this.writeSecure(this.localStatePath, `${JSON.stringify(state)}\n`);
  }

  /** Files (and the directory) others could read: anything with group or world bits set. */
  async permissionProblems() {
    const problems = [];
    const check = async (file, expected) => {
      try {
        const mode = (await stat(file)).mode & 0o777;
        if (mode & 0o077) problems.push({ file, mode: mode.toString(8), expected: expected.toString(8) });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    };
    await check(this.dir, 0o700);
    for (const file of [this.configPath, this.credentialPath, this.statusTokenPath, this.defaultEnvPath, this.localStatePath, this.historyPath, `${this.historyPath}.1`]) {
      await check(file, 0o600);
    }
    return problems;
  }

  // ---------- Runs in flight: what adopting a container after a restart needs (never a secret value)

  runRecordPath(runId) {
    return path.join(this.runsDir, `${runId}.json`);
  }

  logPath(runId) {
    return path.join(this.runsDir, `${runId}.log.gz`);
  }

  async writeRunRecord(runId, record) {
    await this.writeSecure(this.runRecordPath(runId), `${JSON.stringify(record)}\n`);
  }

  async readRunRecords() {
    const records = new Map();
    let names = [];
    try {
      names = await readdir(this.runsDir);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      try {
        const record = JSON.parse(await readFile(path.join(this.runsDir, name), "utf8"));
        records.set(name.slice(0, -5), record);
      } catch {
        // A record that cannot be read is treated as missing; the container, if any, is still adopted.
      }
    }
    return records;
  }

  async removeRunRecord(runId) {
    await rm(this.runRecordPath(runId), { force: true });
  }

  /** Deletes local run logs older than 7 days (§4.6). */
  async pruneLogs(now = Date.now()) {
    let names = [];
    try {
      names = await readdir(this.runsDir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names.filter((entry) => entry.endsWith(".log.gz"))) {
      const file = path.join(this.runsDir, name);
      const { mtimeMs } = await stat(file);
      if (now - mtimeMs > LOG_KEEP_MS) {
        await rm(file, { force: true });
        removed += 1;
      }
    }
    return removed;
  }
}

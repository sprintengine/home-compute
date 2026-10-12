// Running the `docker` and `colima` command lines: argv only (no shell), an
// environment the caller chooses (secret values reach `docker run` this way,
// never in argv), stdin for a password, and a timeout that kills.

import { spawn } from "node:child_process";

export class CommandError extends Error {
  constructor(message, { code = null, signal = null, stdout = "", stderr = "", timedOut = false } = {}) {
    super(message);
    this.name = "CommandError";
    Object.assign(this, { code, signal, stdout, stderr, timedOut });
  }
}

/** The last meaningful line of a command's error output: what a person needs to see. */
export function lastLine(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const line = lines.at(-1) ?? "";
  // colima/logrus: `time="…" level=fatal msg="error starting vm: …"`.
  const message = line.match(/\bmsg="((?:[^"\\]|\\.)*)"/);
  return (message ? message[1].replace(/\\"/g, "\"") : line).slice(0, 300);
}

/**
 * Runs `file` with `args` and resolves `{stdout, stderr, code}`. Rejects with a
 * CommandError when it exits non-zero (unless `allowFailure`), cannot start,
 * or outlives `timeoutMs` (it is killed: SIGTERM, then SIGKILL 5 s later).
 */
export function runCommand(file, args, { env = process.env, input = null, timeoutMs = 120_000, allowFailure = false, spawnFn = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(file, args, { env, stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"] });
    } catch (error) {
      reject(new CommandError(`${file} could not start: ${error.message}`, { code: error.code }));
      return;
    }
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let killer = null;
    // Only a child that started (has a pid) is ever signalled: a kill without one may reach the whole process group.
    const kill = (signal) => {
      if (child.pid > 0 && child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    const timer = timeoutMs ? setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      killer = setTimeout(() => kill("SIGKILL"), 5_000);
    }, timeoutMs) : null;
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(killer);
      reject(new CommandError(error.code === "ENOENT" ? `${file} is not installed (not found on PATH)` : `${file} could not start: ${error.message}`, { code: error.code }));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killer);
      const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), code, signal };
      if (timedOut) {
        reject(new CommandError(`${file} ${args[0] ?? ""} took longer than ${Math.round(timeoutMs / 1000)} s and was stopped`, { ...result, timedOut: true }));
      } else if (code !== 0 && !allowFailure) {
        const why = lastLine(result.stderr) || lastLine(result.stdout) || (signal ? `killed by ${signal}` : `exit ${code}`);
        reject(new CommandError(`${file} ${args[0] ?? ""} failed: ${why}`, result));
      } else {
        resolve(result);
      }
    });
    if (input !== null) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

/** Environment variables a `docker` or `colima` process may inherit from the agent's own. */
const INHERITED = [
  "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "COLIMA_HOME", "LIMA_HOME",
  "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY", "SSL_CERT_FILE", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
  "https_proxy", "http_proxy", "no_proxy",
];

/** A command's environment: only the inherited names above from `source`, then `extra`. */
export function commandEnv(source = process.env, extra = {}) {
  const env = {};
  for (const name of INHERITED) if (typeof source[name] === "string") env[name] = source[name];
  return { ...env, ...extra };
}

/** Names a container secret may not have: the `docker` process reads them itself, so a value there would change how it runs. */
export function reservedSecretName(name) {
  return INHERITED.includes(name) || /^DOCKER_/.test(name) || name === "BUILDKIT_HOST";
}

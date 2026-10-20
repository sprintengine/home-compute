// Where this agent's own log goes, for the status server's "Open log":
// `config.logFile` (or HC_AGENT_LOG_FILE) when set; else, when stdout is a
// file, that file (Linux reads /proc/self/fd/1; a Mac compares stdout with
// the LaunchAgent's agent.log); else a hint such as journalctl when stdout
// is the journal. Worked out once per process.

import { fstatSync, readlinkSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let cached = null;

/** The LaunchAgent template's StandardOutPath. */
export const MAC_LOG_FILE = path.join(os.homedir(), "Library", "Logs", "home-compute", "agent.log");

export function findLogLocation({ config = {}, env = process.env, platform = process.platform, stdoutFd = 1 } = {}) {
  const configured = config.logFile ?? env.HC_AGENT_LOG_FILE;
  if (typeof configured === "string" && configured) return { logFile: path.resolve(configured), logHint: null };
  let stdout = null;
  try {
    stdout = fstatSync(stdoutFd);
  } catch {
    stdout = null;
  }
  if (stdout?.isFile()) {
    if (platform === "linux") {
      try {
        const target = readlinkSync(`/proc/self/fd/${stdoutFd}`);
        if (target.startsWith("/")) return { logFile: target.replace(/ \(deleted\)$/, ""), logHint: null };
      } catch {
        // No /proc: fall through.
      }
    }
    if (platform === "darwin") {
      try {
        const candidate = statSync(MAC_LOG_FILE);
        if (candidate.ino === stdout.ino && candidate.dev === stdout.dev) return { logFile: MAC_LOG_FILE, logHint: null };
      } catch {
        // Not the LaunchAgent's file.
      }
    }
  }
  if (platform === "linux" && env.JOURNAL_STREAM) return { logFile: null, logHint: "journalctl -u home-compute-agent -f" };
  return { logFile: null, logHint: null };
}

/** `{logFile, logHint}` for this process, worked out on first use. */
export function logLocation(config) {
  cached ??= findLogLocation({ config });
  return cached;
}

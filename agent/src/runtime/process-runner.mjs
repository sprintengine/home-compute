// The parent of one process-runtime job. The agent spawns it detached, hands
// it the job's environment on stdin (so secret values are never in argv or
// in a file) and then only watches files: the log, the pid and the exit
// record. If the agent is restarted, this process is still the parent, so
// the exit code is not lost the way a reparented child would lose it.

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { readFileSync } from "node:fs";
import { descendants, readProcStat, sampleTree, signalGroup } from "./sandbox.mjs";

const HELPERS = new Set(["bwrap", "proot", "unshare"]);
const WATCH_MS = 200;

function comm(pid) {
  try { return readFileSync(`/proc/${pid}/comm`, "utf8").trim(); } catch { return ""; }
}

function childPids(pid) {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return descendants(pid).filter((id) => readProcStat(id)?.ppid === pid);
  }
}

/** The command inside a sandbox helper (bwrap's inner process is another bwrap; its child is the job). */
async function resolveJobPid(sandboxPid) {
  if (!HELPERS.has(comm(sandboxPid))) return sandboxPid;
  let current = sandboxPid;
  for (let depth = 0; depth < 5; depth += 1) {
    const children = childPids(current);
    const job = children.find((pid) => !HELPERS.has(comm(pid)));
    if (job) return job;
    if (children.length) {
      current = children[0];
      continue;
    }
    if (!readProcStat(sandboxPid)) return current;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return current;
}

async function readStdinEnv() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const env = {};
  for (const entry of Buffer.concat(chunks).toString("utf8").split("\0")) {
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

/**
 * The first JSON object on bubblewrap's status fd. The listener is attached
 * synchronously: a short command can write the object and exit before the
 * next await. The stream stays open afterwards. Closing it early delivers
 * SIGPIPE to bubblewrap and kills the job.
 */
function readStatus(stream) {
  if (!stream) return Promise.resolve(null);
  return new Promise((resolve) => {
    let text = "";
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.off("data", onData);
      resolve(value);
    };
    const onData = (chunk) => {
      text += chunk;
      const end = text.indexOf("}");
      if (end < 0) return;
      try { finish(JSON.parse(text.slice(0, end + 1))); } catch { finish(null); }
    };
    const timer = setTimeout(() => finish(null), 5_000);
    stream.on("data", onData);
    stream.on("error", () => finish(null));
    stream.on("end", () => {
      const end = text.indexOf("}");
      if (end < 0) finish(null);
    });
  });
}

/** Resolves when a piped child stream has delivered its last byte, or after a short wait. */
function streamEnded(stream) {
  if (!stream || stream.readableEnded || stream.closed) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      stream.destroy();
      done();
    }, 1_000);
    stream.once("end", done);
    stream.once("close", done);
  });
}

async function applyCgroup(dir, pid, limits) {
  if (!dir) return false;
  try {
    if (limits.memoryBytes) await writeFile(path.join(dir, "memory.max"), String(limits.memoryBytes));
    if (limits.cpus) await writeFile(path.join(dir, "cpu.max"), `${Math.max(1000, Math.round(Number(limits.cpus) * 100_000))} 100000`);
    if (limits.pids) await writeFile(path.join(dir, "pids.max"), String(limits.pids));
    await writeFile(path.join(dir, "cgroup.procs"), `${pid}\n`);
    return true;
  } catch {
    return false;
  }
}

function cgroupOom(dir) {
  if (!dir) return false;
  try {
    const text = readFileSync(path.join(dir, "memory.events"), "utf8");
    const found = text.match(/oom_kill\s+(\d+)/);
    return Boolean(found && Number(found[1]) > 0);
  } catch {
    return false;
  }
}

function exitCodeOf(code, signal) {
  if (typeof code === "number") return code;
  const numbers = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGPIPE: 13, SIGTERM: 15 };
  return 128 + (numbers[signal] ?? 0);
}

async function writeExit(file, result) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(result)}\n`);
  await rename(temporary, file);
}

export async function runProcessRunner() {
  const dir = process.argv[2] || process.env.HC_RUN_DIR;
  if (!dir) throw new Error("the process runner needs a run directory");
  const launch = JSON.parse(await readFile(path.join(dir, "launch.json"), "utf8"));
  const env = await readStdinEnv();
  const log = createWriteStream(launch.log, { flags: "a" });
  const note = createWriteStream(path.join(dir, "runner.log"), { flags: "a" });
  const stdio = ["ignore", "pipe", "pipe"];
  if (launch.statusFd) stdio.push("pipe");
  let child;
  try {
    child = spawn(launch.file, launch.args, { env, cwd: launch.cwd || dir, detached: true, stdio });
  } catch (error) {
    note.write(`${error.message}\n`);
    await writeExit(path.join(dir, "exit.json"), { exitCode: 127, oomKilled: false, error: error.message });
    return;
  }
  // Both streams share one file. Neither may end it: the exit record is written only after the last byte is on disk, so a tail that stops at the exit record still sees the whole log.
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  // Subscribe before any await. A fast command exits, and 'close' with it, during the first writeFile.
  let settled = false;
  let exitResult = null;
  const finished = new Promise((resolve) => {
    const done = (code, signal) => {
      if (settled) return;
      settled = true;
      exitResult = [code, signal];
      resolve(exitResult);
    };
    child.once("exit", done);
    child.once("error", (error) => {
      note.write(`${error.message}\n`);
      done(127, null);
    });
  });
  const statusPromise = launch.statusFd ? readStatus(child.stdio[3]) : Promise.resolve(null);
  await writeFile(path.join(dir, "sandbox.pid"), `${child.pid}\n`);
  const status = await statusPromise;
  const sandboxPid = status?.["child-pid"] && readProcStat(status["child-pid"]) ? status["child-pid"] : child.pid;
  const jobPid = await resolveJobPid(sandboxPid);
  await writeFile(launch.jobPid ?? path.join(dir, "job.pid"), `${jobPid}\n`);
  const limits = launch.limits ?? {};
  const cgroupOn = await applyCgroup(launch.cgroup, child.pid, limits);
  let oom = false;
  let pids = false;
  const watch = setInterval(() => {
    if (!cgroupOn && limits.memoryBytes) {
      const sample = sampleTree(jobPid);
      if (sample.memoryBytes > limits.memoryBytes) {
        oom = true;
        signalGroup(jobPid, "SIGKILL");
        signalGroup(child.pid, "SIGKILL");
      }
    }
    if (!cgroupOn && limits.pids && descendants(jobPid).length + 1 > limits.pids) {
      pids = true;
      signalGroup(jobPid, "SIGKILL");
    }
  }, WATCH_MS);
  const forward = (signal) => signalGroup(jobPid, signal);
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGTERM"));
  const [code, signal] = exitResult ?? await finished;
  clearInterval(watch);
  await Promise.all([streamEnded(child.stdout), streamEnded(child.stderr)]);
  child.stdio[3]?.destroy();
  log.end();
  await new Promise((resolve) => {
    if (log.writableFinished) return resolve();
    log.once("finish", resolve);
    log.once("error", resolve);
  });
  if (cgroupOn && cgroupOom(launch.cgroup)) oom = true;
  const exitCode = oom ? 137 : exitCodeOf(code, signal);
  note.write(`exit ${exitCode}${oom ? " oom" : ""}${pids ? " pids" : ""}\n`);
  note.end();
  await writeExit(path.join(dir, "exit.json"), { exitCode, oomKilled: oom, pids });
}

function invokedDirectly() {
  // The bundled agent is one file, so this must not be `import.meta.url`:
  // that would also be true for `home-compute-agent.mjs version`.
  return Boolean(process.argv[1]) && path.basename(process.argv[1]) === "process-runner.mjs";
}

if (invokedDirectly()) {
  try {
    await runProcessRunner();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

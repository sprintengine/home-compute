// ProcessRuntime: run a job's OCI image as a process, with no Docker daemon.
// The image is pulled with the registry HTTP API (oci.mjs), unpacked into a
// cache, and each run gets its own copy of that rootfs. bubblewrap, a user
// namespace or proot confines it when one of them works; otherwise the
// process runs on this machine and doctor warns. Secret values are written
// to the runner's stdin, never to argv or to the state directory.

import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { chmod, cp, mkdir, open, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JOB_LABEL, RUN_LABEL } from "../../../src/core/protocol.mjs";
import { systemClock } from "../clock.mjs";
import { isLocalImage } from "../policy.mjs";
import { freeDiskMiB } from "./docker-cli.mjs";
import { ImageRecord, parseImageRef } from "./images.mjs";
import { insideRoot, jobCommand, jobEnv, jobUser, jobWorkdir, normalizeImageRef, pullImage } from "./oci.mjs";
import { runCommand } from "./process.mjs";
import {
  NETWORK_WARNING, SANDBOX_ENV, detectSandbox, hostCapacity, probeCgroup, readEnviron, readProcStat,
  resolveIdentity, sampleTree, sandboxLaunch, signalGroup, splitLoaderEnv,
} from "./sandbox.mjs";

const RUNNER_SOURCE = fileURLToPath(new URL("./process-runner.mjs", import.meta.url));
const PIDS_LIMIT = 4096;
const DEFAULT_IMAGE = "docker.io/library/busybox:latest";

/** Why a spec cannot be started, or null. Secrets must not be able to retarget the sandbox helper. */
export function processRefusal(spec) {
  for (const name of [...Object.keys(spec?.env ?? {}), ...Object.keys(spec?.secretEnv ?? {})]) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return `env name ${name} is not an environment variable name`;
  }
  for (const name of Object.keys(spec?.secretEnv ?? {})) {
    if (SANDBOX_ENV.test(name)) return `secret name ${name} would change how the sandbox starts`;
  }
  if (!/^r_[A-Za-z0-9]+$/.test(String(spec?.runId ?? ""))) return "the run id is invalid";
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@+-]*$/.test(String(spec?.image ?? ""))) return "the image reference is invalid";
  const network = spec?.network ?? "bridge";
  if (network !== "bridge" && network !== "none") return `network ${network} is not allowed`;
  return null;
}

function digestParts(digest) {
  const match = String(digest ?? "").match(/^([a-z0-9]+):([a-f0-9]+)$/);
  if (!match) throw new Error(`not a digest: ${digest}`);
  return { algo: match[1], hex: match[2] };
}

async function copyTree(source, dest) {
  // `cp` into an existing directory nests the tree, so the destination itself must not exist yet.
  await mkdir(path.dirname(dest), { recursive: true });
  await rm(dest, { recursive: true, force: true });
  try {
    await runCommand("cp", ["-a", "--reflink=auto", source, dest], { timeoutMs: 30 * 60_000 });
  } catch {
    await cp(source, dest, { recursive: true, verbatimSymlinks: true });
  }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}

/** One line, with a progress-bar rewrite (`10%\r50%`) reduced to what a terminal would show. */
function cleanLine(raw) {
  let text = String(raw).replace(/\r+$/, "");
  const cr = text.lastIndexOf("\r");
  if (cr >= 0) text = text.slice(cr + 1);
  return text;
}

async function cgroupOomKilled(dir) {
  if (!dir) return false;
  const text = await readFile(path.join(dir, "memory.events"), "utf8").catch(() => "");
  return Number(text.match(/oom_kill\s+(\d+)/)?.[1] ?? 0) > 0;
}

/**
 * A cgroup is a directory only rmdir removes (its control files cannot be
 * unlinked), and only once its last process has gone, so a just-killed
 * runner gets a moment.
 */
export async function removeCgroup(dir, clock = systemClock) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rmdir(dir);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return true;
      if (error.code !== "EBUSY") return false;
      await clock.sleep(50);
    }
  }
  return false;
}

class ProcessJob {
  constructor(runtime, dir, meta) {
    this.runtime = runtime;
    this.dir = dir;
    this.meta = meta;
    this.id = meta.id ?? path.basename(dir);
    this.labels = meta.labels ?? {};
    this.detached = false;
    this.previous = null;
    this.waiting = null;
  }

  async #pid(name) {
    const text = await readFile(path.join(this.dir, name), "utf8").catch(() => "");
    const pid = Number(text.trim());
    return pid > 1 ? pid : null;
  }

  async *logs() {
    const file = path.join(this.dir, "log");
    let position = 0;
    let buffer = "";
    while (!this.detached) {
      const handle = await open(file, "r").catch(() => null);
      if (handle) {
        try {
          const stat = await handle.stat();
          if (stat.size > position) {
            const chunk = Buffer.alloc(stat.size - position);
            await handle.read(chunk, 0, chunk.length, position);
            position = stat.size;
            buffer += chunk.toString("utf8");
            let newline = buffer.indexOf("\n");
            while (newline >= 0) {
              yield cleanLine(buffer.slice(0, newline));
              buffer = buffer.slice(newline + 1);
              newline = buffer.indexOf("\n");
            }
          }
        } finally {
          await handle.close();
        }
      }
      if (await readJson(path.join(this.dir, "exit.json"))) {
        if (buffer) yield cleanLine(buffer);
        return;
      }
      await this.runtime.clock.sleep(50);
    }
  }

  async stats() {
    const pid = await this.#pid("job.pid");
    if (!pid || !readProcStat(pid)) throw new Error("the process is gone");
    const sample = sampleTree(pid, this.previous);
    this.previous = sample.raw;
    const memoryLimitBytes = this.meta.limits?.memoryBytes ?? null;
    return { memoryBytes: sample.memoryBytes, memoryLimitBytes, cpuPct: sample.cpuPct, cpuSeconds: sample.cpuSeconds };
  }

  wait() {
    if (!this.waiting) this.waiting = this.#wait();
    return this.waiting;
  }

  async #wait() {
    const exitPath = path.join(this.dir, "exit.json");
    for (;;) {
      if (this.detached) return { exitCode: null, oomKilled: false, detached: true };
      const exit = await readJson(exitPath);
      if (exit) return { exitCode: exit.exitCode ?? null, oomKilled: Boolean(exit.oomKilled) };
      const runner = this.meta.runnerPid;
      if (runner && !readProcStat(runner)) {
        await this.runtime.clock.sleep(200);
        const late = await readJson(exitPath);
        if (late) return { exitCode: late.exitCode ?? null, oomKilled: Boolean(late.oomKilled) };
        // The runner shares the job's cgroup, so the kernel's OOM killer may have taken it rather than the job.
        if (await cgroupOomKilled(this.meta.cgroup)) return { exitCode: 137, oomKilled: true };
        return { exitCode: null, oomKilled: false, gone: true };
      }
      await this.runtime.clock.sleep(50);
    }
  }

  /** SIGTERM to the job, then SIGKILL of its sandbox after the grace. */
  async stop(graceSeconds) {
    const grace = Math.max(0, Math.ceil(graceSeconds));
    const job = await this.#pid("job.pid");
    const sandbox = await this.#pid("sandbox.pid");
    if (job) signalGroup(job, "SIGTERM");
    const deadline = Date.now() + grace * 1000;
    while (Date.now() < deadline) {
      if (await readJson(path.join(this.dir, "exit.json"))) return;
      await this.runtime.clock.sleep(50);
    }
    if (job) signalGroup(job, "SIGKILL");
    if (sandbox) signalGroup(sandbox, "SIGKILL");
  }

  async secretValues(names) {
    const pid = await this.#pid("job.pid");
    if (!pid) return [];
    return readEnviron(pid, names);
  }

  detach() {
    this.detached = true;
  }

  async remove() {
    const sandbox = await this.#pid("sandbox.pid");
    const job = await this.#pid("job.pid");
    if (job) signalGroup(job, "SIGKILL");
    if (sandbox) signalGroup(sandbox, "SIGKILL");
    if (this.meta.runnerPid) signalGroup(this.meta.runnerPid, "SIGKILL");
    if (this.meta.cgroup) await removeCgroup(this.meta.cgroup, this.runtime.clock);
    await rm(this.dir, { recursive: true, force: true });
  }

  handle() {
    const job = this;
    return {
      id: this.id,
      runId: this.labels[RUN_LABEL] ?? this.meta.runId ?? null,
      jobId: this.labels[JOB_LABEL] ?? this.meta.jobId ?? null,
      labels: this.labels,
      logs: { [Symbol.asyncIterator]: () => job.logs() },
      stats: () => this.stats(),
      wait: () => this.wait(),
      stop: (graceSeconds) => this.stop(graceSeconds),
      remove: () => this.remove(),
      secretValues: (names) => this.secretValues(names),
      detach: () => this.detach(),
    };
  }
}

export class ProcessRuntime {
  /**
   * `state`: the agent's StateDir, for the image record. Images and per-run
   * rootfs copies live in `cacheDir` (default `<state>/cache`). `sandbox` is
   * `auto` (the best that starts), or `bwrap`, `userns`, `proot` or `plain`.
   */
  constructor({
    state = null, cacheDir = null, clock = systemClock, log = () => {}, env = process.env,
    sandbox = "auto", bwrap = "bwrap", proot = "proot", unshare = "unshare",
    fetch = globalThis.fetch, keepImages = 3, selfTestImage = DEFAULT_IMAGE, selfTestArgs = ["sh", "-c", "echo home-compute"],
    platform = process.platform,
  } = {}) {
    this.state = state;
    this.cacheDir = cacheDir ?? (state ? path.join(state.dir, "cache") : path.join(os.tmpdir(), "home-compute-process"));
    this.clock = clock;
    this.log = log;
    this.env = env;
    this.preference = sandbox;
    this.bins = { bwrap, proot, unshare };
    this.fetch = fetch;
    this.keepImages = keepImages;
    this.selfTestImage = selfTestImage;
    this.selfTestArgs = selfTestArgs;
    this.platform = platform;
    this.images = new ImageRecord(state);
    this.inUse = new Map();
    this.detected = null;
    this.cgroupInfo = null;
  }

  #imageDir(digest) {
    const { algo, hex } = digestParts(digest);
    return path.join(this.cacheDir, "images", algo, hex);
  }

  async #refs() {
    return (await readJson(path.join(this.cacheDir, "refs.json"))) ?? {};
  }

  async #rememberRef(reference, digest) {
    const refs = await this.#refs();
    const spec = normalizeImageRef(reference);
    refs[reference] = digest;
    refs[`${spec.repo}:${spec.tag ?? "latest"}`] = digest;
    refs[spec.repo] = digest;
    await writeJson(path.join(this.cacheDir, "refs.json"), refs);
  }

  async #imageReady(digest) {
    if (!digest?.startsWith("sha256:")) return false;
    return existsSync(path.join(this.#imageDir(digest), "config.json"));
  }

  async #sandbox() {
    if (!this.detected) this.detected = await detectSandbox({ preference: this.preference, bins: this.bins, platform: this.platform });
    return this.detected;
  }

  async #limits() {
    if (!this.cgroupInfo) this.cgroupInfo = await probeCgroup();
    return this.cgroupInfo;
  }

  async ensureReady() {
    if (this.platform !== "linux") throw new Error("the process runtime runs on Linux; use colima on a Mac");
    await mkdir(this.cacheDir, { recursive: true });
    await chmod(this.cacheDir, 0o700).catch(() => {});
    const sandbox = await this.#sandbox();
    if (sandbox.missing) throw new Error(sandbox.warning ?? `sandbox ${this.preference} is not available`);
    return { bootMs: 0 };
  }

  async idle() {
    const inUse = new Set(this.inUse.values());
    const removed = await this.images.prune(async (reference) => {
      const digest = parseImageRef(reference).digest;
      if (!digest) return false;
      await rm(this.#imageDir(digest), { recursive: true, force: true });
      return true;
    }, { keep: this.keepImages, inUse });
    if (removed.length) this.log("images_pruned", { removed });
    return { pruned: removed };
  }

  async stop() {}

  async hasImage(reference) {
    const spec = normalizeImageRef(reference);
    if (spec.digest) return this.#imageReady(spec.digest);
    // A registry tag is resolved by pulling (§4.5). A name with no registry host is local: it runs only when it is already unpacked.
    if (!isLocalImage(reference)) return false;
    const refs = await this.#refs();
    const digest = refs[reference] ?? refs[`${spec.repo}:${spec.tag ?? "latest"}`] ?? null;
    return Boolean(digest && await this.#imageReady(digest));
  }

  async imageDigest(reference) {
    const spec = normalizeImageRef(reference);
    if (spec.digest && await this.#imageReady(spec.digest)) return spec.digest;
    const refs = await this.#refs();
    const digest = refs[reference] ?? refs[`${spec.repo}:${spec.tag ?? "latest"}`] ?? null;
    return digest && await this.#imageReady(digest) ? digest : null;
  }

  /**
   * Pulls `reference`. `auth` is `{server, username, password}` from the claim,
   * used for this pull's token exchange only. A tag that cannot be pulled but
   * was unpacked here before runs as that copy.
   */
  async pull(reference, { auth = null, timeoutMs = 20 * 60_000 } = {}) {
    const started = this.clock.monotonic();
    const staging = path.join(this.cacheDir, "staging", `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const rootfs = path.join(staging, "rootfs");
    try {
      const result = await pullImage(reference, { auth, rootfs, timeoutMs, fetch: this.fetch });
      await writeJson(path.join(staging, "config.json"), result.config);
      await writeJson(path.join(staging, "meta.json"), { digest: result.digest, reference, pulledAt: this.clock.now() });
      const dest = this.#imageDir(result.digest);
      await mkdir(path.dirname(dest), { recursive: true });
      await rm(dest, { recursive: true, force: true });
      await rename(staging, dest);
      await this.#rememberRef(reference, result.digest);
      await this.images.used(normalizeImageRef(reference).repo, result.digest, { pulled: true, now: this.clock.now() }).catch(() => {});
      return { digest: result.digest, ms: Math.round(this.clock.monotonic() - started) };
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      const cached = await this.imageDigest(reference);
      if (cached && !normalizeImageRef(reference).digest) {
        this.log("pull_failed_using_local", { image: reference, error: error.message });
        return { digest: cached, ms: Math.round(this.clock.monotonic() - started), stale: true };
      }
      throw error;
    }
  }

  /**
   * Unpacks a rootfs this process already has (a test, or an image with no
   * registry). `digest` is the cache key; it is recorded as pulled so idle
   * pruning may remove it.
   */
  async installImage({ reference, digest, config, rootfs }) {
    const staging = path.join(this.cacheDir, "staging", `install-${digestParts(digest).hex.slice(0, 12)}`);
    await rm(staging, { recursive: true, force: true });
    await copyTree(rootfs, path.join(staging, "rootfs"));
    await writeJson(path.join(staging, "config.json"), config);
    await writeJson(path.join(staging, "meta.json"), { digest, reference, installed: true });
    const dest = this.#imageDir(digest);
    await mkdir(path.dirname(dest), { recursive: true });
    await rm(dest, { recursive: true, force: true });
    await rename(staging, dest);
    await this.#rememberRef(reference, digest);
    await this.images.used(normalizeImageRef(reference).repo, digest, { pulled: true, now: this.clock.now() }).catch(() => {});
    return { digest };
  }

  async run(spec) {
    const refusal = processRefusal(spec);
    if (refusal) throw new Error(refusal);
    await this.ensureReady();
    const digest = await this.imageDigest(spec.image);
    if (!digest) throw new Error(`${spec.image} is not unpacked; pull it first`);
    const imageDir = this.#imageDir(digest);
    const config = await readJson(path.join(imageDir, "config.json"));
    const command = jobCommand(config, spec);
    const env = jobEnv(config, spec);
    const workdir = jobWorkdir(config);
    const network = spec.network ?? "bridge";
    const sandbox = await this.#sandbox();
    const runDir = path.join(this.cacheDir, "runs", spec.runId);
    await rm(runDir, { recursive: true, force: true });
    const rootfs = path.join(runDir, "rootfs");
    await copyTree(path.join(imageDir, "rootfs"), rootfs);
    // Inside the copy only: a symlink in the image must not make the agent create or replace this machine's files.
    const work = await insideRoot(rootfs, workdir);
    if (work) await mkdir(work, { recursive: true });
    if (network !== "none") await this.#copyHostFile("/etc/resolv.conf", rootfs, "etc/resolv.conf");
    if (network !== "none") await this.#copyHostFile("/etc/hosts", rootfs, "etc/hosts");
    const identity = resolveIdentity(rootfs, jobUser(config));
    const { inherit, loader } = splitLoaderEnv(env);
    const launch = sandboxLaunch({
      kind: sandbox.kind, bins: sandbox.bins, rootfs, workdir, command,
      loaderEnv: sandbox.kind === "bwrap" ? loader : {},
      network, uid: identity.uid, gid: identity.gid, pathEnv: env.PATH, options: sandbox.options,
    });
    const memoryMiB = Math.max(16, Math.round(spec.resources?.memoryMiB ?? 1024));
    const limits = { memoryBytes: memoryMiB * 1048576, cpus: spec.resources?.cpus ?? 1, pids: PIDS_LIMIT };
    const cgroup = await this.#runCgroup(spec.runId, limits);
    const jobEnvForChild = sandbox.kind === "bwrap" ? inherit : env;
    const meta = {
      runId: spec.runId, jobId: spec.jobId, image: spec.image, digest,
      labels: spec.labels ?? {}, limits, sandbox: sandbox.kind, cgroup, id: `hc-${spec.runId}`,
    };
    await writeJson(path.join(runDir, "meta.json"), meta);
    await writeJson(path.join(runDir, "launch.json"), {
      file: launch.file, args: launch.args, cwd: launch.cwd, log: path.join(runDir, "log"),
      jobPid: path.join(runDir, "job.pid"), statusFd: launch.statusFd, limits, cgroup, sandbox: sandbox.kind,
    });
    await writeFile(path.join(runDir, "log"), "");
    const runner = this.#spawnRunner(runDir, jobEnvForChild);
    meta.runnerPid = runner.pid;
    await writeJson(path.join(runDir, "meta.json"), meta);
    this.inUse.set(spec.runId, digest);
    await this.images.used(normalizeImageRef(spec.image).repo, digest, { now: this.clock.now() }).catch(() => {});
    return new ProcessJob(this, runDir, meta).handle();
  }

  #spawnRunner(runDir, env) {
    const payload = Buffer.from(`${Object.entries(env).map(([name, value]) => `${name}=${value}`).join("\0")}\0`);
    const source = existsSync(RUNNER_SOURCE);
    const args = source ? [RUNNER_SOURCE, runDir] : [process.argv[1], runDir];
    const runnerEnv = {};
    for (const name of ["PATH", "LANG", "LC_ALL", "HOME", "TMPDIR", "SSL_CERT_FILE"]) {
      if (typeof this.env[name] === "string") runnerEnv[name] = this.env[name];
    }
    if (!source) runnerEnv.HC_PROCESS_RUNNER = "1";
    const errFd = openSync(path.join(runDir, "runner.log"), "a");
    let child;
    try {
      child = spawn(process.execPath, args, { cwd: runDir, env: runnerEnv, detached: true, stdio: ["pipe", "ignore", errFd] });
    } catch (error) {
      throw new Error(`the process runner could not start: ${error.message}`);
    } finally {
      closeSync(errFd);
    }
    child.stdin.on("error", () => {});
    child.stdin.end(payload);
    child.unref();
    child.on("error", (error) => this.log("runner_error", { error: error.message }));
    if (!(child.pid > 1)) throw new Error("the process runner did not start");
    return child;
  }

  async #runCgroup(runId, limits) {
    const info = await this.#limits();
    if (!info.base || (!info.memory && !info.cpu)) return null;
    const dir = path.join(info.base, `hc-${runId}`);
    try {
      await mkdir(dir);
      return dir;
    } catch {
      return null;
    }
  }

  /** Copies a host file to `relative` in the run's rootfs. The file there (a symlink, say) is replaced, never written through. */
  async #copyHostFile(source, rootfs, relative) {
    try {
      const data = await readFile(source);
      const dir = await insideRoot(rootfs, path.posix.dirname(relative));
      if (!dir) return;
      await mkdir(dir, { recursive: true });
      const dest = path.join(dir, path.posix.basename(relative));
      await rm(dest, { force: true, recursive: true }).catch(() => {});
      await writeFile(dest, data, { flag: "wx" });
    } catch {
      // DNS then uses whatever the image shipped. The run still starts.
    }
  }

  released(runId) {
    this.inUse.delete(runId);
  }

  async adopt() {
    const runsDir = path.join(this.cacheDir, "runs");
    let names = [];
    try { names = await readdir(runsDir); } catch { return []; }
    const handles = [];
    for (const name of names) {
      const dir = path.join(runsDir, name);
      const meta = await readJson(path.join(dir, "meta.json"));
      if (!meta?.runId) continue;
      handles.push(new ProcessJob(this, dir, meta).handle());
    }
    return handles;
  }

  async facts() {
    // No sandbox that starts means no run can start: the agent then reports the runtime as down and claims nothing.
    const sandbox = await this.#sandbox();
    if (sandbox.missing) throw new Error(sandbox.warning ?? `sandbox ${this.preference} is not available`);
    const limits = this.platform === "linux" ? await this.#limits().catch(() => ({ kind: "watchdog", warning: null })) : { kind: "none", warning: null };
    const capacity = hostCapacity();
    const diskFreeMiB = await freeDiskMiB(this.cacheDir).catch(() => null) ?? await freeDiskMiB(os.homedir());
    return {
      kind: "process",
      version: `oci/${sandbox.kind}${sandbox.options?.pidns === false ? "-nopid" : ""}`,
      cpus: capacity.cpus,
      memoryMiB: capacity.memoryMiB,
      diskFreeMiB,
      os: `${os.type()} ${os.release()}`,
      vm: null,
      sandbox: sandbox.kind,
      sandboxWarning: sandbox.warning ?? null,
      limits: limits.kind,
      limitsWarning: limits.warning ?? null,
      networkWarning: NETWORK_WARNING,
    };
  }

  /** doctor: unpack (if needed) and run a tiny command under the same sandbox a job uses. */
  async selfTest(image = this.selfTestImage) {
    await this.ensureReady();
    // A tag's hasImage is false on purpose (a job re-pulls it). Doctor should not download it again once it is unpacked.
    if (!(await this.imageDigest(image))) await this.pull(image, { timeoutMs: 180_000 });
    const handle = await this.run({
      runId: "r_doctor", jobId: "doctor", image, entrypoint: null, args: this.selfTestArgs,
      env: {}, secretEnv: {}, resources: { cpus: 1, memoryMiB: 128 }, network: "none",
      labels: { [RUN_LABEL]: "r_doctor", [JOB_LABEL]: "doctor" },
    });
    const lines = [];
    try {
      for await (const line of handle.logs) if (line.trim()) lines.push(line.trim());
      const result = await handle.wait();
      if (result.exitCode !== 0) throw new Error(`self-test exited ${result.exitCode ?? "unknown"}`);
      return lines[0] ?? "";
    } finally {
      await handle.remove().catch(() => {});
    }
  }
}

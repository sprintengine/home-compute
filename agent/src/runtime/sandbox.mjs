// How a process-runtime job is confined. bubblewrap (a user namespace, a pid
// namespace, and a fresh mount of the image) when it works, or bubblewrap
// without the pid namespace where /proc cannot be mounted again (a container
// whose /proc is masked); otherwise util-linux `unshare`, then proot. Each
// is probed with the flags a run uses, so the one chosen is one that starts.
//
// `plain` (the image's entrypoint run on this machine, with this machine's
// loader, root and paths) is never chosen by `auto`: an image's binaries
// need the image's own libraries at `/`, and its absolute paths (an
// entrypoint script, a work directory) name the image's files, so on most
// images plain mode fails or, worse, reads and writes this machine's files.
// A machine may still ask for it by name, for images built to run that way.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, readFile, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./process.mjs";

const PAGE = 4096;
const CLK_TCK = 100;
/** Names that would change how bubblewrap or proot itself starts, so a secret must not have them. */
export const SANDBOX_ENV = /^(LD_|BWRAP_|PROOT_)/;

export const NETWORK_WARNING = "network bridge shares this machine's network namespace (there is no separate Docker bridge); network none drops the network with bubblewrap or a user namespace";

const SANDBOX_WARNING = {
  plain: "no sandbox (process.sandbox is plain): jobs run as plain processes with this machine's loader, root and paths, sharing its user, files and network. Only a self-contained image works this way.",
  proot: "sandbox is proot, which confines the root filesystem with ptrace; network none does not get a separate network namespace. Install bubblewrap for that.",
  nopid: "sandbox is bubblewrap without a pid namespace (this machine's /proc cannot be mounted again, as in a container that masks it): a job sees this machine's processes.",
};

/** Why `auto` found nothing: the run would need an image's own root, which only a sandbox gives it. */
export const NO_SANDBOX = "no sandbox starts here (bubblewrap, a user namespace and proot were each tried with a run's flags). Install bubblewrap, or allow unprivileged user namespaces, so jobs get their image as /. Until then this machine claims nothing. process.sandbox \"plain\" runs only self-contained images.";

/**
 * The argv of a sandbox, without the job's environment (that travels in the
 * child process's environment, never in argv). `rootfs` is the private copy
 * of the image. `uid`/`gid` are the ids inside the sandbox.
 */
export function sandboxLaunch({
  kind, bins, rootfs, workdir, command, loaderEnv = {}, network, uid = 0, gid = 0, pathEnv = null,
  options = {}, readOnlyRoot = false, statusFd = true,
}) {
  if (!command?.length) throw new Error("the image has no command");
  if (kind === "bwrap") {
    const args = [
      "--unshare-user", ...(options.pidns === false ? [] : ["--unshare-pid"]), "--unshare-uts", "--unshare-ipc",
      "--uid", String(uid), "--gid", String(gid),
      "--die-with-parent", "--new-session", "--hostname", "home-compute",
      "--chdir", workdir,
      readOnlyRoot ? "--ro-bind" : "--bind", rootfs, "/",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
      ...(statusFd ? ["--json-status-fd", "3"] : []),
    ];
    if (network === "none") args.push("--unshare-net");
    // Loader variables are applied to the job, not to bwrap, so an image's
    // LD_LIBRARY_PATH cannot point bwrap at the image's libraries.
    for (const [name, value] of Object.entries(loaderEnv)) args.push("--setenv", name, value);
    args.push("--", ...command);
    return { file: bins.bwrap, args, cwd: rootfs, statusFd };
  }
  if (kind === "userns") {
    const args = ["--user", "--map-root-user", "--mount", "--pid", "--fork", "--mount-proc"];
    if (network === "none") args.push("--net");
    args.push("--root", rootfs, "--wd", workdir, "--", ...command);
    return { file: bins.unshare, args, cwd: rootfs, statusFd: false };
  }
  if (kind === "proot") {
    const args = ["-r", rootfs, "-w", workdir, "-b", "/proc", "-b", "/dev", "-0", "--", ...command];
    return { file: bins.proot, args, cwd: rootfs, statusFd: false };
  }
  const plain = plainCommand(rootfs, command, workdir, pathEnv);
  return { file: plain.file, args: plain.args, cwd: plain.cwd, statusFd: false };
}

/** An executable inside the rootfs, and the host path of `workdir`. Plain mode never falls back to a host binary. */
export function plainCommand(rootfs, command, workdir, pathEnv = null) {
  const [bin, ...rest] = command;
  const file = resolveInRoot(rootfs, bin, pathEnv);
  if (!file) throw new Error(`${bin} is not in the image, and there is no sandbox to provide it (install bubblewrap)`);
  const relative = workdir.startsWith("/") ? workdir.slice(1) : workdir;
  const cwd = path.join(rootfs, relative);
  return { file, args: rest, cwd: existsSync(cwd) ? cwd : rootfs };
}

function resolveInRoot(rootfs, bin, pathEnv) {
  if (!bin) return null;
  if (bin.includes("/")) {
    const candidate = bin.startsWith("/") ? path.join(rootfs, bin.slice(1)) : path.join(rootfs, bin);
    return existsSync(candidate) ? candidate : null;
  }
  const dirs = String(pathEnv ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin").split(":");
  for (const dir of dirs) {
    const relative = dir.startsWith("/") ? dir.slice(1) : dir;
    const candidate = path.join(rootfs, relative, bin);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Splits job env into what a helper may inherit and the loader variables bwrap must apply itself. */
export function splitLoaderEnv(env) {
  const inherit = {};
  const loader = {};
  for (const [name, value] of Object.entries(env ?? {})) {
    if (name.startsWith("LD_")) loader[name] = value;
    else inherit[name] = value;
  }
  return { inherit, loader };
}

/**
 * What `auto` tries, best first. A probe runs /bin/true the way a run would
 * start (this machine's root read-only, standing in for the image), so a
 * helper that starts but cannot mount what a run needs is not chosen.
 */
const CANDIDATES = [
  { kind: "bwrap", options: { pidns: true } },
  { kind: "bwrap", options: { pidns: false }, warning: SANDBOX_WARNING.nopid },
  { kind: "userns", options: {} },
  { kind: "proot", options: {} },
];

async function probe({ kind, options }, tools) {
  const run = (launch) => runCommand(launch.file, launch.args, { timeoutMs: 20_000 });
  if (kind === "bwrap") {
    await run(sandboxLaunch({ kind, bins: tools, rootfs: "/", workdir: "/", command: ["/bin/true"], network: "bridge", options, readOnlyRoot: true, statusFd: false }));
    return;
  }
  if (kind === "userns") {
    // The run's flags, with this machine's root for the image's.
    await run({ file: tools.unshare, args: ["--user", "--map-root-user", "--mount", "--pid", "--fork", "--mount-proc", "--root", "/", "--wd", "/", "--", "/bin/true"] });
    return;
  }
  await run({ file: tools.proot, args: ["-r", "/", "-w", "/", "-b", "/proc", "-b", "/dev", "-0", "--", "/bin/true"] });
}

/**
 * The best sandbox that actually starts. `preference` is `auto` or one kind.
 * When nothing usable is found (`auto` with no helper that starts, or a named
 * kind that does not), the answer has `missing` and a warning that says why;
 * the runtime then refuses to start runs, and the agent claims none. `plain`
 * is only ever the answer when it is the preference.
 */
export async function detectSandbox({ preference = "auto", bins, platform = process.platform } = {}) {
  const tools = {
    bwrap: bins?.bwrap ?? "bwrap",
    unshare: bins?.unshare ?? "unshare",
    proot: bins?.proot ?? "proot",
  };
  if (platform !== "linux") {
    return { kind: "none", bins: tools, options: {}, warning: "the process runtime sandboxes jobs on Linux; this machine is not Linux", missing: true };
  }
  if (preference === "plain") return { kind: "plain", bins: tools, options: {}, warning: SANDBOX_WARNING.plain };
  const order = preference === "auto" ? CANDIDATES : CANDIDATES.filter((candidate) => candidate.kind === preference);
  for (const candidate of order) {
    try {
      await probe(candidate, tools);
      return { kind: candidate.kind, bins: tools, options: candidate.options, warning: candidate.warning ?? SANDBOX_WARNING[candidate.kind] ?? null };
    } catch {
      // Try the next one. The reason is in the warning when nothing works.
    }
  }
  const warning = preference === "auto" ? NO_SANDBOX : `sandbox ${preference} does not start here with a run's flags`;
  return { kind: "none", bins: tools, options: {}, warning, missing: true };
}

/** Whether this process may create a cgroup and set memory or CPU on it. Most nested containers may not. */
export async function probeCgroup({ root = null } = {}) {
  const relative = cgroupRelative();
  const base = root ?? (relative == null ? null : path.join("/sys/fs/cgroup", relative));
  if (!base) return { kind: "watchdog", memory: false, cpu: false, base: null, warning: cgroupWarning(false, false) };
  const probe = path.join(base, `hc-probe-${process.pid}`);
  try {
    await mkdir(probe);
    const memory = await writeQuiet(path.join(probe, "memory.max"), String(64 * 1024 * 1024));
    const cpu = await writeQuiet(path.join(probe, "cpu.max"), "100000 100000");
    return { kind: memory || cpu ? "cgroup" : "watchdog", memory, cpu, base, warning: cgroupWarning(memory, cpu) };
  } catch {
    return { kind: "watchdog", memory: false, cpu: false, base, warning: cgroupWarning(false, false) };
  } finally {
    // rmdir, not rm: a cgroup's control files cannot be unlinked, so a recursive rm leaves it behind.
    await rmdir(probe).catch(() => {});
  }
}

function cgroupWarning(memory, cpu) {
  if (memory && cpu) return null;
  if (!memory && !cpu) return "cgroup v2 is not delegated, so memory is enforced by a resident-set watchdog and CPU is not hard-capped";
  if (!memory) return "cgroup v2 has no memory controller here, so memory is enforced by a resident-set watchdog";
  return "cgroup v2 has no CPU controller here, so CPU is not hard-capped";
}

async function writeQuiet(file, text) {
  try {
    await writeFile(file, text);
    return true;
  } catch {
    return false;
  }
}

/** The cgroup v2 path of this process, relative to `/sys/fs/cgroup`, or null. */
export function cgroupRelative(text = null) {
  let body = text;
  if (body == null) {
    try { body = readFileSync("/proc/self/cgroup", "utf8"); } catch { return null; }
  }
  const line = body.split("\n").find((entry) => entry.startsWith("0::"));
  if (!line) return null;
  return line.slice(3).replace(/^\//, "");
}

export function readProcStat(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = text.lastIndexOf(")");
    if (close < 0) return null;
    const rest = text.slice(close + 2).split(" ");
    return {
      state: rest[0],
      ppid: Number(rest[1]),
      utime: Number(rest[11]),
      stime: Number(rest[12]),
      starttime: Number(rest[19]),
    };
  } catch {
    return null;
  }
}

function childPids(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8");
    return text.trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return scanChildren(pid);
  }
}

function scanChildren(pid) {
  let names = [];
  try { names = readdirSync("/proc"); } catch { return []; }
  const children = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const stat = readProcStat(Number(name));
    if (stat?.ppid === pid) children.push(Number(name));
  }
  return children;
}

export function descendants(pid, seen = new Set()) {
  const all = [];
  for (const child of childPids(pid)) {
    if (seen.has(child)) continue;
    seen.add(child);
    all.push(child, ...descendants(child, seen));
  }
  return all;
}

/** SIGTERM or SIGKILL for a job: its process group when it leads one, else the process. Never this agent, never pid 1. */
export function signalGroup(pid, signal) {
  const id = Number(pid);
  if (!id || id === 1 || id === process.pid) return;
  try {
    process.kill(-id, signal);
  } catch {
    try { process.kill(id, signal); } catch { /* already gone */ }
  }
}

/** Resident set and CPU of a process and its children. `cpuPct` is the share of one CPU since `previous`. */
export function sampleTree(pid, previous, now = Date.now()) {
  const ids = [Number(pid), ...descendants(Number(pid))];
  let rss = 0;
  let ticks = 0;
  for (const id of ids) {
    const stat = readProcStat(id);
    if (!stat) continue;
    ticks += stat.utime + stat.stime;
    try {
      const statm = readFileSync(`/proc/${id}/statm`, "utf8");
      rss += Number(statm.split(/\s+/)[1] || 0) * PAGE;
    } catch {
      // Exited between the stat and the statm.
    }
  }
  let cpuPct = 0;
  if (previous && now > previous.now) {
    const seconds = (now - previous.now) / 1000;
    // A child that exits leaves the tree, so the summed ticks can fall. That delta is not usage.
    const delta = Math.max(0, ticks - previous.ticks);
    cpuPct = (delta / CLK_TCK) / seconds * 100;
  }
  return {
    memoryBytes: rss,
    cpuPct: Math.max(0, Math.round(cpuPct * 10) / 10),
    cpuSeconds: Math.max(0, Math.round((ticks / CLK_TCK) * 1000) / 1000),
    raw: { ticks, now },
  };
}

/** The first child pid of `pid`, once it has one. `unshare --fork` is the parent of the command. */
export async function firstChild(pid, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const children = childPids(pid);
    if (children.length) return children[0];
    if (!readProcStat(pid)) return null;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return childPids(pid)[0] ?? null;
}

export async function readEnviron(pid, names) {
  let buffer;
  try { buffer = await readFile(`/proc/${pid}/environ`); } catch { return []; }
  const wanted = new Set(names);
  const values = [];
  for (const entry of buffer.toString("utf8").split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0 && wanted.has(entry.slice(0, eq))) values.push(entry.slice(eq + 1));
  }
  return values;
}

/** uid and gid the sandbox should use. A name is looked up in the image's `/etc/passwd`. */
export function resolveIdentity(rootfs, user) {
  const text = String(user ?? "").trim();
  if (!text) return { uid: 0, gid: 0 };
  const [name, group] = text.split(":");
  const uid = Number.isInteger(Number(name)) && name !== "" ? Number(name) : userId(rootfs, name);
  const gid = group == null || group === "" ? uid : (Number.isInteger(Number(group)) ? Number(group) : groupId(rootfs, group));
  return { uid: uid ?? 0, gid: gid ?? uid ?? 0 };
}

function userId(rootfs, name) {
  return idFrom(path.join(rootfs, "etc/passwd"), name);
}

function groupId(rootfs, name) {
  return idFrom(path.join(rootfs, "etc/group"), name);
}

function idFrom(file, name) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch { return null; }
  for (const line of text.split("\n")) {
    const fields = line.split(":");
    if (fields[0] === name) return Number(fields[2]);
  }
  return null;
}

/** Host CPUs and memory the process runtime can offer (the whole machine; there is no VM). */
export function hostCapacity() {
  return {
    cpus: os.availableParallelism?.() ?? os.cpus().length,
    memoryMiB: Math.floor(os.totalmem() / (1024 * 1024)),
  };
}

/** Best-effort absolute path of a command, for errors. A missing command stays as it was named. */
export function commandPath(file) {
  if (file.includes("/")) return file;
  const found = spawnSync("/bin/sh", ["-c", `command -v ${file}`], { encoding: "utf8" });
  const resolved = found.stdout?.trim();
  return resolved || file;
}

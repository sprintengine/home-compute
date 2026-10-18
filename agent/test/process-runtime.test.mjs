// ProcessRuntime without a registry and without Docker: a script image runs
// in plain mode, asked for by name (so CI needs no bubblewrap), and
// bubblewrap is used when it actually starts. Secrets stay out of argv and
// off disk. A stand-in registry is covered in oci.test.mjs; the real busybox
// pull is process-real.test.mjs. Tests that start a job need Linux (/proc);
// elsewhere they are skipped, so `npm run check` passes on a Mac too.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JOB_LABEL, RUN_LABEL } from "../../src/core/protocol.mjs";
import { main } from "../src/cli.mjs";
import { ProcessRuntime, processRefusal } from "../src/runtime/process-runtime.mjs";
import { NO_SANDBOX, detectSandbox, sandboxLaunch } from "../src/runtime/sandbox.mjs";
import { tempState, until } from "./support.mjs";
import { Readable } from "node:stream";

const RUN = "r_01J0000000000000000000000P";
const REF = "ghcr.io/example/job:test";
const DIGEST = `sha256:${"ab".repeat(32)}`;
/** Starting a job reads /proc, so these run on Linux only. */
const LINUX = process.platform === "linux" ? {} : { skip: "the process runtime runs jobs on Linux only" };

function clockAt(start = 10_000) {
  let now = start;
  return {
    now: () => now,
    monotonic: () => now,
    advance(ms = 5) { now += ms; },
    sleep: (ms, signal) => new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, Math.min(ms, 30));
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); });
    }),
  };
}

async function setup(t, options = {}) {
  const state = await tempState(t);
  const clock = options.clock ?? clockAt();
  const runtime = new ProcessRuntime({ state, sandbox: "plain", clock, ...options, state });
  return { state, runtime, clock };
}

async function installScript(t, runtime, { reference = REF, digest = DIGEST, body, name = "job.mjs", env = ["PATH=/usr/bin:/bin"] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hc-script-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, name), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  await runtime.installImage({
    reference, digest, rootfs: root,
    config: { config: { Entrypoint: [`/${name}`], Env: env, WorkingDir: "/" } },
  });
}

function spec(extra = {}) {
  return {
    runId: RUN, jobId: "job", image: REF, entrypoint: null, args: [],
    env: {}, secretEnv: {}, resources: { cpus: 1, memoryMiB: 256 }, network: "none",
    labels: { [RUN_LABEL]: RUN, [JOB_LABEL]: "job" }, ...extra,
  };
}

async function linesOf(handle) {
  const lines = [];
  for await (const line of handle.logs) lines.push(line);
  return lines;
}

test("sandbox argv isolates the rootfs and keeps loader variables out of the helper's own environment", () => {
  const launch = sandboxLaunch({
    kind: "bwrap", bins: { bwrap: "/usr/bin/bwrap" }, rootfs: "/images/root", workdir: "/work",
    command: ["echo", "hi"], loaderEnv: { LD_LIBRARY_PATH: "/lib" }, network: "none",
  });
  assert.equal(launch.file, "/usr/bin/bwrap");
  assert.ok(launch.args.includes("--unshare-user"));
  assert.ok(launch.args.includes("--unshare-net"));
  assert.ok(launch.args.includes("--die-with-parent"));
  assert.deepEqual(launch.args.slice(launch.args.indexOf("--setenv"), launch.args.indexOf("--setenv") + 3), ["--setenv", "LD_LIBRARY_PATH", "/lib"]);
  assert.deepEqual(launch.args.slice(launch.args.indexOf("--")), ["--", "echo", "hi"]);
});

test("plain mode refuses a command that is not in the image", () => {
  assert.throws(() => sandboxLaunch({
    kind: "plain", bins: {}, rootfs: os.tmpdir(), workdir: "/", command: ["this-binary-is-not-there"], network: "bridge",
  }), /not in the image/);
});

test("auto never falls back to plain: with no sandbox that starts, the runtime refuses runs and reports itself down", async (t) => {
  const none = { bwrap: "/no/bwrap", unshare: "/no/unshare", proot: "/no/proot" };
  const missing = await detectSandbox({ preference: "auto", bins: none, platform: "linux" });
  assert.equal(missing.kind, "none");
  assert.equal(missing.missing, true);
  assert.equal(missing.warning, NO_SANDBOX);
  assert.equal((await detectSandbox({ preference: "bwrap", bins: none, platform: "linux" })).missing, true);
  // Plain is only ever what a machine asked for.
  const plain = await detectSandbox({ preference: "plain", bins: none, platform: "linux" });
  assert.equal(plain.kind, "plain");
  assert.equal(plain.missing, undefined);
  const state = await tempState(t);
  const runtime = new ProcessRuntime({ state, sandbox: "auto", ...none, platform: "linux" });
  // facts() failing is what makes the agent claim nothing (runtimeOk false), as with a Docker daemon that does not answer.
  await assert.rejects(runtime.facts(), /no sandbox starts here/);
  await assert.rejects(runtime.ensureReady(), /no sandbox starts here/);
});

test("a sandbox is probed with a run's flags, and bubblewrap without a pid namespace is kept where /proc cannot be mounted again", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hc-fake-bwrap-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = path.join(dir, "calls");
  // A container that masks /proc: bubblewrap starts, but a pid namespace's /proc cannot be mounted.
  const bwrap = path.join(dir, "bwrap");
  await writeFile(bwrap, `#!/bin/sh\necho "$*" >> "${calls}"\ncase " $* " in *" --unshare-pid "*) echo "bwrap: Can't mount proc on /newroot/proc" >&2; exit 1;; esac\nexit 0\n`, { mode: 0o755 });
  const found = await detectSandbox({ preference: "auto", bins: { bwrap, unshare: "/no/unshare", proot: "/no/proot" }, platform: "linux" });
  assert.equal(found.kind, "bwrap");
  assert.deepEqual(found.options, { pidns: false });
  assert.match(found.warning, /without a pid namespace/);
  const [first, second] = (await readFile(calls, "utf8")).trim().split("\n");
  for (const flag of ["--unshare-user", "--proc /proc", "--dev /dev", "--tmpfs /tmp", "--ro-bind / /", "--hostname home-compute"]) assert.ok(first.includes(flag), `probe has ${flag}: ${first}`);
  assert.ok(first.includes("--unshare-pid") && !second.includes("--unshare-pid"));
  const launch = sandboxLaunch({ kind: "bwrap", bins: { bwrap }, rootfs: "/images/root", workdir: "/", command: ["true"], network: "bridge", options: found.options });
  assert.ok(!launch.args.includes("--unshare-pid"));
  assert.ok(launch.args.includes("--json-status-fd"));
  assert.deepEqual(launch.args.slice(launch.args.indexOf("--bind"), launch.args.indexOf("--bind") + 3), ["--bind", "/images/root", "/"]);
});

test("a spec that would retarget the sandbox is refused before anything starts", () => {
  assert.equal(processRefusal(spec()), null);
  assert.match(processRefusal(spec({ secretEnv: { LD_PRELOAD: "/tmp/x" } })), /sandbox starts/);
  assert.match(processRefusal(spec({ env: { "A B": "x" } })), /not an environment variable/);
  assert.match(processRefusal(spec({ network: "host" })), /not allowed/);
});

test("a script image runs with the image command, env and secrets, and the secret is not stored", LINUX, async (t) => {
  const { runtime } = await setup(t);
  const secret = "process-secret-value-0042";
  await installScript(t, runtime, { body: "console.log(`A=${process.env.A} B=${process.env.B} TOKEN=${process.env.TOKEN}`)" });
  const handle = await runtime.run(spec({ env: { B: "from-spec" }, secretEnv: { TOKEN: secret, A: "from-secret" } }));
  assert.deepEqual(await linesOf(handle), [`A=from-secret B=from-spec TOKEN=${secret}`]);
  assert.deepEqual(await handle.wait(), { exitCode: 0, oomKilled: false });
  const runDir = path.join(runtime.cacheDir, "runs", RUN);
  const launch = await readFile(path.join(runDir, "launch.json"), "utf8");
  const meta = await readFile(path.join(runDir, "meta.json"), "utf8");
  const runnerLog = await readFile(path.join(runDir, "runner.log"), "utf8").catch(() => "");
  assert.ok(!launch.includes(secret) && !meta.includes(secret) && !runnerLog.includes(secret));
  assert.ok(!launch.includes("from-secret"));
  await handle.remove();
  assert.equal(existsSync(runDir), false);
});

test("a non-zero exit is the process exit code", LINUX, async (t) => {
  const { runtime } = await setup(t);
  await installScript(t, runtime, { body: "process.exit(3)" });
  const failed = await runtime.run(spec());
  assert.deepEqual(await linesOf(failed), []);
  assert.deepEqual(await failed.wait(), { exitCode: 3, oomKilled: false });
  await failed.remove();
});

test("a running job can be cancelled and adopted after the runtime object is gone", LINUX, async (t) => {
  const { state, runtime } = await setup(t);
  await installScript(t, runtime, { body: "import { writeSync } from 'node:fs'; writeSync(1, 'up\\n'); setInterval(() => {}, 500);" });
  const handle = await runtime.run(spec());
  const reading = linesOf(handle);
  const logFile = path.join(runtime.cacheDir, "runs", RUN, "log");
  await until(async () => (await readFile(logFile, "utf8").catch(() => "")).includes("up"));
  const again = new ProcessRuntime({ state, sandbox: "plain" });
  const [adopted] = await again.adopt();
  assert.equal(adopted.runId, RUN);
  const rereading = linesOf(adopted);
  await adopted.stop(1);
  const result = await adopted.wait();
  assert.equal(result.oomKilled, false);
  assert.ok(result.exitCode === 143 || result.exitCode === 137, `exit ${result.exitCode}`);
  const firstLog = await reading;
  const secondLog = await rereading;
  assert.ok(firstLog.includes("up") || secondLog.includes("up"));
  await adopted.remove();
  assert.equal((await again.adopt()).length, 0);
  void handle;
});

test("memory past the limit is an OOM kill when cgroup memory is not delegated", LINUX, async (t) => {
  const { runtime } = await setup(t);
  const facts = await runtime.facts();
  if (facts.limits === "cgroup") return t.skip("this machine delegates a memory cgroup; the watchdog is not the enforcer");
  await installScript(t, runtime, { body: "const hold = Buffer.alloc(96 * 1024 * 1024, 1); setInterval(() => hold[0], 1000);" });
  const handle = await runtime.run(spec({ resources: { cpus: 1, memoryMiB: 64 } }));
  const result = await handle.wait();
  assert.equal(result.oomKilled, true);
  assert.equal(result.exitCode, 137);
  await handle.remove();
});

test("idle keeps the three newest digests of a repository and drops the rest", async (t) => {
  const clock = clockAt();
  const { runtime } = await setup(t, { clock });
  const root = await mkdtemp(path.join(os.tmpdir(), "hc-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "marker"), "x");
  const digests = ["aa", "bb", "cc", "dd"].map((byte) => `sha256:${byte.repeat(32)}`);
  for (const digest of digests) {
    clock.advance(10);
    await runtime.installImage({ reference: `ghcr.io/example/app:${digest.slice(7, 9)}`, digest, rootfs: root, config: { config: { Cmd: ["true"] } } });
  }
  const { pruned } = await runtime.idle();
  assert.deepEqual(pruned, [`ghcr.io/example/app@${digests[0]}`]);
  assert.equal(existsSync(path.join(runtime.cacheDir, "images", "sha256", digests[0].slice(7))), false);
  assert.equal(existsSync(path.join(runtime.cacheDir, "images", "sha256", digests[3].slice(7))), true);
});

test("bubblewrap runs the image rootfs with its own hostname", async (t) => {
  const detected = await detectSandbox({ preference: "bwrap" });
  if (detected.kind !== "bwrap") return t.skip(`bubblewrap is not usable (${detected.warning})`);
  const state = await tempState(t);
  const runtime = new ProcessRuntime({ state, sandbox: "bwrap" });
  const root = await mkdtemp(path.join(os.tmpdir(), "hc-bwrap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cat = execFileSync("sh", ["-c", "command -v cat"], { encoding: "utf8" }).trim();
  await copyExecutable(root, cat);
  const digest = `sha256:${"cd".repeat(32)}`;
  const reference = "ghcr.io/example/cat:test";
  await runtime.installImage({
    reference, digest, rootfs: root,
    config: { config: { Entrypoint: [cat], Env: ["PATH=/usr/bin:/bin"], WorkingDir: "/" } },
  });
  const handle = await runtime.run({
    runId: RUN, jobId: "cat", image: reference, entrypoint: null, args: ["/proc/sys/kernel/hostname"],
    env: {}, secretEnv: {}, resources: { cpus: 1, memoryMiB: 128 }, network: "none",
    labels: { [RUN_LABEL]: RUN, [JOB_LABEL]: "cat" },
  });
  const lines = await linesOf(handle);
  const result = await handle.wait();
  await handle.remove();
  assert.equal(result.exitCode, 0, lines.join("\n"));
  assert.equal(lines.map((line) => line.trim()).filter(Boolean).at(-1), "home-compute");
});

test("doctor reports the plain-sandbox warning and runs the self-test image", LINUX, async (t) => {
  const state = await tempState(t);
  const runtime = new ProcessRuntime({ state, sandbox: "plain", selfTestImage: REF, selfTestArgs: [] });
  await installScript(t, runtime, { body: "console.log('home-compute')" });
  const { stubFetch } = await import("./support.mjs");
  const fetch = stubFetch(({ path: pathname }) => {
    if (pathname === "/agent/v1/enrol") {
      return { status: 201, body: { machineId: "m_01J0000000000000000000000D", credential: `hca_m_01J0000000000000000000000D_${"B".repeat(43)}`, name: "box", labels: { runtime: "process" }, capabilities: [] } };
    }
    if (pathname === "/health" || pathname === "/agent/v1/sync") return { body: { status: "ok", serverTime: Date.now(), nextSyncInMs: 30_000, claims: [], cancel: [], upcoming: [] } };
    return { status: 404, body: {} };
  });
  const token = `hcj_${"d".repeat(43)}`;
  const enrol = capture();
  assert.equal(await main(["enrol", "--server", "https://core.test", "--join-token-stdin", "--runtime", "process", "--allow-images", "ghcr.io/example/*", "--state-dir", state.dir], { ...enrol, stdin: Readable.from([token]), fetch }), 0, enrol.errors.join("\n"));
  const config = await state.loadConfig();
  assert.equal(config.runtime, "process");
  assert.equal(fetch.requests[0].body.facts.runtime, "process");
  await state.saveConfig({ ...config, process: { sandbox: "plain", selfTestImage: REF, selfTestArgs: [] } });
  const doctor = capture();
  assert.equal(await main(["doctor", "--state-dir", state.dir], { ...doctor, fetch }), 0, doctor.lines.join("\n"));
  const text = doctor.lines.join("\n");
  assert.match(text, /process runtime \(oci\/plain\)/);
  assert.match(text, /no sandbox/);
  assert.match(text, /network bridge shares this machine's network namespace/);
  assert.match(text, /process run works: "home-compute"/);
});

function capture() {
  const lines = [];
  const errors = [];
  return {
    lines, errors,
    out: (text) => lines.push(text),
    error: (text) => errors.push(text),
  };
}

/** Copies a dynamically linked host binary and the libraries it names into `root`, at the same paths. */
async function copyExecutable(root, binary) {
  const real = execFileSync("readlink", ["-f", binary], { encoding: "utf8" }).trim();
  await placeFile(root, real);
  if (path.resolve(binary) !== real) await placeFile(root, binary);
  const ldd = execFileSync("ldd", [real], { encoding: "utf8" });
  for (const line of ldd.split("\n")) {
    const found = line.match(/=>\s+(\/\S+)/)?.[1] ?? line.match(/^\s*(\/\S+)/)?.[1];
    if (!found) continue;
    const libReal = execFileSync("readlink", ["-f", found], { encoding: "utf8" }).trim();
    await placeFile(root, libReal);
    if (found !== libReal) {
      const linkPath = path.join(root, found.slice(1));
      await mkdir(path.dirname(linkPath), { recursive: true });
      if (!existsSync(linkPath)) await symlink(path.relative(path.dirname(linkPath), path.join(root, libReal.slice(1))), linkPath);
    }
  }
}

async function placeFile(root, hostPath) {
  const dest = path.join(root, hostPath.replace(/^\//, ""));
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(hostPath, dest, { dereference: true });
}

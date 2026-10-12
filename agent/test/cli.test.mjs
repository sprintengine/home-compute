// The command line: enrol (token on stdin, files 0600, no second enrolment
// by accident), status, doctor, version, and the bundled single file.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import test from "node:test";
import { main, parseArguments } from "../src/cli.mjs";
import { nameFromHost } from "../src/enrol.mjs";
import { mkdir } from "node:fs/promises";
import { colimaCalls, fakeColimaDir, fakeEnv, startFakeDocker } from "./fake-docker.mjs";
import { stubFetch, tempState } from "./support.mjs";

const run = promisify(execFile);
const MACHINE = "m_01J00000000000000000000001";
const CREDENTIAL = `hca_${MACHINE}_${"A".repeat(43)}`;
const TOKEN = `hcj_${"t".repeat(43)}`;

function io({ stdin = "", fetch, env } = {}) {
  const out = [];
  const error = [];
  return { out: (text) => out.push(text), error: (text) => error.push(text), stdin: Readable.from([stdin]), fetch, env, lines: out, errors: error };
}

const plane = () => stubFetch(({ path, body }) => {
  if (path === "/agent/v1/enrol") {
    if (body.joinToken !== TOKEN) return { status: 401, body: { error: "invalid_join_token", code: "invalid_join_token" } };
    return { status: 201, body: { machineId: MACHINE, credential: CREDENTIAL, name: "box", labels: { os: body.facts.os, runtime: "fake" }, capabilities: [] } };
  }
  if (path === "/health") return { body: { status: "ok" } };
  if (path === "/agent/v1/sync") return { body: { serverTime: Date.now(), nextSyncInMs: 30_000, claims: [], cancel: [], upcoming: [] } };
  return { status: 404, body: {} };
});

test("arguments: flags with values, flags alone, and the command", () => {
  assert.deepEqual(parseArguments(["enrol", "--server", "https://x", "--join-token-stdin", "--name=box"]),
    { _: ["enrol"], server: "https://x", "join-token-stdin": true, name: "box" });
  assert.throws(() => parseArguments(["enrol", "--server"]), /needs a value/);
  assert.equal(nameFromHost("Conals-Mac-mini.local"), "conals-mac-mini");
});

test("enrol reads the join token from stdin and writes a 0600 configuration and credential", async (t) => {
  const state = await tempState(t);
  const fetch = plane();
  const first = io({ stdin: `${TOKEN}\n`, fetch });
  const code = await main(["enrol", "--server", "https://core.test/", "--join-token-stdin", "--state-dir", state.dir], first);
  assert.equal(code, 0, first.errors.join("\n"));
  assert.match(first.lines[0], /^Enrolled box \(m_/);
  assert.equal(await state.readCredential(), CREDENTIAL);
  const config = await state.loadConfig();
  assert.deepEqual([config.server, config.machineId, config.name, config.runtime], ["https://core.test", MACHINE, "box", "fake"]);
  assert.deepEqual([config.allowImages, config.allowLocalImages], [[], false], "nothing may run until the owner says what");
  assert.match(first.lines.join("\n"), /No image may run yet/);
  for (const file of [state.configPath, state.credentialPath]) assert.equal((await stat(file)).mode & 0o777, 0o600);
  const sent = fetch.requests[0].body;
  assert.equal(sent.protocol, 1);
  assert.equal(sent.facts.runtime, "fake");
  assert.ok(!JSON.stringify(fetch.requests[0]).includes(CREDENTIAL));

  const again = io({ stdin: TOKEN, fetch });
  assert.equal(await main(["enrol", "--server", "https://core.test", "--join-token-stdin", "--state-dir", state.dir], again), 1);
  assert.match(again.errors[0], /already enrolled as box; pass --reenrol/);
  const wrong = io({ stdin: `hcj_${"x".repeat(43)}`, fetch });
  assert.equal(await main(["enrol", "--server", "https://core.test", "--join-token-stdin", "--reenrol", "--state-dir", state.dir], wrong), 1);
  assert.match(wrong.errors[0], /401/);
});

test("status says when the agent is not running; doctor checks the setup step by step", async (t) => {
  const state = await tempState(t);
  const fetch = plane();
  await main(["enrol", "--server", "https://core.test", "--join-token-stdin", "--state-dir", state.dir], io({ stdin: TOKEN, fetch }));
  const status = io({ fetch });
  assert.equal(await main(["status", "--state-dir", state.dir], status), 1);
  assert.match(status.lines.join("\n"), /box \(m_.*\n.*not running/);
  const empty = io({ fetch });
  assert.equal(await main(["doctor", "--state-dir", state.dir], empty), 1, "no image may run until allowImages lists some");
  assert.match(empty.lines.join("\n"), /^FAIL allowImages is empty, so this machine runs no image/m);
  await state.saveConfig({ ...(await state.loadConfig()), allowImages: ["*"] });
  const doctor = io({ fetch });
  assert.equal(await main(["doctor", "--state-dir", state.dir], doctor), 0, doctor.lines.join("\n"));
  const text = doctor.lines.join("\n");
  assert.match(text, /^ok   configuration: box/m);
  assert.match(text, /^ok   state directory 0700, files 0600/m);
  assert.match(text, /^warn allowImages is "\*"/m);
  assert.match(text, /^ok   runtime fake/m);
  assert.match(text, /^ok   first sync accepted the credential/m);
  await state.saveConfig({ ...(await state.loadConfig()), allowImages: ["ghcr.io/example/*"] });
  const narrow = io({ fetch });
  assert.equal(await main(["doctor", "--state-dir", state.dir], narrow), 0);
  assert.match(narrow.lines.join("\n"), /^ok   allowImages: ghcr\.io\/example\/\*$/m);
  const unenrolled = await tempState(t);
  assert.equal(await main(["doctor", "--state-dir", unenrolled.dir], io({ fetch })), 1);
});

test("doctor with Docker: it answers, hello-world runs under a run's restrictions, allowImages is set", async (t) => {
  const fake = await startFakeDocker(t);
  fake.addImage("hello-world");
  const state = await tempState(t);
  const fetch = plane();
  await main(["enrol", "--server", "https://core.test", "--join-token-stdin", "--runtime", "docker", "--allow-images", "ghcr.io/sprintengine/*, ghcr.io/me/*",
    "--state-dir", state.dir], io({ stdin: TOKEN, fetch, env: fakeEnv({ DOCKER_HOST: fake.host }) }));
  const config = await state.loadConfig();
  assert.deepEqual([config.runtime, config.allowImages], ["docker", ["ghcr.io/sprintengine/*", "ghcr.io/me/*"]]);
  assert.equal(fetch.requests[0].body.facts.runtimeVersion, "29.0.0-fake", "the enrolment's facts came from the fake, never this machine's Docker");
  await state.saveConfig({ ...config, docker: { host: fake.host } });
  const doctor = { ...io({ fetch }), env: fakeEnv() };
  assert.equal(await main(["doctor", "--state-dir", state.dir], doctor), 0, doctor.lines.join("\n"));
  const text = doctor.lines.join("\n");
  assert.match(text, /^ok   allowImages: ghcr\.io\/sprintengine\/\*, ghcr\.io\/me\/\*$/m);
  assert.match(text, /^ok   Docker answers: 29\.0\.0-fake; 4 CPU, 8192 MiB/m);
  assert.match(text, /^ok   docker run --rm hello-world works: "Hello from Docker!"$/m);
  fake.down = true;
  const down = { ...io({ fetch }), env: fakeEnv() };
  assert.equal(await main(["doctor", "--state-dir", state.dir], down), 1);
  assert.match(down.lines.join("\n"), /^FAIL runtime: Docker is not reachable at /m);
});

test("doctor with Colima: the profile's state; --start-vm starts it once, checks Docker, measures the boot and stops it again", async (t) => {
  const dir = await fakeColimaDir(t);
  await mkdir(path.join(dir, "hc-doctor"), { recursive: true });
  const fake = await startFakeDocker(t, { colimaDir: dir, profile: "hc-doctor", socketPath: path.join(dir, "hc-doctor", "docker.sock") });
  fake.addImage("hello-world");
  const state = await tempState(t);
  const fetch = plane();
  await main(["enrol", "--server", "https://core.test", "--join-token-stdin", "--runtime", "colima", "--colima-profile", "hc-doctor", "--allow-images", "ghcr.io/x/*",
    "--state-dir", state.dir], io({ stdin: TOKEN, fetch, env: fakeEnv({ COLIMA_HOME: dir }) }));
  await state.saveConfig({ ...(await state.loadConfig()), colima: { profile: "hc-doctor", home: dir, minCpus: 1, minMemoryMiB: 1024 }, caps: { cpus: 2, memoryMiB: 3072 } });
  const stopped = { ...io({ fetch }), env: fakeEnv() };
  assert.equal(await main(["doctor", "--state-dir", state.dir], stopped), 0, stopped.lines.join("\n"));
  assert.match(stopped.lines.join("\n"), /^ok   colima 0\.10\.1-fake: profile hc-doctor is absent; caps 2 CPU, 3072 MiB$/m);
  assert.match(stopped.lines.join("\n"), /^warn the VM is stopped, so Docker was not checked; "doctor --start-vm"/m);
  assert.ok(!(await colimaCalls(dir)).some((call) => call.startsWith("start")), "doctor alone never starts the VM");
  const started = { ...io({ fetch }), env: fakeEnv() };
  assert.equal(await main(["doctor", "--start-vm", "--state-dir", state.dir], started), 0, started.lines.join("\n"));
  const text = started.lines.join("\n");
  assert.match(text, /^ok   the VM started in [\d.]+ s$/m);
  assert.match(text, /^ok   docker run --rm hello-world works/m);
  assert.match(text, /^ok   the VM is stopped again$/m);
  assert.deepEqual((await colimaCalls(dir)).filter((call) => /^(start|stop)/.test(call)).map((call) => call.split(" ").slice(0, 2).join(" ")),
    ["start hc-doctor", "stop hc-doctor"]);
  assert.ok(JSON.parse(await readFile(path.join(state.dir, "vm.json"), "utf8")).bootSeconds >= 0, "the boot time is kept for pre-warm");
});

test("version and help; unknown commands fail", async () => {
  const out = io();
  assert.equal(await main(["version"], out), 0);
  assert.match(out.lines[0], /^\d+\.\d+\.\d+ \(protocol 1\)$/);
  assert.equal(await main(["help"], io()), 0);
  assert.equal(await main(["frobnicate"], io()), 2);
});

test("the bundle is one file that runs with Node alone", { timeout: 60_000 }, async () => {
  const root = path.resolve(import.meta.dirname, "..");
  await run(process.execPath, [path.join(root, "scripts", "build.mjs")], { cwd: root });
  const { stdout } = await run(process.execPath, [path.join(root, "dist", "home-compute-agent.mjs"), "version"]);
  assert.match(stdout, /\(protocol 1\)/);
});

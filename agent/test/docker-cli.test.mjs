// DockerCliRuntime against a fake `docker` on PATH and a fake Engine on a
// unix socket (test/fake-docker.mjs): the exact `docker run` argv, secrets
// only in the CLI's environment, timestamped and carriage-return output, a
// broken log stream, stats, exit codes and OOM, stop and removal, adoption
// by label, pulls only when the digest is missing, registry logins for one
// pull, the image cache, facts and doctor's self-test.
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import test from "node:test";
import { JOB_LABEL, RUN_LABEL } from "../../src/core/protocol.mjs";
import { sampleFromStats, socketPathOf } from "../src/runtime/engine.mjs";
import { buildRunArgs, DockerCliRuntime, runRefusal } from "../src/runtime/docker-cli.mjs";
import { digestFor, familiarRepo, ImageRecord, parseImageRef, pruneCandidates } from "../src/runtime/images.mjs";
import { parseLogLine, timestampKey } from "../src/runtime/log-stream.mjs";
import { commandEnv, lastLine, reservedSecretName } from "../src/runtime/process.mjs";
import { fakeEnv, startFakeDocker } from "./fake-docker.mjs";
import { tempState, until } from "./support.mjs";

const RUN = "r_01J0000000000000000000000A";
const SECRET = "fake-s3cr3t-value-0042";

const spec = (extra = {}) => ({
  runId: RUN, jobId: "ecmwf", image: "ghcr.io/sprintengine/wingfoil-forecast@sha256:feedface",
  entrypoint: null, args: ["--models", "ecmwf", "--ecmwf-cycle", "00"],
  env: { AWS_REGION: "auto", FORCE5_SIDECARS: "0" },
  secretEnv: { AWS_ACCESS_KEY_ID: "AKIAFAKEFAKE12345678", AWS_SECRET_ACCESS_KEY: SECRET, S3_BUCKET: "bucket-x", S3_ENDPOINT_URL: "https://acct.r2.example" },
  resources: { cpus: 1, memoryMiB: 1024, diskMiB: 12288 }, network: "bridge",
  labels: { [RUN_LABEL]: RUN, [JOB_LABEL]: "ecmwf" }, ...extra,
});

async function setup(t, options = {}) {
  const fake = await startFakeDocker(t);
  const state = await tempState(t);
  const events = [];
  const runtime = new DockerCliRuntime({ host: fake.host, env: fakeEnv(), state, log: (event, fields) => events.push({ event, ...fields }), ...options });
  return { fake, runtime, state, events };
}

async function collect(handle) {
  const lines = [];
  for await (const line of handle.logs) lines.push(line);
  return lines;
}

test("the docker run argv is exactly §4.3's, with secrets named but never valued", () => {
  assert.deepEqual(buildRunArgs(spec()), [
    "run", "-d", "--name", `hc-${RUN}`,
    "--label", `dev.homecompute.run=${RUN}`, "--label", "dev.homecompute.job=ecmwf",
    "--memory", "1024m", "--memory-swap", "1024m", "--cpus", "1", "--cpu-shares", "256", "--pids-limit", "4096",
    "--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--init", "--network", "bridge",
    "--log-driver", "local", "--log-opt", "max-size=50m",
    "-e", "AWS_REGION=auto", "-e", "FORCE5_SIDECARS=0",
    "-e", "AWS_ACCESS_KEY_ID", "-e", "AWS_SECRET_ACCESS_KEY", "-e", "S3_BUCKET", "-e", "S3_ENDPOINT_URL",
    "ghcr.io/sprintengine/wingfoil-forecast@sha256:feedface", "--models", "ecmwf", "--ecmwf-cycle", "00",
  ]);
  const prune = buildRunArgs(spec({ entrypoint: ["sh", "-c", "prune --older 6h"], args: ["--dry"], network: "none", secretEnv: {}, env: {} }),
    { cgroupParent: "home-compute.slice" });
  assert.deepEqual(prune.slice(prune.indexOf("--log-opt") + 2), ["--cgroup-parent", "home-compute.slice", "--entrypoint", "sh",
    "ghcr.io/sprintengine/wingfoil-forecast@sha256:feedface", "-c", "prune --older 6h", "--dry"]);
  assert.ok(prune.includes("none"));
  for (const forbidden of ["--privileged", "-v", "--volume", "--mount", "--device", "--cap-add", "host", "/var/run/docker.sock"]) {
    assert.ok(!buildRunArgs(spec()).includes(forbidden), forbidden);
  }
  assert.throws(() => buildRunArgs(spec({ network: "host" })), /network host is not allowed/);
  assert.throws(() => buildRunArgs(spec({ network: "container:other" })), /not allowed/);
});

test("secret names docker reads itself, odd names and odd images are refused before docker runs", () => {
  assert.equal(runRefusal(spec()), null);
  assert.match(runRefusal(spec({ secretEnv: { DOCKER_HOST: "tcp://evil:2375" } })), /would change how docker itself runs/);
  assert.match(runRefusal(spec({ secretEnv: { PATH: "/tmp/evil" } })), /would change how docker itself runs/);
  assert.match(runRefusal(spec({ secretEnv: { "A B": "x" } })), /not an environment variable name/);
  assert.match(runRefusal(spec({ image: "--privileged" })), /image reference is invalid/);
  assert.equal(reservedSecretName("AWS_SECRET_ACCESS_KEY"), false);
  assert.deepEqual(commandEnv({ PATH: "/bin", SECRET_TOKEN: "x", HOME: "/h" }, { DOCKER_HOST: "unix:///s" }), { PATH: "/bin", HOME: "/h", DOCKER_HOST: "unix:///s" });
});

test("docker run gets the exact argv, and the secret values only in its environment", async (t) => {
  const { fake, runtime } = await setup(t);
  fake.addImage(spec().image);
  fake.scripts[spec().image] = { lines: ["starting"], hang: true };
  const handle = await runtime.run(spec());
  const call = fake.calls.find((entry) => entry.argv[0] === "run");
  assert.deepEqual(call.argv, buildRunArgs(spec()));
  assert.ok(!call.argv.join(" ").includes(SECRET), "never in argv");
  assert.equal(call.env.AWS_SECRET_ACCESS_KEY, SECRET, "in the CLI's environment");
  assert.equal(call.env.DOCKER_HOST, fake.host);
  assert.equal(call.env.SECRET_FROM_AGENT, undefined);
  assert.ok(call.run.env.includes(`AWS_SECRET_ACCESS_KEY=${SECRET}`), "Docker read it from there");
  assert.deepEqual([handle.runId, handle.jobId], [RUN, "ecmwf"]);
  await handle.stop(1);
  assert.deepEqual(await handle.wait(), { exitCode: 143, oomKilled: false });
  assert.deepEqual(fake.calls.at(-1).argv, ["stop", "-t", "1", handle.id]);
  await handle.remove();
  assert.equal(fake.containers.size, 0);
  await handle.remove();
});

test("a failed docker run leaves no container behind and says why", async (t) => {
  const { fake, runtime } = await setup(t);
  await assert.rejects(runtime.run(spec()), /docker run failed: Unable to find image/);
  assert.deepEqual(fake.calls.at(-1).argv, ["rm", "-f", `hc-${RUN}`]);
});

test("logs: timestamps come off, carriage returns resolve as a terminal shows them, a broken stream resumes without repeats", async (t) => {
  assert.deepEqual(parseLogLine("2026-10-11T18:30:23.580532880Z a 10%\rb 50%\rc 100%"), { at: "2026-10-11T18:30:23.580532880Z", text: "c 100%" });
  assert.deepEqual(parseLogLine("2026-10-11T18:30:23Z done\r"), { at: "2026-10-11T18:30:23Z", text: "done" });
  assert.deepEqual(parseLogLine("2026-10-11T18:30:23.5Z "), { at: "2026-10-11T18:30:23.5Z", text: "" });
  assert.deepEqual(parseLogLine("Error response from daemon: No such container"), { at: null, text: "Error response from daemon: No such container" });
  assert.ok(timestampKey("2026-10-11T18:30:23.5Z") > timestampKey("2026-10-11T18:30:23.123456789Z"));

  const { fake, runtime, events } = await setup(t);
  const image = spec().image;
  fake.addImage(image);
  fake.scripts[image] = { lines: ["one", "progress 10%\rprogress 100%", { text: "three", delayMs: 30 }, { text: "four", delayMs: 30 }], exitCode: 0 };
  fake.breakLogsOnce.add(RUN);
  const handle = await runtime.run(spec());
  assert.deepEqual(await collect(handle), ["one", "progress 100%", "three", "four"]);
  assert.equal((await handle.wait()).exitCode, 0);
  assert.equal(fake.calls.filter((call) => call.argv[0] === "run").length, 1);
  assert.equal(events.filter((event) => event.event === "log_error").length, 0);
});

test("stats: memory is usage − inactive_file, CPU is a share of one CPU between samples; exit codes and OOM come from inspect", async (t) => {
  const raw = (usage, inactive, cpuNs) => ({ memory_stats: { usage, limit: 64 * 1048576, stats: { inactive_file: inactive } }, cpu_stats: { cpu_usage: { total_usage: cpuNs } } });
  const first = sampleFromStats(raw(400e6, 100e6, 2e9), { startedAt: 0, now: 4000 });
  assert.deepEqual({ ...first, raw: undefined }, { memoryBytes: 300e6, memoryLimitBytes: 64 * 1048576, cpuPct: 50, cpuSeconds: 2, raw: undefined });
  const second = sampleFromStats(raw(500e6, 0, 5e9), { previous: first.raw, now: 7000 });
  assert.deepEqual([second.memoryBytes, second.cpuPct, second.cpuSeconds], [500e6, 100, 5]);
  const v1 = sampleFromStats({ memory_stats: { usage: 10, stats: { total_inactive_file: 4 } } });
  assert.equal(v1.memoryBytes, 6);

  const { fake, runtime } = await setup(t);
  const image = spec().image;
  fake.addImage(image);
  fake.scripts[image] = { lines: ["allocating"], hang: true };
  const handle = await runtime.run(spec());
  await until(() => fake.container(RUN));
  fake.container(RUN).stats = { usage: 350e6, inactive: 20e6, limit: 1073741824, cpuNs: 3e9 };
  const sample = await handle.stats();
  assert.equal(sample.memoryBytes, 330e6);
  assert.equal(sample.memoryLimitBytes, 1073741824);
  assert.equal(sample.cpuSeconds, 3);
  assert.equal(typeof sample.cpuPct, "number");
  fake.finish(RUN, { exitCode: 137, oomKilled: true });
  assert.deepEqual(await handle.wait(), { exitCode: 137, oomKilled: true });
  const before = fake.apiCalls;
  await handle.stats().catch(() => {});
  assert.equal(fake.apiCalls - before, 1, "a sample is one Engine request, no process");
});

test("adopt finds containers by label, replays their log, reads their secrets back for redaction, and waits for their exit", async (t) => {
  const { fake, runtime } = await setup(t);
  const image = spec().image;
  fake.addImage(image);
  fake.scripts[image] = { lines: [`token ${SECRET}`], hang: true };
  await runtime.run(spec());
  const other = await startFakeDocker(t);
  assert.deepEqual(await new DockerCliRuntime({ host: other.host, env: fakeEnv() }).adopt(), []);

  const restarted = new DockerCliRuntime({ host: fake.host, env: fakeEnv() });
  const [handle] = await restarted.adopt();
  assert.deepEqual([handle.runId, handle.jobId], [RUN, "ecmwf"]);
  assert.deepEqual(await handle.secretValues(["AWS_SECRET_ACCESS_KEY", "S3_BUCKET", "NOT_THERE"]), [SECRET, "bucket-x"]);
  const lines = collect(handle);
  fake.print(RUN, "after restart");
  fake.finish(RUN, { exitCode: 0 });
  assert.deepEqual(await lines, [`token ${SECRET}`, "after restart"]);
  assert.deepEqual(await handle.wait(), { exitCode: 0, oomKilled: false });
});

test("a detached handle lets go: its log stream and wait end, the container runs on", async (t) => {
  const { fake, runtime } = await setup(t);
  fake.addImage(spec().image);
  fake.scripts[spec().image] = { lines: ["working"], hang: true };
  const handle = await runtime.run(spec());
  const lines = collect(handle);
  const waiting = handle.wait();
  await until(() => fake.container(RUN)?.lines.length);
  await new Promise((resolve) => setTimeout(resolve, 100));
  handle.detach();
  assert.deepEqual(await waiting, { exitCode: null, oomKilled: false, detached: true });
  await lines;
  assert.equal(fake.container(RUN).running, true);
});

test("images: a digest is pulled only when missing, a tag is always pulled, a local image never; the digest that ran is recorded", async (t) => {
  assert.deepEqual(parseImageRef("ghcr.io/a/b:1.2@sha256:x"), { repo: "ghcr.io/a/b", tag: "1.2", digest: "sha256:x" });
  assert.deepEqual(parseImageRef("localhost:5000/app"), { repo: "localhost:5000/app", tag: null, digest: null });
  assert.equal(familiarRepo("docker.io/library/busybox"), "busybox");
  assert.equal(digestFor("busybox:1.37", { Id: "sha256:id", RepoDigests: ["busybox@sha256:abc"] }), "sha256:abc");
  assert.equal(digestFor("docker.io/library/busybox:1.37", { Id: "sha256:id", RepoDigests: ["busybox@sha256:abc"] }), "sha256:abc");
  assert.equal(digestFor("wingfoil-forecast:local", { Id: "sha256:local", RepoDigests: [] }), "sha256:local");

  const { fake, runtime } = await setup(t);
  const pinned = "ghcr.io/sprintengine/worker@sha256:1111";
  assert.equal(await runtime.hasImage(pinned), false);
  const pulled = await runtime.pull(pinned);
  assert.equal(pulled.digest, "sha256:1111");
  assert.equal(await runtime.hasImage(pinned), true, "now it is here: no second pull");
  assert.deepEqual(fake.calls.filter((call) => call.argv[0] === "pull").map((call) => call.argv), [["pull", "--quiet", pinned]]);

  const tag = "ghcr.io/sprintengine/worker:production";
  fake.addImage(tag);
  assert.equal(await runtime.hasImage(tag), false, "a tag is resolved by pulling");
  assert.match((await runtime.pull(tag)).digest, /^sha256:[0-9a-f]{64}$/);
  fake.pullFail = "dial tcp: lookup ghcr.io: no such host";
  const offline = await runtime.pull(tag);
  assert.equal(offline.stale, true, "an unreachable registry runs the tag already here");
  await assert.rejects(runtime.pull("ghcr.io/sprintengine/other:1"), /docker pull failed: Error response from daemon: dial tcp/);
  fake.pullFail = null;

  assert.equal(await runtime.hasImage("wingfoil-forecast:local"), false);
  fake.addImage("wingfoil-forecast:local", { id: "sha256:0123" });
  assert.equal(await runtime.hasImage("wingfoil-forecast:local"), true);
  assert.equal(await runtime.imageDigest("wingfoil-forecast:local"), "sha256:0123");
});

test("a registry secret logs in for that pull only: password on stdin, a throwaway docker config, deleted after", async (t) => {
  const { fake, runtime } = await setup(t);
  fake.requireLogin = true;
  const password = "ghp_fakeReadOnlyToken000000000000000000";
  const reference = "ghcr.io/sprintengine/private@sha256:2222";
  await assert.rejects(runtime.pull(reference), /requires authentication/);
  await runtime.pull(reference, { auth: { server: "ghcr.io", username: "sprintengine-bot", password } });
  const login = fake.calls.find((call) => call.argv[0] === "login");
  assert.deepEqual(login.argv, ["login", "--username", "sprintengine-bot", "--password-stdin", "ghcr.io"]);
  assert.equal(login.stdin, password);
  for (const call of fake.calls) assert.ok(!call.argv.join(" ").includes(password), `${call.argv[0]}: never in argv`);
  const config = login.env.DOCKER_CONFIG;
  assert.ok(config && !config.startsWith(process.env.HOME ?? "/nonexistent"), config);
  const pull = fake.calls.find((call) => call.argv[0] === "pull" && call.env.DOCKER_CONFIG === config);
  assert.ok(pull, "the pull used the login");
  assert.equal(fake.calls.at(-1).argv[0], "logout");
  await assert.rejects(stat(config), /ENOENT/, "the throwaway config is gone");
});

test("the image cache keeps the 3 most recently used digests per repository it pulled, and never the owner's", async (t) => {
  assert.deepEqual(pruneCandidates({ "ghcr.io/a": [1, 2, 3, 4, 5].map((n) => ({ digest: `sha256:${n}`, usedAt: n })) }, { inUse: new Set(["sha256:1"]) })
    .map((entry) => entry.reference), ["ghcr.io/a@sha256:2"]);
  const { fake, runtime, state, events } = await setup(t);
  fake.addImage("ghcr.io/owner/own@sha256:9999");
  await runtime.run({ ...spec({ image: "ghcr.io/owner/own@sha256:9999" }), runId: "r_01J0000000000000000000000B" });
  for (let index = 1; index <= 5; index += 1) await runtime.pull(`ghcr.io/sprintengine/worker@sha256:000${index}`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const { pruned } = await runtime.idle();
  assert.deepEqual(pruned.sort(), ["ghcr.io/sprintengine/worker@sha256:0001", "ghcr.io/sprintengine/worker@sha256:0002"]);
  assert.deepEqual(fake.removedImages.sort(), pruned);
  assert.ok(fake.findImage("ghcr.io/owner/own@sha256:9999"), "an image the agent did not pull stays");
  const record = await new ImageRecord(state).read();
  assert.deepEqual(record["ghcr.io/sprintengine/worker"].map((entry) => entry.digest), ["sha256:0003", "sha256:0004", "sha256:0005"]);
  assert.equal(record["ghcr.io/owner/own"], undefined);
  assert.ok(events.some((event) => event.event === "images_pruned"));
  assert.deepEqual((await runtime.idle()).pruned, []);
});

test("facts come from the Engine; doctor's self-test runs hello-world under the same restrictions; DOCKER_HOST names the host", async (t) => {
  const { fake, runtime } = await setup(t);
  const facts = await runtime.facts();
  assert.deepEqual([facts.kind, facts.version, facts.cpus, facts.memoryMiB, facts.vm], ["docker", "29.0.0-fake", 4, 8192, null]);
  assert.ok(facts.diskFreeMiB > 0);
  fake.addImage("hello-world");
  assert.equal(await runtime.selfTest(), "Hello from Docker!");
  const call = fake.calls.at(-1).argv;
  for (const flag of ["--rm", "--cap-drop", "--network", "none", "--security-opt", "no-new-privileges"]) assert.ok(call.includes(flag), flag);

  const fromEnvironment = new DockerCliRuntime({ env: fakeEnv({ DOCKER_HOST: fake.host }) });
  await fromEnvironment.ensureReady();
  assert.equal(fromEnvironment.host, fake.host, "without a configured host, DOCKER_HOST (else the docker context) names it");
  assert.equal(socketPathOf("unix:///var/run/docker.sock"), "/var/run/docker.sock");
  assert.throws(() => socketPathOf("tcp://10.0.0.1:2375"), /not a unix socket/);
  assert.equal(lastLine('x\ntime="t" level=fatal msg="error starting vm: \\"vz\\" failed"\n'), 'error starting vm: "vz" failed');
  fake.down = true;
  await assert.rejects(runtime.ensureReady(), /not reachable/);
});

// A fake Docker for the agent's unit tests: the Engine API on a unix socket
// (ping, info, containers: list/inspect/wait/stats, images: inspect) and the
// other end of test/fake-bin/docker, which forwards every `docker` command
// here with its argv and environment. Containers follow scripts the test
// gives per image; the test can also print lines, finish them, change their
// stats, or break their log stream.
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

export const FAKE_BIN = path.join(import.meta.dirname, "fake-bin");
/** The environment `docker`/`colima` run with in tests: the fakes first on PATH. */
export function fakeEnv(extra = {}) {
  return { PATH: `${FAKE_BIN}:${process.env.PATH}`, HOME: process.env.HOME, TMPDIR: os.tmpdir(), ...extra };
}

/** Options of `docker run` that take a value (everything else that starts with - is a flag). */
const VALUE_OPTIONS = new Set(["--name", "--label", "--memory", "--memory-swap", "--cpus", "--cpu-shares", "--pids-limit", "--security-opt",
  "--cap-drop", "--network", "--log-driver", "--log-opt", "-e", "--entrypoint", "--cgroup-parent"]);

function hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

function nanos(ms, sequence) {
  return `${new Date(ms).toISOString().slice(0, 19)}.${String((ms % 1000) * 1_000_000 + sequence).padStart(9, "0")}Z`;
}

/** argv, environment and stdin from the fake CLI's body (NUL-separated, an empty field between the parts). */
function parseCliBody(buffer) {
  const text = buffer.toString("utf8");
  const fields = text.split("\0");
  const argv = [];
  let index = 0;
  while (index < fields.length && fields[index] !== "") argv.push(fields[index++]);
  index += 1;
  const env = {};
  while (index < fields.length && fields[index] !== "") {
    const entry = fields[index++];
    const equals = entry.indexOf("=");
    if (equals > 0) env[entry.slice(0, equals)] = entry.slice(equals + 1);
  }
  index += 1;
  return { argv, env, stdin: fields.slice(index).join("\0") };
}

/** `docker run` argv → its parts, as Docker would read them. */
export function parseRunArgs(argv, env) {
  const run = { flags: [], labels: {}, env: [], options: {}, image: null, command: [], entrypoint: null };
  let index = 1;
  for (; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("-")) break;
    if (!VALUE_OPTIONS.has(argument)) {
      run.flags.push(argument);
      continue;
    }
    const value = argv[++index];
    if (argument === "--label") {
      const equals = value.indexOf("=");
      run.labels[value.slice(0, equals)] = value.slice(equals + 1);
    } else if (argument === "-e") {
      if (value.includes("=")) run.env.push(value);
      else if (value in env) run.env.push(`${value}=${env[value]}`);
    } else if (argument === "--entrypoint") run.entrypoint = value;
    else (run.options[argument] ??= []).push(value);
  }
  run.image = argv[index];
  run.command = argv.slice(index + 1);
  return run;
}

export async function startFakeDocker(t, { colimaDir = null, profile = null, socketPath = null } = {}) {
  const dir = socketPath ? null : await mkdtemp(path.join(os.tmpdir(), "hcd-"));
  const socket = socketPath ?? path.join(dir, "docker.sock");
  const fake = {
    socketPath: socket,
    host: `unix://${socket}`,
    calls: [],
    containers: new Map(),
    images: new Map(),
    scripts: {},
    pullFail: null,
    pullDelayMs: 0,
    logins: [],
    removedImages: [],
    breakLogsOnce: new Set(),
    down: false,
    sequence: 0,
  };
  const listeners = new Set();
  const notify = () => {
    for (const wake of [...listeners]) wake();
  };
  const changed = () => new Promise((resolve) => {
    const wake = () => {
      listeners.delete(wake);
      resolve();
    };
    listeners.add(wake);
  });

  /** Whether "the VM" is up: always, unless tied to a fake colima profile that is not Running. */
  async function up() {
    if (fake.down) return false;
    if (!colimaDir) return true;
    const text = await readFile(path.join(colimaDir, `${profile}.profile`), "utf8").catch(() => "");
    return text.includes("\"status\":\"Running\"");
  }

  fake.addImage = (reference, { id = `sha256:${hex(`id:${reference}`)}`, repoDigests = null } = {}) => {
    const at = reference.indexOf("@");
    const digests = repoDigests ?? (at >= 0 ? [`${reference.slice(0, at).replace(/:[^/:]+$/, "")}@${reference.slice(at + 1)}`] : []);
    const image = { Id: id, RepoTags: at >= 0 ? [] : [reference], RepoDigests: digests };
    fake.images.set(reference, image);
    for (const entry of digests) fake.images.set(entry, image);
    return image;
  };

  fake.findImage = (reference) => {
    const normal = (text) => text.replace(/^docker\.io\//, "").replace(/^library\//, "");
    return fake.images.get(reference) ?? fake.images.get(normal(reference)) ?? null;
  };

  fake.print = (id, text, at = Date.now()) => {
    const container = fake.container(id);
    container.lines.push({ at: nanos(at, fake.sequence++), text });
    notify();
  };

  fake.finish = (id, { exitCode = 0, oomKilled = false } = {}) => {
    const container = fake.container(id);
    if (!container.running) return;
    Object.assign(container, { running: false, exitCode, oomKilled });
    notify();
  };

  fake.container = (idOrRun) => fake.containers.get(idOrRun)
    ?? [...fake.containers.values()].find((container) => container.labels["dev.homecompute.run"] === idOrRun || container.name === idOrRun);

  /** Runs the image's script: lines (strings or {text, delayMs}), then an exit unless `hang`. */
  async function play(container, script) {
    for (const step of script.lines ?? []) {
      if (typeof step === "object" && step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
      if (!container.running) return;
      fake.print(container.Id, typeof step === "string" ? step : step.text);
    }
    if (script.stats) container.stats = { ...container.stats, ...script.stats };
    if (script.hang) return;
    if (script.exitAfterMs) await new Promise((resolve) => setTimeout(resolve, script.exitAfterMs));
    fake.finish(container.Id, { exitCode: script.exitCode ?? 0, oomKilled: Boolean(script.oomKilled) });
  }

  function answer(response, { status = 200, stdout = "", stderr = "", exitCode = 0 } = {}) {
    response.writeHead(status, {
      "content-type": "text/plain", "x-exit-code": String(exitCode),
      ...(stderr ? { "x-stderr": Buffer.from(stderr).toString("base64") } : {}),
    });
    response.end(stdout);
  }

  async function cli(request, response) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const { argv, env, stdin } = parseCliBody(Buffer.concat(chunks));
    const call = { argv, env, stdin: argv[0] === "login" ? stdin : undefined };
    fake.calls.push(call);
    const [command] = argv;
    if (command === "context") return answer(response, { stdout: `${fake.host}\n` });
    if (!await up()) return answer(response, { exitCode: 1, stderr: `Cannot connect to the Docker daemon at ${fake.host}. Is the docker daemon running?` });
    if (command === "run") {
      const run = parseRunArgs(argv, env);
      call.run = run;
      if (!fake.findImage(run.image)) return answer(response, { exitCode: 125, stderr: `Unable to find image '${run.image}' locally` });
      if (run.flags.includes("--rm")) return answer(response, { stdout: "\nHello from Docker!\nThis message shows that your installation appears to be working correctly.\n" });
      const name = run.options["--name"]?.[0];
      if (name && fake.container(name)) return answer(response, { exitCode: 125, stderr: `Conflict. The container name "/${name}" is already in use` });
      const id = hex(`container:${randomBytes(8).toString("hex")}`);
      const memory = run.options["--memory"]?.[0];
      const container = {
        Id: id, name, labels: run.labels, env: run.env, image: run.image, run, running: true, exitCode: null, oomKilled: false, lines: [],
        startedAt: new Date().toISOString(), stats: { usage: 0, inactive: 0, limit: memory ? Number.parseInt(memory, 10) * 1048576 : 8 * 1073741824, cpuNs: 0 },
      };
      fake.containers.set(id, container);
      play(container, typeof fake.scripts[run.image] === "function" ? fake.scripts[run.image](run) : fake.scripts[run.image] ?? { lines: ["hello"], exitCode: 0 });
      return answer(response, { stdout: `${id}\n` });
    }
    if (command === "pull") {
      const reference = argv.at(-1);
      call.pull = reference;
      if (fake.pullDelayMs) await new Promise((resolve) => setTimeout(resolve, fake.pullDelayMs));
      if (fake.pullFail) return answer(response, { exitCode: 1, stderr: `Error response from daemon: ${fake.pullFail}` });
      if (fake.requireLogin && !(env.DOCKER_CONFIG && fake.logins.some((login) => login.config === env.DOCKER_CONFIG))) {
        return answer(response, { exitCode: 1, stderr: "Error response from daemon: denied: requires authentication" });
      }
      if (!reference.includes("@")) {
        fake.addImage(reference, { repoDigests: [`${reference.replace(/:[^/:]+$/, "")}@sha256:${hex(`tag:${reference}:${fake.tagVersion ?? 1}`)}`] });
      } else fake.addImage(reference);
      return answer(response, { stdout: `${reference}\n` });
    }
    if (command === "login") {
      fake.logins.push({ argv, password: stdin, config: env.DOCKER_CONFIG });
      return answer(response, { stdout: "Login Succeeded\n" });
    }
    if (command === "logout") return answer(response, { stdout: "Removing login credentials\n" });
    if (command === "stop" || command === "kill") {
      const container = fake.container(argv.at(-1));
      if (!container) return answer(response, { exitCode: 1, stderr: `Error response from daemon: No such container: ${argv.at(-1)}` });
      const script = fake.scripts[container.image];
      fake.finish(container.Id, { exitCode: command === "kill" || script?.ignoreStop ? 137 : 143 });
      return answer(response, { stdout: `${argv.at(-1)}\n` });
    }
    if (command === "rm") {
      const container = fake.container(argv.at(-1));
      if (!container) return answer(response, { exitCode: 1, stderr: `Error response from daemon: No such container: ${argv.at(-1)}` });
      if (container.running && !argv.includes("-f")) return answer(response, { exitCode: 1, stderr: "Error response from daemon: cannot remove container: container is running" });
      fake.containers.delete(container.Id);
      notify();
      return answer(response, { stdout: `${argv.at(-1)}\n` });
    }
    if (command === "image" && argv[1] === "rm") {
      const reference = argv.at(-1);
      const image = fake.findImage(reference);
      if (!image) return answer(response, { exitCode: 1, stderr: `Error response from daemon: No such image: ${reference}` });
      for (const [key, value] of [...fake.images]) if (value === image) fake.images.delete(key);
      fake.removedImages.push(reference);
      return answer(response, { stdout: `Untagged: ${reference}\n` });
    }
    return answer(response, { exitCode: 1, stderr: `fake docker: unknown command ${command}` });
  }

  async function logs(request, response, id, since) {
    const container = fake.container(id);
    response.writeHead(200, { "content-type": "text/plain" });
    if (!container) {
      response.end("Error response from daemon: No such container\n");
      return;
    }
    let index = 0;
    const broken = fake.breakLogsOnce.has(container.labels["dev.homecompute.run"]);
    for (;;) {
      while (index < container.lines.length) {
        const line = container.lines[index++];
        if (since && line.at < since) continue;
        response.write(`${line.at} ${line.text}\n`);
        if (broken && index === 2) {
          // The stream breaks mid-run (a daemon restart): docker logs ends while the container still runs.
          fake.breakLogsOnce.delete(container.labels["dev.homecompute.run"]);
          response.end();
          return;
        }
      }
      if (!container.running || !fake.containers.has(container.Id)) break;
      await changed();
    }
    response.end();
  }

  function json(response, status, body) {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  }

  function inspectOf(container) {
    return {
      Id: container.Id, Name: `/${container.name}`,
      State: { Running: container.running, ExitCode: container.exitCode ?? 0, OOMKilled: container.oomKilled, StartedAt: container.startedAt },
      Config: { Env: container.env, Labels: container.labels, Image: container.image },
    };
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://docker");
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/fake/cli") return cli(request, response);
    if (parts[0] === "fake" && parts[1] === "logs") return logs(request, response, parts[2], url.searchParams.get("since"));
    if (!await up()) {
      request.socket.destroy();
      return;
    }
    fake.apiCalls = (fake.apiCalls ?? 0) + 1;
    if (url.pathname === "/_ping") {
      response.writeHead(200, { "content-type": "text/plain" });
      return response.end("OK");
    }
    if (url.pathname === "/info") {
      return json(response, 200, { ServerVersion: "29.0.0-fake", NCPU: 4, MemTotal: 8 * 1073741824, DockerRootDir: os.tmpdir(), OperatingSystem: "Fake Linux" });
    }
    if (url.pathname === "/containers/json") {
      const filters = JSON.parse(url.searchParams.get("filters") ?? "{}");
      const [label] = filters.label ?? [];
      const list = [...fake.containers.values()].filter((container) => !label || label in container.labels);
      return json(response, 200, list.map((container) => ({ Id: container.Id, Labels: container.labels, State: container.running ? "running" : "exited" })));
    }
    if (parts[0] === "containers") {
      const container = fake.container(decodeURIComponent(parts[1]));
      if (!container) return json(response, 404, { message: `No such container: ${parts[1]}` });
      if (parts[2] === "json") return json(response, 200, inspectOf(container));
      if (parts[2] === "wait") {
        while (container.running) await changed();
        return json(response, 200, { StatusCode: container.exitCode });
      }
      if (parts[2] === "stats") {
        const { usage, inactive, limit, cpuNs } = container.stats;
        return json(response, 200, {
          memory_stats: container.running ? { usage, limit, stats: { inactive_file: inactive } } : {},
          cpu_stats: { cpu_usage: { total_usage: cpuNs }, online_cpus: 1 },
        });
      }
    }
    if (parts[0] === "images" && parts.at(-1) === "json") {
      const reference = decodeURIComponent(url.pathname.slice("/images/".length, -"/json".length));
      const image = fake.findImage(reference);
      return image ? json(response, 200, image) : json(response, 404, { message: `No such image: ${reference}` });
    }
    return json(response, 404, { message: `fake docker: no route ${request.method} ${url.pathname}` });
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  fake.close = async () => {
    for (const container of fake.containers.values()) container.running = false;
    notify();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    if (dir) await rm(dir, { recursive: true, force: true });
  };
  t?.after?.(() => fake.close());
  return fake;
}

/** A directory for the fake colima's state. */
export async function fakeColimaDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hcc-"));
  await writeFile(path.join(dir, ".fake-colima"), "");
  t?.after?.(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** The fake colima's calls, one argv string per call. */
export async function colimaCalls(dir) {
  return (await readFile(path.join(dir, "calls"), "utf8").catch(() => "")).split("\n").filter(Boolean);
}

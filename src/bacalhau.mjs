import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { resolveTemplate } from "./config.mjs";

const execFile = promisify(execFileCallback);
const TERMINAL_STATES = new Set(["Completed", "Failed", "Stopped", "Cancelled", "Canceled"]);

function environmentVariables(job, environment, redact) {
  const names = [...new Set([...(job.task.passEnv ?? []), ...(job.task.requiredEnv ?? [])])];
  const required = new Set(job.task.requiredEnv ?? []);
  return names.flatMap((name) => {
    const value = environment[name];
    if ((value === undefined || value === "") && required.has(name)) throw new Error(`${job.id} requires ${name}`);
    if (value === undefined || value === "") return [];
    return [`${name}=${redact ? "<redacted>" : value}`];
  });
}

export function buildJobSpec(job, environment = process.env, { redact = false } = {}) {
  const image = resolveTemplate(job.task.image, environment, `${job.id}.task.image`);
  const task = {
    Name: "main",
    Engine: {
      Type: "docker",
      Params: {
        Image: image,
        Parameters: Array.from(job.task.parameters ?? [], String),
        EnvironmentVariables: environmentVariables(job, environment, redact),
      },
    },
    Publisher: { Type: "noop" },
    Resources: {
      CPU: job.task.resources?.cpu ?? "1",
      Memory: job.task.resources?.memory ?? "2Gb",
      Disk: job.task.resources?.disk ?? "2Gb",
      GPU: String(job.task.resources?.gpu ?? 0),
    },
    Network: {
      Type: job.task.network?.type ?? "Full",
      ...(job.task.network?.domains ? { Domains: job.task.network.domains } : {}),
    },
    Timeouts: {
      QueueTimeout: Math.floor((job.task.timeouts?.queueSeconds ?? 3_600)),
      TotalTimeout: Math.floor((job.task.timeouts?.totalSeconds ?? 7_200)),
    },
  };
  return {
    Name: job.id,
    Namespace: job.namespace ?? "home-compute",
    Type: "batch",
    Count: 1,
    Labels: { "home-compute.job": job.id, ...(job.labels ?? {}) },
    ...(job.constraints ? { Constraints: job.constraints } : {}),
    Tasks: [task],
  };
}

function findState(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return undefined;
  if (typeof value.State === "string") return value.State;
  if (typeof value.state === "string") return value.state;
  for (const key of ["Job", "job", "Result", "result"]) {
    const state = findState(value[key], depth + 1);
    if (state) return state;
  }
  return undefined;
}

export class BacalhauClient {
  constructor({ binary = "bacalhau", apiHost, apiPort, execute = execFile } = {}) {
    this.binary = binary;
    this.apiHost = apiHost;
    this.apiPort = apiPort;
    this.execute = execute;
  }

  commonArgs() {
    return [
      ...(this.apiHost ? ["--api-host", this.apiHost] : []),
      ...(this.apiPort ? ["--api-port", String(this.apiPort)] : []),
    ];
  }

  async submit(spec) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "home-compute-"));
    const filename = path.join(directory, "job.json");
    try {
      await writeFile(filename, `${JSON.stringify(spec)}\n`, { mode: 0o600 });
      const { stdout } = await this.execute(this.binary, ["job", "run", filename, "--id-only", "--wait=false", ...this.commonArgs()], {
        maxBuffer: 10 * 1024 * 1024,
      });
      const match = stdout.match(/j-[a-zA-Z0-9-]+/);
      if (!match) throw new Error(`Bacalhau did not return a job id: ${stdout.trim()}`);
      return match[0];
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async describe(jobId) {
    const { stdout } = await this.execute(this.binary, ["job", "describe", jobId, "--output", "json", ...this.commonArgs()], {
      maxBuffer: 20 * 1024 * 1024,
    });
    const result = JSON.parse(stdout);
    const state = findState(result);
    if (!state) throw new Error(`Could not determine state of Bacalhau job ${jobId}`);
    return { state, terminal: TERMINAL_STATES.has(state), raw: result };
  }

  async nodes() {
    const { stdout } = await this.execute(this.binary, ["node", "list", "--output", "json", ...this.commonArgs()], {
      maxBuffer: 20 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  }

  async version() {
    const { stdout } = await this.execute(this.binary, ["version"], { maxBuffer: 1024 * 1024 });
    return stdout.trim();
  }
}

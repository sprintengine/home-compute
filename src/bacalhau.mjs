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

/**
 * Bacalhau treats a name it already knows as an update to that job, and an
 * update whose spec has not changed as no work at all, so submitting a
 * logical job under its own id would run it once and then never again. Each
 * submission gets its own name; the `home-compute.job` label keeps the link.
 */
export function submissionName(job, now = new Date()) {
  return `${job.id}-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "z").toLowerCase()}`;
}

export function buildJobSpec(job, environment = process.env, { redact = false, now = new Date() } = {}) {
  const image = resolveTemplate(job.task.image, environment, `${job.id}.task.image`);
  const task = {
    Name: "main",
    Engine: {
      Type: "docker",
      Params: {
        Image: image,
        ...(job.task.entrypoint ? { Entrypoint: Array.from(job.task.entrypoint, String) } : {}),
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
    Name: submissionName(job, now),
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
  // Bacalhau 1.9 nests it: `"State": {"StateType": "Completed", "Message": ...}`.
  if (typeof value.State?.StateType === "string") return value.State.StateType;
  for (const key of ["Job", "job", "Result", "result"]) {
    const state = findState(value[key], depth + 1);
    if (state) return state;
  }
  return undefined;
}

/**
 * The newest execution's result. Bacalhau calls a batch job Completed when its
 * container ran to the end, whatever it exited with, so the exit code is the
 * only place a workload's own failure shows.
 */
function latestRun(result) {
  const executions = Array.isArray(result?.Executions?.Items) ? result.Executions.Items : [];
  const execution = executions
    .filter((candidate) => candidate?.RunOutput)
    .sort((a, b) => (b.JobVersion ?? 0) - (a.JobVersion ?? 0) || (b.ModifyTime ?? 0) - (a.ModifyTime ?? 0))[0];
  if (!execution) return {};
  const output = execution.RunOutput;
  return {
    executionId: execution.ID,
    exitCode: Number.isInteger(output.ExitCode) ? output.ExitCode : undefined,
    stdout: output.Stdout ?? output.stdout ?? "",
    stderr: output.stderr ?? output.Stderr ?? "",
    truncated: Boolean(output.StdoutTruncated || output.StderrTruncated),
    errorMessage: output.ErrorMsg || undefined,
  };
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
    return { state, terminal: TERMINAL_STATES.has(state), ...latestRun(result), raw: result };
  }

  /** The job's whole log, for when describe's copy of the output was truncated. */
  async logs(jobId) {
    const { stdout } = await this.execute(this.binary, ["job", "logs", jobId, ...this.commonArgs()], {
      maxBuffer: 50 * 1024 * 1024,
    });
    return stdout;
  }

  async nodes() {
    const { stdout } = await this.execute(this.binary, ["node", "list", "--output", "json", ...this.commonArgs()], {
      maxBuffer: 20 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  }

  async version() {
    const { stdout } = await this.execute(this.binary, ["version", "--output", "json", ...this.commonArgs()], {
      maxBuffer: 1024 * 1024,
    });
    try {
      const { clientVersion, serverVersion } = JSON.parse(stdout);
      return `client ${clientVersion?.GitVersion ?? "unknown"}, server ${serverVersion?.GitVersion ?? "unreachable"}`;
    } catch {
      return stdout.trim();
    }
  }
}

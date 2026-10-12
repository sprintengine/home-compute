#!/usr/bin/env node
// A stand-in for the `bacalhau` CLI, for tests and a local demo controller.
// It keeps each job as $FAKE_BACALHAU_DIR/<id>.json:
//   { "state": "Running", "exitCode": 0, "stdout": "...", "stderr": "...",
//     "log": "... (what `job logs` prints; stdout + stderr if absent)",
//     "submittedAt": ISO, "startedAt": ISO, "finishedAt": ISO }
// Edit a file to move a job on (Running -> Completed, say).
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const directory = process.env.FAKE_BACALHAU_DIR;
if (!directory) {
  console.error("FAKE_BACALHAU_DIR is not set");
  process.exit(2);
}
mkdirSync(directory, { recursive: true });
const [group, command, target] = process.argv.slice(2);
const file = (id) => path.join(directory, `${path.basename(id)}.json`);
const load = (id) => {
  try {
    return JSON.parse(readFileSync(file(id), "utf8"));
  } catch {
    console.error(`Error: job not found: ${id}`);
    process.exit(1);
  }
};

if (group === "job" && command === "run") {
  const spec = JSON.parse(readFileSync(target, "utf8"));
  const id = `j-${randomUUID()}`;
  const now = new Date().toISOString();
  writeFileSync(file(id), JSON.stringify({ spec, state: "Running", submittedAt: now, startedAt: now, auto: true }, null, 1));
  console.log(id);
} else if (group === "job" && command === "describe") {
  const job = load(target);
  // FAKE_BACALHAU_FINISH_AFTER=seconds: a job submitted through it finishes by itself, finding nothing new.
  const after = Number(process.env.FAKE_BACALHAU_FINISH_AFTER);
  if (after && job.auto && !job.finishedAt && Date.now() - Date.parse(job.submittedAt) > after * 1000) {
    const model = job.spec?.Labels?.models ?? "model";
    Object.assign(job, {
      state: "Completed",
      exitCode: 0,
      finishedAt: new Date().toISOString(),
      stdout: `${model}: the published run is current; nothing to download.\n${JSON.stringify({
        event: "forecast_unchanged", model, run: "2026101112", seconds: 2, peakMemoryMb: 180, cpuSeconds: 1.1,
      })}\n`,
    });
    writeFileSync(file(target), JSON.stringify(job, null, 1));
  }
  const items = [{ Type: "JobLevel", Time: job.submittedAt, Event: { Topic: "Submission", Message: "Job submitted" } }];
  if (job.startedAt) items.push({ Type: "ExecutionLevel", Time: job.startedAt, Event: { Topic: "Execution", Message: "Running" } });
  if (job.finishedAt) items.push({ Type: "JobLevel", Time: job.finishedAt, Event: { Topic: "State Update", Message: job.state, Details: { NewState: job.state } } });
  console.log(JSON.stringify({
    Job: { ID: target, State: { StateType: job.state }, Labels: job.spec?.Labels ?? {} },
    History: { Items: items },
    Executions: { Items: job.state === "Queued" ? [] : [{
      ID: `e-${target}`,
      JobVersion: 1,
      RunOutput: { Stdout: job.stdout ?? "", stderr: job.stderr ?? "", ExitCode: job.exitCode ?? 0, StdoutTruncated: Boolean(job.truncated) },
    }] },
  }));
} else if (group === "job" && command === "logs") {
  const job = load(target);
  process.stdout.write(job.log ?? `${job.stdout ?? ""}${job.stderr ?? ""}`);
} else if (group === "node" && command === "list") {
  console.log(JSON.stringify([{ Info: { NodeID: "n-fake-mac-mini" }, Connection: "CONNECTED" }]));
} else if (group === "version") {
  console.log(JSON.stringify({ clientVersion: { GitVersion: "v1.9.4-fake" }, serverVersion: { GitVersion: "v1.9.4-fake" } }));
} else {
  console.error(`fake bacalhau: unsupported ${process.argv.slice(2).join(" ")}`);
  process.exit(2);
}

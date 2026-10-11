import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BacalhauClient, buildJobSpec } from "../src/bacalhau.mjs";

const job = {
  id: "wingfoil-forecast",
  schedule: { every: "15m" },
  task: {
    image: "${IMAGE}",
    parameters: ["--models", "icon-eu"],
    requiredEnv: ["S3_BUCKET", "AWS_SECRET_ACCESS_KEY"],
    passEnv: ["S3_PREFIX"],
    resources: { cpu: "2", memory: "4Gb", disk: "4Gb" },
    network: { type: "Full" },
  },
};

test("buildJobSpec translates a small definition and redacts inspection output", () => {
  const environment = {
    IMAGE: "registry.example/wingfoil@sha256:abc",
    S3_BUCKET: "forecast",
    AWS_SECRET_ACCESS_KEY: "secret",
    S3_PREFIX: "prod",
  };
  const spec = buildJobSpec(job, environment, { redact: true });
  assert.equal(spec.Type, "batch");
  assert.equal(spec.Count, 1);
  assert.equal(spec.Tasks[0].Engine.Params.Image, environment.IMAGE);
  assert.deepEqual(spec.Tasks[0].Engine.Params.Parameters, ["--models", "icon-eu"]);
  assert.deepEqual(spec.Tasks[0].Engine.Params.EnvironmentVariables, [
    "S3_PREFIX=<redacted>",
    "S3_BUCKET=<redacted>",
    "AWS_SECRET_ACCESS_KEY=<redacted>",
  ]);
  assert.equal(spec.Tasks[0].Resources.Memory, "4Gb");
  assert.throws(() => buildJobSpec(job, { IMAGE: "image", S3_BUCKET: "bucket" }), /AWS_SECRET_ACCESS_KEY/);
});

test("BacalhauClient submits a private temporary JSON spec and extracts its job ID", async () => {
  let submitted;
  const execute = async (binary, args) => {
    assert.equal(binary, "bacalhau-test");
    assert.deepEqual(args.slice(0, 2), ["job", "run"]);
    submitted = JSON.parse(await readFile(args[2], "utf8"));
    return { stdout: "j-1234-abcd\n", stderr: "" };
  };
  const client = new BacalhauClient({ binary: "bacalhau-test", execute });
  assert.equal(await client.submit({ Name: "test" }), "j-1234-abcd");
  assert.deepEqual(submitted, { Name: "test" });
});

test("BacalhauClient recognises terminal and active job states", async () => {
  const outputs = [
    JSON.stringify({ Job: { State: "Running" } }),
    JSON.stringify({ Job: { State: "Completed" } }),
  ];
  const client = new BacalhauClient({ execute: async () => ({ stdout: outputs.shift(), stderr: "" }) });
  assert.deepEqual(await client.describe("j-running").then(({ state, terminal }) => ({ state, terminal })), {
    state: "Running",
    terminal: false,
  });
  assert.deepEqual(await client.describe("j-complete").then(({ state, terminal }) => ({ state, terminal })), {
    state: "Completed",
    terminal: true,
  });
});

test("each submission is named apart so Bacalhau runs it again", () => {
  const first = buildJobSpec(job, { IMAGE: "i", S3_BUCKET: "b", AWS_SECRET_ACCESS_KEY: "s" }, { now: new Date("2026-10-08T10:00:00.123Z") });
  const second = buildJobSpec(job, { IMAGE: "i", S3_BUCKET: "b", AWS_SECRET_ACCESS_KEY: "s" }, { now: new Date("2026-10-08T11:00:00.000Z") });
  assert.equal(first.Name, "wingfoil-forecast-20261008t100000z");
  assert.notEqual(first.Name, second.Name);
  assert.equal(first.Labels["home-compute.job"], "wingfoil-forecast");
});

test("describe reads the newest execution's exit code and output", async () => {
  const execute = async () => ({
    stdout: JSON.stringify({
      Job: { State: { StateType: "Completed" } },
      Executions: { Items: [
        { ID: "e-old", JobVersion: 1, RunOutput: { ExitCode: 0, Stdout: "old" } },
        { ID: "e-new", JobVersion: 2, RunOutput: { ExitCode: 2, Stdout: "", stderr: "bad", StdoutTruncated: false } },
      ] },
    }),
  });
  const status = await new BacalhauClient({ execute }).describe("j-1");
  assert.equal(status.exitCode, 2);
  assert.equal(status.executionId, "e-new");
  assert.equal(status.stderr, "bad");
  assert.equal(status.terminal, true);
});

test("an entrypoint replaces the image's own when a job names one", () => {
  const environment = { IMAGE: "i", S3_BUCKET: "b", AWS_SECRET_ACCESS_KEY: "s" };
  assert.equal(buildJobSpec(job, environment).Tasks[0].Engine.Params.Entrypoint, undefined);
  const sweep = { ...job, task: { ...job.task, entrypoint: ["sh", "-c", "prune"] } };
  assert.deepEqual(buildJobSpec(sweep, environment).Tasks[0].Engine.Params.Entrypoint, ["sh", "-c", "prune"]);
});

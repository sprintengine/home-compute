import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);
const cli = path.resolve(import.meta.dirname, "../src/cli.mjs");

test("CLI submits the configured job and persists its Bacalhau id", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "home-compute-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, "fake-bacalhau");
  const configFile = path.join(directory, "config.json");
  const stateFile = path.join(directory, "state.json");
  await writeFile(binary, "#!/bin/sh\necho j-integration-123\n");
  await chmod(binary, 0o700);
  await writeFile(configFile, JSON.stringify({
    stateFile,
    bacalhau: { binary },
    jobs: [{
      id: "forecast",
      schedule: { every: "15m" },
      task: { image: "example/forecast", parameters: ["--step", "3"] },
    }],
  }));

  const { stdout } = await execFile(process.execPath, [cli, "run", "forecast", "--config", configFile]);
  assert.match(stdout, /"bacalhauJobId":"j-integration-123"/);
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(state.jobs.forecast.activeJobId, "j-integration-123");
  assert.equal(state.version, 1);
});

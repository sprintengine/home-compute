// Which real Docker the integration tests may use, and the fixture image.
//
// - HC_TEST_DOCKER_HOST=unix:///… names one explicitly (on a Mac, a
//   throwaway Colima profile: never the owner's own VM or docker context);
// - on Linux (CI's ubuntu-latest) DOCKER_HOST or /var/run/docker.sock;
// - otherwise, or when it does not answer, the tests are skipped, unless
//   HC_REQUIRE_DOCKER_TESTS=1 (CI), which makes that a failure instead.
import path from "node:path";
import { Engine, socketPathOf } from "../src/runtime/engine.mjs";
import { runCommand } from "../src/runtime/process.mjs";

export const FIXTURE_IMAGE = "hc-agent-fixture:test";
const FIXTURE_DIR = path.join(import.meta.dirname, "fixture");

/** `{host, skip}`: the Docker to use, or why the tests are skipped. */
export async function realDocker() {
  const explicit = process.env.HC_TEST_DOCKER_HOST;
  const host = explicit || (process.platform === "linux" ? process.env.DOCKER_HOST || "unix:///var/run/docker.sock" : null);
  let skip = null;
  if (!host) {
    skip = "no test Docker: set HC_TEST_DOCKER_HOST=unix:///… (on a Mac, a throwaway Colima profile's socket, never the owner's)";
  } else {
    try {
      await new Engine({ socketPath: socketPathOf(host), timeoutMs: 5000 }).ping();
    } catch (error) {
      skip = `Docker at ${host} does not answer: ${error.message}`;
    }
  }
  if (skip && process.env.HC_REQUIRE_DOCKER_TESTS === "1") throw new Error(`HC_REQUIRE_DOCKER_TESTS is set but ${skip}`);
  // `false`, not null: node:test skips a test whose `skip` option is null.
  return { host: skip ? null : host, skip: skip ?? false };
}

/** The environment `docker` runs with in these tests: this one Docker only. */
export function dockerEnv(host, extra = {}) {
  return { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? "/tmp", DOCKER_HOST: host, ...extra };
}

/** `docker …` against the test Docker. */
export function docker(host, args, options = {}) {
  return runCommand("docker", args, { env: dockerEnv(host, options.env), timeoutMs: options.timeoutMs ?? 300_000, allowFailure: options.allowFailure });
}

/** Builds test/fixture as hc-agent-fixture:test (the legacy builder where buildx is missing). */
export async function buildFixture(host) {
  const buildx = await docker(host, ["buildx", "version"], { allowFailure: true });
  const env = buildx.code === 0 ? {} : { DOCKER_BUILDKIT: "0" };
  await docker(host, ["build", "-q", "-t", FIXTURE_IMAGE, FIXTURE_DIR], { env, timeoutMs: 600_000 });
  return FIXTURE_IMAGE;
}

/** Removes every container a test run left with `job` as its job label. */
export async function removeContainers(host, job) {
  const { stdout } = await docker(host, ["ps", "-aq", "--filter", `label=dev.homecompute.job=${job}`], { allowFailure: true });
  const ids = stdout.split(/\s+/).filter(Boolean);
  if (ids.length) await docker(host, ["rm", "-f", ...ids], { allowFailure: true });
}

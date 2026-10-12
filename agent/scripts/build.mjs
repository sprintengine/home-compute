// Bundles the agent (agent/src plus the src/core modules it shares with the
// Workers) into one dependency-free ESM file, dist/home-compute-agent.mjs.
// `--check` builds in memory and verifies the bundle imports nothing but
// Node's built-ins.
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { build } from "esbuild";
import { AGENT_VERSION } from "../src/version.mjs";

const root = path.resolve(import.meta.dirname, "..");
const outfile = path.join(root, "dist", "home-compute-agent.mjs");
const checkOnly = process.argv.includes("--check");

const result = await build({
  entryPoints: [path.join(root, "src", "cli.mjs")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile,
  write: !checkOnly,
  metafile: true,
  legalComments: "none",
  logLevel: checkOnly ? "warning" : "info",
  banner: { js: `// home-compute-agent ${AGENT_VERSION}: bundled from agent/src and src/core, no dependencies.` },
});

const imports = Object.values(result.metafile.outputs).flatMap((output) => output.imports);
const foreign = imports.filter((entry) => !entry.path.startsWith("node:"));
if (foreign.length) {
  console.error(`The agent bundle imports more than Node's built-ins: ${foreign.map((entry) => entry.path).join(", ")}`);
  process.exit(1);
}
if (!checkOnly) {
  await mkdir(path.dirname(outfile), { recursive: true });
  await chmod(outfile, 0o755);
}

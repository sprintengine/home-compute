import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const outdir = path.join(root, "dist");
const checkOnly = process.argv.includes("--check");
const external = [
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "@multicode/module-sdk/ui",
  "@multicode/module-sdk/surface",
];

const shared = {
  bundle: true,
  logLevel: "info",
  platform: "neutral",
  target: "es2022",
  external,
};

if (checkOnly) {
  await Promise.all([
    build({ ...shared, entryPoints: [path.join(root, "src/main.js")], format: "cjs", write: false }),
    build({ ...shared, entryPoints: [path.join(root, "src/renderer.jsx")], format: "esm", jsx: "automatic", write: false }),
  ]);
} else {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  await Promise.all([
    build({ ...shared, entryPoints: [path.join(root, "src/main.js")], format: "cjs", outfile: path.join(outdir, "main.cjs") }),
    build({ ...shared, entryPoints: [path.join(root, "src/renderer.jsx")], format: "esm", jsx: "automatic", outfile: path.join(outdir, "renderer.mjs") }),
  ]);
}

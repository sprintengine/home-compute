// `home-compute-agent enrol` (§5): spends a join token for this machine's id
// and credential, then writes the configuration and the credential (0600)
// to the state directory. The machine's name, labels and capabilities come
// from the token; the facts sent with it only fill labels the token leaves
// out (os, arch, runtime).

import os from "node:os";
import { ControlPlaneClient } from "./client.mjs";
import { createRuntime } from "./runtime/runtime.mjs";
import { DEFAULT_CONFIG } from "./state.mjs";
import { AGENT_VERSION } from "./version.mjs";

const ARCH = { x64: "amd64", arm64: "arm64", arm: "arm" };
const OS = { darwin: "darwin", linux: "linux", win32: "windows" };

/** A machine name from the host name: `Conals-Mac-mini.local` → `conals-mac-mini`. */
export function nameFromHost(hostname = os.hostname()) {
  const name = hostname.split(".")[0].toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
  return name || "machine";
}

/** What the agent tells the control plane about this machine. */
export async function machineFacts(config, { runtime, env } = {}) {
  let runtimeFacts = {};
  try {
    runtimeFacts = await (runtime ?? createRuntime(config, { env })).facts();
  } catch (error) {
    runtimeFacts = { error: error.message };
  }
  return {
    os: OS[process.platform] ?? process.platform,
    arch: ARCH[process.arch] ?? process.arch,
    runtime: config.runtime,
    agentVersion: AGENT_VERSION,
    node: process.version,
    osRelease: os.release(),
    cpus: runtimeFacts.cpus ?? os.availableParallelism?.() ?? os.cpus().length,
    memoryMiB: runtimeFacts.memoryMiB ?? Math.round(os.totalmem() / 1048576),
    diskFreeMiB: runtimeFacts.diskFreeMiB ?? null,
    runtimeVersion: runtimeFacts.version ?? null,
    sandbox: runtimeFacts.sandbox ?? null,
    caps: config.caps ?? {},
  };
}

/**
 * Enrols this machine. Refuses when a credential is already stored, unless
 * `reenrol`. `settings`: configuration fields to set with it (allowImages,
 * allowLocalImages, colima). Returns what hc-core answered, without the
 * credential.
 */
export async function enrol({ state, server, joinToken, name, runtime = "fake", reenrol = false, fetch, runtimeInstance, settings = {}, env }) {
  if (!server) throw new Error("--server is required: hc-core's URL");
  if (!joinToken) throw new Error("A join token is required (--join-token-stdin)");
  const existing = await state.loadConfig().catch(() => null);
  if (!reenrol && await state.readCredential()) {
    throw new Error(`This machine is already enrolled${existing?.name ? ` as ${existing.name}` : ""}; pass --reenrol to replace it`);
  }
  const config = {
    ...DEFAULT_CONFIG, ...(existing ?? {}), ...settings, server: String(server).replace(/\/+$/, ""), runtime,
    colima: { ...(existing?.colima ?? {}), ...(settings.colima ?? {}) },
  };
  const facts = await machineFacts(config, { runtime: runtimeInstance, env });
  const client = new ControlPlaneClient({ server: config.server, fetch });
  const { body } = await client.enrol({ joinToken: joinToken.trim(), name: name ?? nameFromHost(), facts });
  await state.saveConfig({ ...config, machineId: body.machineId, name: body.name });
  await state.writeCredential(body.credential);
  const { credential, ...answer } = body;
  return answer;
}

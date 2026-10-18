// Machines and their credentials (§5 of docs/hosted-control-plane.md): join
// tokens, enrolment, authenticating an agent's bearer credential, rotation
// and revocation. Only hashes are stored: a join token and a credential are
// shown once, to whoever asked for them, and never again.

import { constantTimeEqual } from "../../src/core/csrf.mjs";
import { newId } from "../../src/core/ids.mjs";
import { CLOUDFLARE_RUNTIME } from "../../src/core/cloudflare.mjs";
import { normaliseLabels } from "../../src/core/job.mjs";
import {
  JOIN_TOKEN, MACHINE_NAME, newCredential, newJoinToken, parseCredential, sha256Hex,
} from "../../src/core/protocol.mjs";
import { auditStatement, bumpMachinesVersion } from "./db.mjs";
import { HttpError } from "./http.mjs";

export const JOIN_TOKEN_TTL_MS = 60 * 60_000;
const MAX_JOIN_TOKEN_TTL_MS = 24 * 60 * 60_000;
/** Credentials older than this are rotated on a sync (§5); the dashboard can ask sooner. */
export const ROTATE_AFTER_MS = 90 * 86_400_000;
export const CAPABILITIES = ["provisioner"];

function rejectReservedRuntime(labels) {
  if (labels?.runtime === CLOUDFLARE_RUNTIME) {
    throw new HttpError(400, "runtime=cloudflare-container is reserved for the Cloudflare Containers executor");
  }
}

function unauthorized(code = "unauthorized") {
  const error = new HttpError(401, code);
  error.code = code;
  return error;
}

export function checkCapabilities(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => !CAPABILITIES.includes(item))) {
    throw new HttpError(400, `capabilities must be a list of ${CAPABILITIES.join(", ")}`);
  }
  return [...new Set(value)].sort();
}

export function checkMachineName(value) {
  if (typeof value !== "string" || !MACHINE_NAME.test(value)) {
    throw new HttpError(400, "A machine name is lower-case letters, digits and dashes (at most 63), like mac-mini");
  }
  return value;
}

/** The dashboard's caps on a machine: `{cpus?, memoryMiB?, diskMiB?, maxRuns?}`. */
export function checkCaps(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "capacity must be an object");
  const caps = {};
  for (const [key, maximum] of [["cpus", 1024], ["memoryMiB", 1024 * 1024 * 1024], ["diskMiB", 1024 * 1024 * 1024], ["maxRuns", 64]]) {
    if (value[key] === undefined || value[key] === null) continue;
    if (typeof value[key] !== "number" || !(value[key] >= 0 && value[key] <= maximum) || (key !== "cpus" && !Number.isInteger(value[key]))) {
      throw new HttpError(400, `capacity.${key} must be a number from 0 to ${maximum}`);
    }
    caps[key] = value[key];
  }
  const unknown = Object.keys(value).filter((key) => !["cpus", "memoryMiB", "diskMiB", "maxRuns"].includes(key));
  if (unknown.length) throw new HttpError(400, `Unknown capacity field ${unknown.join(", ")}`);
  return caps;
}

/**
 * A new join token (`hcj_…`, single use, 60 minutes by default) carrying the
 * machine's name, labels and capabilities. Returns the token, which is not
 * stored, and the statements that store its hash and audit it.
 */
export async function joinTokenStatements(db, { name, labels, capabilities, ttlMs = JOIN_TOKEN_TTL_MS, actor, ip, now }) {
  if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > MAX_JOIN_TOKEN_TTL_MS) {
    throw new HttpError(400, "ttlMinutes must be a whole number from 1 to 1440");
  }
  const machineName = name === undefined || name === null ? null : checkMachineName(name);
  const tokenLabels = normaliseLabels(labels ?? {}, "labels");
  rejectReservedRuntime(tokenLabels);
  const tokenCapabilities = checkCapabilities(capabilities);
  const token = newJoinToken();
  const expiresAt = now + ttlMs;
  const statements = [
    db.prepare(`INSERT INTO join_tokens (token_hash, expires_at, machine_name, labels_json, capabilities, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(await sha256Hex(token), expiresAt, machineName, JSON.stringify(tokenLabels),
      tokenCapabilities.join(","), actor, now),
    auditStatement(db, {
      at: now, actor, ip, action: "machine.join-token", target: machineName,
      after: { name: machineName, labels: tokenLabels, capabilities: tokenCapabilities, expiresAt },
    }),
  ];
  return { token, expiresAt, name: machineName, labels: tokenLabels, capabilities: tokenCapabilities, statements };
}

/** The labels an agent's facts give a new machine: its os, arch and runtime, when they look like labels. */
function factLabels(facts) {
  const labels = {};
  for (const key of ["os", "arch", "runtime"]) {
    if (typeof facts?.[key] === "string" && /^[a-z0-9][a-z0-9._-]{0,31}$/i.test(facts[key])) labels[key] = facts[key];
  }
  return labels;
}

/**
 * POST /agent/v1/enrol: spends a join token and creates the machine, with a
 * name from the token (or, if it names none, from the agent), the token's
 * labels over the agent's own os/arch/runtime, and the token's capabilities.
 * The credential is in this answer only; the database keeps its SHA-256.
 * A revoked machine's name is freed for its replacement.
 */
export async function enrol(db, { joinToken, name, facts }, { now, ip }) {
  if (typeof joinToken !== "string" || !JOIN_TOKEN.test(joinToken)) throw unauthorized("invalid_join_token");
  const tokenHash = await sha256Hex(joinToken);
  const token = await db.prepare("SELECT * FROM join_tokens WHERE token_hash = ?").bind(tokenHash).first();
  if (!token) throw unauthorized("invalid_join_token");
  if (token.used_at !== null) throw unauthorized("join_token_used");
  if (token.expires_at <= now) throw unauthorized("join_token_expired");
  const machineName = checkMachineName(token.machine_name ?? name);
  const existing = await db.prepare("SELECT id, revoked_at FROM machines WHERE name = ?").bind(machineName).first();
  if (existing && existing.revoked_at === null) {
    throw new HttpError(409, `A machine called ${machineName} is enrolled; revoke it first or use another name`);
  }
  const labels = normaliseLabels({ ...factLabels(facts), ...JSON.parse(token.labels_json ?? "{}") }, "labels");
  rejectReservedRuntime(labels);
  const machineId = newId("m", now);
  const credential = newCredential(machineId);
  const statements = [];
  if (existing) {
    statements.push(db.prepare("UPDATE machines SET name = name || '~' || substr(id, -6) WHERE id = ? AND revoked_at IS NOT NULL").bind(existing.id));
  }
  statements.push(
    db.prepare("UPDATE join_tokens SET used_at = ?1 WHERE token_hash = ?2 AND used_at IS NULL AND expires_at > ?1").bind(now, tokenHash),
    db.prepare(`INSERT INTO machines (id, name, labels_json, capabilities, capacity_json, facts_json, health_json, agent_version,
        credential_hash, credential_issued_at, last_ip, enrolled_at)
      SELECT ?1, ?2, ?3, ?4, '{}', ?5, '{}', ?6, ?7, ?8, ?9, ?8 WHERE changes() = 1`)
      .bind(machineId, machineName, JSON.stringify(labels), token.capabilities ?? "", JSON.stringify(facts ?? {}),
        typeof facts?.agentVersion === "string" ? facts.agentVersion.slice(0, 32) : null, await sha256Hex(credential), now, ip ?? null),
    db.prepare(`INSERT INTO audit_log (at, actor, action, target, after_json, ip) SELECT ?, ?, 'machine.enrol', ?, ?, ? WHERE changes() = 1`)
      .bind(now, `machine:${machineId}`, machineId,
        JSON.stringify({ name: machineName, labels, capabilities: token.capabilities || null, tokenCreatedBy: token.created_by }), ip ?? null),
    bumpMachinesVersion(db),
  );
  if (token.provisioning_task_id) {
    statements.push(db.prepare(`UPDATE provisioning_tasks SET state = 'succeeded', result_machine_id = ?, finished_at = ?
      WHERE id = ? AND state IN ('running', 'waiting-enrol')`).bind(machineId, now, token.provisioning_task_id));
  }
  const results = await db.batch(statements);
  if (results[existing ? 1 : 0].meta.changes !== 1) throw unauthorized("join_token_used");
  return {
    machineId, credential, name: machineName, labels,
    capabilities: token.capabilities ? token.capabilities.split(",") : [], serverTime: now,
  };
}

/**
 * The machine a request's bearer credential belongs to. A credential issued
 * by a rotation and not yet used (`credential_next_hash`) is promoted the
 * first time it is presented (§5). A revoked machine is told so (401
 * `revoked`); anything else that does not match is a plain 401.
 */
export async function authenticateMachine(db, request, now) {
  const header = request.headers.get("authorization") ?? "";
  const credential = header.match(/^Bearer\s+(\S+)$/i)?.[1];
  const parsed = parseCredential(credential);
  if (!parsed) throw unauthorized();
  const machine = await db.prepare("SELECT * FROM machines WHERE id = ?").bind(parsed.machineId).first();
  if (!machine) throw unauthorized();
  if (machine.revoked_at !== null || machine.credential_hash === null) throw unauthorized("revoked");
  const hash = await sha256Hex(credential);
  if (constantTimeEqual(hash, machine.credential_hash)) return { machine, rotated: false };
  if (!machine.credential_next_hash || !constantTimeEqual(hash, machine.credential_next_hash)) throw unauthorized();
  const [promotion] = await db.batch([
    db.prepare(`UPDATE machines SET credential_hash = credential_next_hash, credential_next_hash = NULL, credential_issued_at = ?1,
        rotate_requested_at = NULL WHERE id = ?2 AND credential_next_hash = ?3`).bind(now, machine.id, hash),
    db.prepare(`INSERT INTO audit_log (at, actor, action, target) SELECT ?, ?, 'machine.credential-rotated', ? WHERE changes() = 1`)
      .bind(now, `machine:${machine.id}`, machine.id),
  ]);
  if (promotion.meta.changes !== 1) throw unauthorized();
  return {
    machine: { ...machine, credential_hash: hash, credential_next_hash: null, credential_issued_at: now, rotate_requested_at: null },
    rotated: true,
  };
}

/** Whether a sync should hand the machine a new credential: asked for, or the current one is old. */
export function rotationDue(machine, now) {
  if (machine.rotate_requested_at !== null && machine.rotate_requested_at !== undefined) return true;
  const issued = machine.credential_issued_at ?? machine.enrolled_at;
  return typeof issued === "number" && now - issued > ROTATE_AFTER_MS;
}

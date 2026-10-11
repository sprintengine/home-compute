// hc-web's machine handlers (§7): join tokens, the machine list, edits
// (drain for operators; labels, caps, name, capabilities and credential
// rotation for admins) and revocation. Each change commits with its audit
// row and bumps `machines_version` so dashboards notice.

import { normaliseLabels } from "../../src/core/job.mjs";
import { allows } from "./access.mjs";
import { auditStatement, bumpMachinesVersion, machineFromRow } from "./db.mjs";
import { HttpError, iso, json, readJson } from "./http.mjs";
import { checkCapabilities, checkCaps, checkMachineName, joinTokenStatements } from "./machines.mjs";
import { machineView, RUN_LIST_COLUMNS } from "./snapshot.mjs";
import { ACTIVE_SQL } from "./db.mjs";

const MACHINE_COLUMNS = `id, name, labels_json, capabilities, capacity_json, facts_json, health_json, agent_version, drain, last_seen_at,
  last_ip, clock_skew_ms, enrolled_at, revoked_at, credential_issued_at, rotate_requested_at, credential_next_hash IS NOT NULL AS rotation_pending`;

function only(body, keys) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "The body must be an object");
  const unknown = Object.keys(body).filter((key) => !keys.includes(key));
  if (unknown.length) throw new HttpError(400, `Unknown field ${unknown.join(", ")}`);
  return body;
}

async function requireMachine(db, id) {
  const row = await db.prepare(`SELECT ${MACHINE_COLUMNS} FROM machines WHERE id = ?`).bind(id).first();
  if (!row) throw new HttpError(404, `Unknown machine ${id}`);
  return row;
}

async function nameTaken(db, name, exceptId = null) {
  const row = await db.prepare("SELECT id FROM machines WHERE name = ? AND revoked_at IS NULL AND id != ?").bind(name, exceptId ?? "").first();
  return Boolean(row);
}

async function activeRunsOf(db, machineId = null) {
  const { results } = await db.prepare(`SELECT ${RUN_LIST_COLUMNS} FROM runs WHERE state IN (${ACTIVE_SQL})
    ${machineId ? "AND machine_id = ?" : ""}`).bind(...(machineId ? [machineId] : [])).all();
  return results;
}

/** POST /v1/join-tokens: `{name?, labels?, capabilities?, ttlMinutes?}` → the token, shown this once. */
export async function createJoinToken({ db, env, request, identity, ip, now }) {
  const body = only(await readJson(request, { maxBytes: 4096 }), ["name", "labels", "capabilities", "ttlMinutes"]);
  if (body.name !== undefined && body.name !== null && await nameTaken(db, checkMachineName(body.name))) {
    throw new HttpError(409, `A machine called ${body.name} is enrolled; revoke it first or use another name`);
  }
  const ttlMinutes = body.ttlMinutes ?? 60;
  const created = await joinTokenStatements(db, {
    name: body.name, labels: body.labels, capabilities: body.capabilities, ttlMs: Number.isInteger(ttlMinutes) ? ttlMinutes * 60_000 : NaN,
    actor: identity.actor, ip, now,
  });
  await db.batch(created.statements);
  const server = env.CORE_URL ? String(env.CORE_URL).replace(/\/+$/, "") : null;
  return json(201, {
    token: created.token,
    expiresAt: iso(created.expiresAt),
    name: created.name,
    labels: created.labels,
    capabilities: created.capabilities,
    // The token goes on stdin, never in argv (§6).
    enrolCommand: `home-compute-agent enrol --server ${server ?? "<hc-core URL>"} --join-token-stdin`,
  });
}

/** GET /v1/machines?all=1: enrolled machines (revoked ones too with `all`), each with its active runs. */
export async function listMachines({ db, url, now }) {
  const all = ["1", "true"].includes(url.searchParams.get("all") ?? "");
  const [machines, runs] = await Promise.all([
    db.prepare(`SELECT ${MACHINE_COLUMNS} FROM machines ${all ? "" : "WHERE revoked_at IS NULL"} ORDER BY name`).all(),
    activeRunsOf(db),
  ]);
  return json(200, { machines: machines.results.map((row) => machineView(row, now, runs)) });
}

export async function getMachine({ db, params, now }) {
  const row = await requireMachine(db, params.id);
  return json(200, machineView(row, now, await activeRunsOf(db, row.id)));
}

const ADMIN_FIELDS = ["name", "labels", "capacity", "capabilities", "rotateCredential"];

/**
 * PATCH /v1/machines/:id: `{drain?}` for an operator; `{name?, labels?,
 * capacity?, capabilities?, rotateCredential?}` need an admin. Rotation is
 * only requested here: hc-core makes the new credential in its answer to the
 * machine's next sync, as only the machine may see it.
 */
export async function patchMachine({ db, request, params, identity, role, ip, now }) {
  const body = only(await readJson(request, { maxBytes: 8192 }), ["drain", ...ADMIN_FIELDS]);
  if (ADMIN_FIELDS.some((field) => body[field] !== undefined) && !allows(role, "admin")) {
    return json(403, { error: "forbidden", role, needs: "admin" });
  }
  const row = await requireMachine(db, params.id);
  if (row.revoked_at !== null) throw new HttpError(409, `${row.name} is revoked`);
  const current = machineFromRow(row);
  const next = {};
  if (body.drain !== undefined) {
    if (typeof body.drain !== "boolean") throw new HttpError(400, "drain must be true or false");
    next.drain = body.drain;
  }
  if (body.name !== undefined) {
    next.name = checkMachineName(body.name);
    if (next.name !== current.name && await nameTaken(db, next.name, row.id)) throw new HttpError(409, `${next.name} is taken`);
  }
  if (body.labels !== undefined) next.labels = normaliseLabels(body.labels, "labels");
  if (body.capacity !== undefined) next.capacity = checkCaps(body.capacity);
  if (body.capabilities !== undefined) next.capabilities = checkCapabilities(body.capabilities);
  if (body.rotateCredential !== undefined && body.rotateCredential !== true) throw new HttpError(400, "rotateCredential can only be true");
  const changed = Object.keys(next).filter((key) => JSON.stringify(next[key]) !== JSON.stringify(current[key]));
  if (changed.length || body.rotateCredential) {
    await db.batch([
      // Names are unique across revoked machines too: a revoked holder of the new name gives it up, as at enrolment.
      db.prepare("UPDATE machines SET name = name || '~' || substr(id, -6) WHERE name = ? AND id != ? AND revoked_at IS NOT NULL")
        .bind(next.name ?? current.name, row.id),
      db.prepare(`UPDATE machines SET name = ?, labels_json = ?, capacity_json = ?, capabilities = ?, drain = ?,
          rotate_requested_at = COALESCE(?, rotate_requested_at) WHERE id = ?`)
        .bind(next.name ?? current.name, JSON.stringify(next.labels ?? current.labels), JSON.stringify(next.capacity ?? current.capacity),
          (next.capabilities ?? current.capabilities).join(","), (next.drain ?? current.drain) ? 1 : 0, body.rotateCredential ? now : null, row.id),
      auditStatement(db, {
        at: now, actor: identity.actor, ip, target: row.id,
        action: changed.length === 1 && changed[0] === "drain" ? (next.drain ? "machine.drain" : "machine.undrain") : "machine.update",
        before: Object.fromEntries(changed.map((key) => [key, current[key]])),
        after: { ...Object.fromEntries(changed.map((key) => [key, next[key]])), ...(body.rotateCredential ? { rotateCredential: true } : {}) },
      }),
      bumpMachinesVersion(db),
    ]);
  }
  return json(200, { ...machineView(await requireMachine(db, row.id), now, await activeRunsOf(db, row.id)), changed });
}

/**
 * DELETE /v1/machines/:id: revocation. The credential hashes are cleared, so
 * the agent's next request gets 401: it claims nothing more, finishes what it
 * runs and keeps the results (§4.2). Runs it holds are lost when their
 * leases run out, and retried by policy.
 */
export async function revokeMachine({ db, params, identity, ip, now }) {
  const row = await requireMachine(db, params.id);
  const [update] = await db.batch([
    db.prepare(`UPDATE machines SET credential_hash = NULL, credential_next_hash = NULL, revoked_at = ?, drain = 1
      WHERE id = ? AND revoked_at IS NULL`).bind(now, row.id),
    db.prepare(`INSERT INTO audit_log (at, actor, action, target, before_json, ip) SELECT ?, ?, 'machine.revoke', ?, ?, ? WHERE changes() = 1`)
      .bind(now, identity.actor, row.id, JSON.stringify({ name: row.name, labels: JSON.parse(row.labels_json ?? "{}") }), ip),
    bumpMachinesVersion(db),
  ]);
  return json(200, { machine: row.id, name: row.name, revoked: true, changed: update.meta.changes === 1, revokedAt: iso(row.revoked_at ?? now) });
}

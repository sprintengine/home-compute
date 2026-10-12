// The vault in the Workers (§5): hc-web seals and lists, hc-core opens.
//
// hc-web holds only VAULT_PUBLIC_KEY. `PUT /v1/secrets/:name` seals the value
// in the Worker and stores the envelope, its key id, a hint (identifiers
// only) and the labels a machine must have to receive it; no /v1 answer
// ever carries a value or an envelope. hc-core holds VAULT_PRIVATE_KEY and
// opens a secret only while it answers a claim, and only for a machine whose
// labels match the secret's `allowedLabels`.
//
// hc-core keeps the secrets' names and labels in isolate memory keyed by the
// `secrets_version` setting (as it keeps the job set by `jobs_version`), so a
// sync reads no secret rows until a claim needs their envelopes. An
// envelope's unwrapped data key is kept as a non-extractable CryptoKey (at
// most 64), so only an isolate's first claim of a secret pays for the
// RSA-3072 operation, which costs about 1-2.5 ms of the 10 ms CPU budget.

import { normaliseLabels } from "../../src/core/job.mjs";
import {
  checkSecretName, openWithDataKey, publicKeyId, sealSecret, secretHint, unwrapDataKey, VaultError,
} from "../../src/core/vault.mjs";
import { auditStatement } from "./db.mjs";
import { HttpError, iso, json, readJson } from "./http.mjs";

function parse(text, fallback) {
  try {
    return text === null || text === undefined ? fallback : JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function bumpSecretsVersion(db) {
  return db.prepare(`INSERT INTO settings (key, value_json) VALUES ('secrets_version', '1')
    ON CONFLICT(key) DO UPDATE SET value_json = CAST(CAST(value_json AS INTEGER) + 1 AS TEXT)`);
}

// ---------- Names and labels (no values), cached per isolate

let cache = { version: null, secrets: null };

/** The vault's secrets by name, `{allowedLabels, keyId}`, read again only when `version` moved. */
export async function secretsAt(db, version) {
  if (cache.secrets && cache.version === version) return cache.secrets;
  const { results } = await db.prepare("SELECT name, key_id, allowed_labels_json FROM secrets").all();
  const secrets = new Map(results.map((row) => [row.name, { keyId: row.key_id, allowedLabels: parse(row.allowed_labels_json, {}) ?? {} }]));
  cache = { version, secrets };
  return secrets;
}

/** The same without the cache, for hc-web (which reads them once per snapshot). */
export async function readSecretNames(db) {
  const { results } = await db.prepare("SELECT name, key_id, allowed_labels_json FROM secrets").all();
  return new Map(results.map((row) => [row.name, { keyId: row.key_id, allowedLabels: parse(row.allowed_labels_json, {}) ?? {} }]));
}

export function clearSecretsCache() {
  cache = { version: null, secrets: null };
  dataKeys.clear();
}

// ---------- hc-web: /v1/secrets (admin)

/** The jobs that reference each secret, for the list's "used by". */
async function usage(db) {
  const { results } = await db.prepare("SELECT id, secret_env_json FROM jobs").all();
  const used = new Map();
  for (const row of results) {
    for (const reference of Object.values(parse(row.secret_env_json, {}) ?? {})) {
      if (typeof reference !== "string" || !reference.startsWith("vault:")) continue;
      const name = reference.slice(6);
      if (!used.has(name)) used.set(name, []);
      if (!used.get(name).includes(row.id)) used.get(name).push(row.id);
    }
  }
  return used;
}

/** GET /v1/secrets: names, hints, labels and who set them; every name a job references, set or not. Never a value. */
export async function listSecrets({ db, env }) {
  const [{ results }, used] = await Promise.all([
    db.prepare("SELECT name, key_id, hint, allowed_labels_json, updated_at, updated_by FROM secrets ORDER BY name").all(),
    usage(db),
  ]);
  let keyId = null;
  let vaultError = null;
  try {
    keyId = env.VAULT_PUBLIC_KEY ? await publicKeyId(env.VAULT_PUBLIC_KEY) : null;
  } catch (error) {
    vaultError = error.message;
  }
  const stored = new Set(results.map((row) => row.name));
  return json(200, {
    vault: { configured: Boolean(keyId), keyId, ...(vaultError ? { error: vaultError } : {}) },
    secrets: results.map((row) => ({
      name: row.name,
      set: true,
      keyId: row.key_id,
      ...(keyId && row.key_id !== keyId ? { staleKey: true } : {}),
      hint: row.hint,
      allowedLabels: parse(row.allowed_labels_json, {}) ?? {},
      updatedAt: iso(row.updated_at),
      updatedBy: row.updated_by,
      usedBy: used.get(row.name) ?? [],
    })),
    // Named by a job but not in the vault: those jobs are blocked until it is set.
    missing: [...used.keys()].filter((name) => !stored.has(name)).sort().map((name) => ({ name, set: false, usedBy: used.get(name) })),
  });
}

/**
 * PUT /v1/secrets/:name `{value, allowedLabels?}`: sealed here with the
 * public key and stored; the answer and the audit row carry the name, key
 * id, hint and labels only. Without `allowedLabels` a replaced secret keeps
 * its labels; a new one gets none (any enrolled machine whose job needs it).
 */
export async function putSecret({ db, env, request, params, identity, ip, now }) {
  const body = await readJson(request, { maxBytes: 24 * 1024 });
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "The body must be an object");
  const unknown = Object.keys(body).filter((key) => !["value", "allowedLabels"].includes(key));
  if (unknown.length) throw new HttpError(400, `Unknown field ${unknown.join(", ")}`);
  const name = vaultCall(() => checkSecretName(params.id));
  if (typeof body.value !== "string" || !body.value.length) throw new HttpError(400, "value must be a non-empty string");
  const labels = body.allowedLabels === undefined ? undefined : normaliseLabels(body.allowedLabels, "allowedLabels");
  const sealed = await vaultCallAsync(() => sealSecret(name, body.value, env.VAULT_PUBLIC_KEY));
  const hint = secretHint(name, body.value);
  const before = await db.prepare("SELECT key_id, hint, allowed_labels_json FROM secrets WHERE name = ?").bind(name).first();
  const allowedLabels = labels ?? parse(before?.allowed_labels_json, {}) ?? {};
  await db.batch([
    db.prepare(`INSERT INTO secrets (name, envelope, key_id, hint, allowed_labels_json, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(name) DO UPDATE SET envelope = excluded.envelope, key_id = excluded.key_id, hint = excluded.hint,
        allowed_labels_json = excluded.allowed_labels_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .bind(name, sealed.envelope, sealed.keyId, hint, JSON.stringify(allowedLabels), now, identity.actor),
    auditStatement(db, {
      at: now, actor: identity.actor, ip, action: before ? "secret.update" : "secret.put", target: name,
      before: before ? { keyId: before.key_id, hint: before.hint, allowedLabels: parse(before.allowed_labels_json, {}) } : null,
      after: { keyId: sealed.keyId, hint, allowedLabels },
    }),
    bumpSecretsVersion(db),
  ]);
  return json(before ? 200 : 201, { name, set: true, keyId: sealed.keyId, hint, allowedLabels, updatedAt: iso(now), updatedBy: identity.actor });
}

/** DELETE /v1/secrets/:name. Jobs that name it are blocked until it is set again. */
export async function deleteSecret({ db, params, identity, ip, now }) {
  const name = vaultCall(() => checkSecretName(params.id));
  const [removed] = await db.batch([
    db.prepare("DELETE FROM secrets WHERE name = ?").bind(name),
    db.prepare(`INSERT INTO audit_log (at, actor, action, target, ip) SELECT ?, ?, 'secret.delete', ?, ? WHERE changes() = 1`)
      .bind(now, identity.actor, name, ip),
    bumpSecretsVersion(db),
  ]);
  if (removed.meta.changes !== 1) throw new HttpError(404, `No secret ${name}`);
  return json(200, { name, deleted: true });
}

function asHttp(error) {
  if (!(error instanceof VaultError)) return error;
  const status = error.code === "vault_not_configured" || error.code === "malformed_key" ? 503 : 400;
  const failure = new HttpError(status, error.message);
  failure.code = error.code;
  return failure;
}

function vaultCall(fn) {
  try {
    return fn();
  } catch (error) {
    throw asHttp(error);
  }
}

async function vaultCallAsync(fn) {
  try {
    return await fn();
  } catch (error) {
    throw asHttp(error);
  }
}

// ---------- hc-core: opening secrets for a claim

const dataKeys = new Map();
const DATA_KEY_CACHE = 64;

/**
 * The plain values of `names` for a machine with `labels`, read from D1 and
 * opened with the private key: `{values: {name: value}, refused: [{name,
 * reason}]}`. A secret that is gone, is not for this machine's labels, or
 * does not open is refused, never sent.
 */
export async function openSecretsFor(db, env, names, labels) {
  const values = {};
  const refused = [];
  if (!names.length) return { values, refused };
  const { results } = await db.prepare(`SELECT name, envelope, key_id, allowed_labels_json FROM secrets
    WHERE name IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(names)).all();
  const rows = new Map(results.map((row) => [row.name, row]));
  for (const name of names) {
    const row = rows.get(name);
    if (!row) {
      refused.push({ name, reason: "not in the vault" });
      continue;
    }
    const allowed = parse(row.allowed_labels_json, {}) ?? {};
    if (!Object.entries(allowed).every(([key, value]) => labels?.[key] === value)) {
      refused.push({ name, reason: "not allowed for this machine's labels" });
      continue;
    }
    try {
      values[name] = await openCached(name, row.envelope, row.key_id, env.VAULT_PRIVATE_KEY);
    } catch (error) {
      refused.push({ name, reason: error instanceof VaultError ? error.message : "does not open" });
    }
  }
  return { values, refused };
}

/** `openSecret`, keeping the envelope's unwrapped data key (non-extractable) after the first time. */
async function openCached(name, envelope, keyId, privateKey) {
  const cacheKey = `${keyId}:${name}:${String(envelope).split(".")[0]}`;
  let dataKey = dataKeys.get(cacheKey);
  if (!dataKey) {
    dataKey = await unwrapDataKey(name, envelope, keyId, privateKey);
    if (dataKeys.size >= DATA_KEY_CACHE) dataKeys.delete(dataKeys.keys().next().value);
    dataKeys.set(cacheKey, dataKey);
  }
  return openWithDataKey(name, envelope, keyId, dataKey);
}

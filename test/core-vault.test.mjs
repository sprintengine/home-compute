// The vault's envelope encryption (§5): RSA-OAEP-3072 wraps a per-secret
// AES-256-GCM key; the additional data binds the ciphertext to the secret's
// name and the key's id; hc-web can only seal and hc-core only opens.
import assert from "node:assert/strict";
import test from "node:test";
import {
  checkSecretName, generateVaultKeys, openSecret, openWithDataKey, privateKeyId, publicKeyId, sealSecret, secretHint, unwrapDataKey,
  vaultKeyId, vaultNames, VaultError,
} from "../src/core/vault.mjs";

const keys = await generateVaultKeys();
const other = await generateVaultKeys();
const VALUE = "test-secret-value-not-real-aaaabbbbccccddddeeeeffff0000111122223333";

test("a key pair has one id, from its public half, on both sides", async () => {
  assert.match(keys.keyId, /^v1-[0-9a-f]{12}$/);
  assert.equal(await vaultKeyId(keys.publicKey), keys.keyId);
  assert.equal(await publicKeyId(keys.publicKey), keys.keyId);
  assert.equal(await privateKeyId(keys.privateKey), keys.keyId);
  assert.notEqual(other.keyId, keys.keyId);
});

test("a sealed value opens only with its name and its key, and the envelope holds none of it", async () => {
  const sealed = await sealSecret("wingfoil-r2-secret", VALUE, keys.publicKey);
  assert.equal(sealed.keyId, keys.keyId);
  assert.equal(sealed.envelope.split(".").length, 3);
  assert.ok(!sealed.envelope.includes(VALUE));
  assert.ok(!sealed.envelope.includes(Buffer.from(VALUE).toString("base64")));
  assert.equal(await openSecret("wingfoil-r2-secret", sealed.envelope, sealed.keyId, keys.privateKey), VALUE);

  // Copied onto another name, the additional data no longer matches.
  await assert.rejects(openSecret("wingfoil-r2-key-id", sealed.envelope, sealed.keyId, keys.privateKey), { code: "undecryptable" });
  // Another vault's private key is refused by id before any decryption.
  await assert.rejects(openSecret("wingfoil-r2-secret", sealed.envelope, sealed.keyId, other.privateKey), { code: "wrong_key" });
  // A tampered ciphertext fails GCM's tag.
  const [wrapped, iv, ciphertext] = sealed.envelope.split(".");
  const flipped = Buffer.from(ciphertext, "base64");
  flipped[0] ^= 1;
  await assert.rejects(openSecret("wingfoil-r2-secret", [wrapped, iv, flipped.toString("base64")].join("."), sealed.keyId, keys.privateKey),
    { code: "undecryptable" });
  await assert.rejects(openSecret("wingfoil-r2-secret", "not-an-envelope", sealed.keyId, keys.privateKey), { code: "malformed_envelope" });
});

test("every seal uses a fresh data key and IV, so equal values give different envelopes", async () => {
  const a = await sealSecret("a", "same", keys.publicKey);
  const b = await sealSecret("a", "same", keys.publicKey);
  assert.notEqual(a.envelope, b.envelope);
  assert.notEqual(a.envelope.split(".")[1], b.envelope.split(".")[1]);
});

test("an unwrapped data key cannot be exported, and opens its own envelope", async () => {
  const sealed = await sealSecret("registry", VALUE, keys.publicKey);
  const dataKey = await unwrapDataKey("registry", sealed.envelope, sealed.keyId, keys.privateKey);
  assert.equal(dataKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey("raw", dataKey));
  assert.equal(await openWithDataKey("registry", sealed.envelope, sealed.keyId, dataKey), VALUE);
});

test("names, values and keys are checked", async () => {
  assert.throws(() => checkSecretName("Bad Name"), VaultError);
  assert.throws(() => checkSecretName("x".repeat(64)), VaultError);
  assert.equal(checkSecretName("wingfoil-r2.secret_1"), "wingfoil-r2.secret_1");
  await assert.rejects(sealSecret("a", "", keys.publicKey), { code: "invalid_value" });
  await assert.rejects(sealSecret("a", "x".repeat(16 * 1024 + 1), keys.publicKey), { code: "invalid_value" });
  await assert.rejects(sealSecret("a", "v", ""), { code: "vault_not_configured" });
  await assert.rejects(sealSecret("a", "v", "bm90IGEga2V5"), { code: "malformed_key" });
  await assert.rejects(openSecret("a", "x.y.z", keys.keyId, undefined), { code: "vault_not_configured" });
});

test("hints show the end of identifiers only, never of keys, passwords or locators", () => {
  assert.equal(secretHint("wingfoil-r2-key-id", "TESTKEYID0000000000000000000ABCD"), "…ABCD");
  assert.equal(secretHint("ghcr-user", "short"), null, "too short to hint at");
  assert.equal(secretHint("wingfoil-r2-secret", VALUE), null);
  assert.equal(secretHint("wingfoil-r2-endpoint", "https://example.r2.cloudflarestorage.com"), null);
  assert.equal(secretHint("wingfoil-r2-bucket", "force5-forecast-bucket-name"), null);
});

test("a job's vault names are its vault references, sorted and once each", () => {
  assert.deepEqual(vaultNames({ secretEnv: { B: "vault:b", A: "vault:a", C: "local:C", D: "vault:a" } }), ["a", "b"]);
  assert.deepEqual(vaultNames({}), []);
});

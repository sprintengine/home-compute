// The secrets vault (§5 of docs/hosted-control-plane.md): envelope encryption
// with split keys. hc-web holds only the RSA-OAEP-3072 public key, so it can
// seal a value but never open one; hc-core holds the private key and opens a
// secret only while it builds the answer to a claim. Each value has its own
// AES-256-GCM data key, wrapped with RSA-OAEP (SHA-256); the GCM additional
// data binds the ciphertext to the secret's name and the key's id, so an
// envelope copied onto another name, or opened with another key, fails.
//
// Pure: WebCrypto only, no `node:` imports, so this runs in both Workers, the
// CLI and the tests.

const RSA = { name: "RSA-OAEP", hash: "SHA-256" };
export const VAULT_KEY_BITS = 3072;
export const SECRET_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
/** A secret's value: at most 16 KB (a registry token, a PEM key), never empty. */
export const MAX_SECRET_BYTES = 16 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class VaultError extends Error {
  constructor(message, code = "vault_error") {
    super(message);
    this.code = code;
  }
}

function toBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let index = 0; index < view.length; index += 0x8000) binary += String.fromCharCode(...view.subarray(index, index + 0x8000));
  return btoa(binary);
}

function fromBase64(text) {
  let binary;
  try {
    binary = atob(String(text).replace(/\s+/g, ""));
  } catch {
    throw new VaultError("not base64", "malformed_key");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The key's id: `v1-` and the first 12 hex digits of SHA-256 over its SubjectPublicKeyInfo. */
export async function vaultKeyId(publicKeySpki) {
  return `v1-${(await sha256Hex(fromBase64(publicKeySpki))).slice(0, 12)}`;
}

/** A new key pair, base64 DER: `{publicKey (SPKI), privateKey (PKCS #8), keyId}`. Done once, on the owner's machine. */
export async function generateVaultKeys() {
  const pair = await crypto.subtle.generateKey(
    { ...RSA, modulusLength: VAULT_KEY_BITS, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["encrypt", "decrypt"],
  );
  const publicKey = toBase64(await crypto.subtle.exportKey("spki", pair.publicKey));
  const privateKey = toBase64(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return { publicKey, privateKey, keyId: await vaultKeyId(publicKey) };
}

const sealers = new Map();
const openers = new Map();

/** hc-web's half: the public key, imported once per isolate. */
async function sealer(publicKeySpki) {
  if (!publicKeySpki) throw new VaultError("The vault has no public key (VAULT_PUBLIC_KEY)", "vault_not_configured");
  let entry = sealers.get(publicKeySpki);
  if (!entry) {
    entry = (async () => {
      try {
        const key = await crypto.subtle.importKey("spki", fromBase64(publicKeySpki), RSA, false, ["encrypt"]);
        return { key, keyId: await vaultKeyId(publicKeySpki) };
      } catch (error) {
        throw error instanceof VaultError ? error : new VaultError("VAULT_PUBLIC_KEY is not an RSA-OAEP public key", "malformed_key");
      }
    })();
    sealers.set(publicKeySpki, entry);
    entry.catch(() => sealers.delete(publicKeySpki));
  }
  return entry;
}

/**
 * hc-core's half: the private key, imported once per isolate, with the id of
 * its public half (from the JWK's modulus and exponent), so an envelope
 * sealed under another key is refused by id before any decryption.
 */
async function opener(privateKeyPkcs8) {
  if (!privateKeyPkcs8) throw new VaultError("The vault has no private key (VAULT_PRIVATE_KEY)", "vault_not_configured");
  let entry = openers.get(privateKeyPkcs8);
  if (!entry) {
    entry = (async () => {
      try {
        const bytes = fromBase64(privateKeyPkcs8);
        const extractable = await crypto.subtle.importKey("pkcs8", bytes, RSA, true, ["decrypt"]);
        const jwk = await crypto.subtle.exportKey("jwk", extractable);
        const publicKey = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RSA-OAEP-256", ext: true }, RSA, true, ["encrypt"]);
        const keyId = await vaultKeyId(toBase64(await crypto.subtle.exportKey("spki", publicKey)));
        const key = await crypto.subtle.importKey("pkcs8", bytes, RSA, false, ["decrypt"]);
        return { key, keyId };
      } catch (error) {
        throw error instanceof VaultError ? error : new VaultError("VAULT_PRIVATE_KEY is not an RSA-OAEP private key", "malformed_key");
      }
    })();
    openers.set(privateKeyPkcs8, entry);
    entry.catch(() => openers.delete(privateKeyPkcs8));
  }
  return entry;
}

/** The id of the key hc-core can open with (to compare with what envelopes were sealed under). */
export async function privateKeyId(privateKeyPkcs8) {
  return (await opener(privateKeyPkcs8)).keyId;
}

export async function publicKeyId(publicKeySpki) {
  return (await sealer(publicKeySpki)).keyId;
}

function additionalData(name, keyId) {
  return encoder.encode(`home-compute-vault\n${name}\n${keyId}`);
}

export function checkSecretName(name) {
  if (typeof name !== "string" || !SECRET_NAME.test(name)) {
    throw new VaultError(`Invalid secret name ${JSON.stringify(name)}: lower-case letters, digits, '.', '_' and '-', up to 63`, "invalid_name");
  }
  return name;
}

/**
 * Seals `value` under the vault's public key: `{envelope, keyId}`, where the
 * envelope is `base64(RSA-OAEP(dataKey)).base64(iv).base64(AES-GCM(value))`.
 */
export async function sealSecret(name, value, publicKeySpki) {
  checkSecretName(name);
  if (typeof value !== "string" || !value.length) throw new VaultError("A secret's value must be a non-empty string", "invalid_value");
  const plain = encoder.encode(value);
  if (plain.length > MAX_SECRET_BYTES) throw new VaultError(`A secret's value is at most ${MAX_SECRET_BYTES} bytes`, "invalid_value");
  const { key, keyId } = await sealer(publicKeySpki);
  const dataKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aes = await crypto.subtle.importKey("raw", dataKey, "AES-GCM", false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: additionalData(name, keyId) }, aes, plain);
  const wrapped = await crypto.subtle.encrypt(RSA, key, dataKey);
  dataKey.fill(0);
  return { envelope: [toBase64(wrapped), toBase64(iv), toBase64(ciphertext)].join("."), keyId };
}

function envelopeParts(name, envelope) {
  const parts = String(envelope).split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) throw new VaultError(`${name}: malformed envelope`, "malformed_envelope");
  return parts;
}

/**
 * The envelope's data key, unwrapped with the private key, as a
 * non-extractable AES-GCM key (it can decrypt, never be exported). This is
 * the RSA operation, the expensive part of opening a secret.
 */
export async function unwrapDataKey(name, envelope, keyId, privateKeyPkcs8) {
  const { key, keyId: ours } = await opener(privateKeyPkcs8);
  if (keyId !== ours) throw new VaultError(`${name} was sealed under vault key ${keyId}, but hc-core holds ${ours}`, "wrong_key");
  const [wrapped] = envelopeParts(name, envelope);
  let raw;
  try {
    raw = new Uint8Array(await crypto.subtle.decrypt(RSA, key, fromBase64(wrapped)));
  } catch {
    throw new VaultError(`${name}: the envelope does not open (wrong key or altered)`, "undecryptable");
  }
  try {
    return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  } finally {
    raw.fill(0);
  }
}

/** Decrypts the envelope's value with its (unwrapped) data key; the name and key id must be the ones it was sealed for. */
export async function openWithDataKey(name, envelope, keyId, dataKey) {
  const [, iv, ciphertext] = envelopeParts(name, envelope);
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv), additionalData: additionalData(name, keyId) },
      dataKey, fromBase64(ciphertext));
    return decoder.decode(plain);
  } catch {
    throw new VaultError(`${name}: the envelope does not open (wrong name or altered)`, "undecryptable");
  }
}

/** Opens an envelope sealed by `sealSecret` for the secret `name` under key `keyId`. */
export async function openSecret(name, envelope, keyId, privateKeyPkcs8) {
  return openWithDataKey(name, envelope, keyId, await unwrapDataKey(name, envelope, keyId, privateKeyPkcs8));
}

/**
 * What the dashboard may show of a value: the last four characters of an
 * identifier ("…7Q2A"), never anything of a secret key, a password or a
 * locator. Only names that say they are an id or a user get a hint, and only
 * when the value is long enough that four characters give nothing away.
 */
export function secretHint(name, value) {
  if (!/(^|[-_.])(id|key-id|user|username|client-id)$/.test(name)) return null;
  if (typeof value !== "string" || value.length < 16) return null;
  return `…${value.slice(-4)}`;
}

/** The `vault:` secret names a job definition needs: its secret environment and its registry credential, sorted. */
export function vaultNames(job) {
  const references = [...Object.values(job?.secretEnv ?? {}), ...(job?.registryAuth ? [job.registryAuth] : [])];
  const names = references.filter((reference) => reference.startsWith("vault:")).map((reference) => reference.slice(6));
  return [...new Set(names)].sort();
}

/** A registry credential secret's value, checked: `{server, username, password}` as JSON; else null. */
export function parseRegistryAuth(value) {
  try {
    const auth = JSON.parse(value);
    const ok = auth && typeof auth === "object" && ["server", "username", "password"].every((key) => typeof auth[key] === "string" && auth[key])
      && /^[a-z0-9.-]+(:\d+)?$/i.test(auth.server);
    return ok ? { server: auth.server, username: auth.username, password: auth.password } : null;
  } catch {
    return null;
  }
}

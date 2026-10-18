// Pulling an OCI image without a daemon: the registry HTTP API (the same
// conversation `docker pull` has with ghcr.io or Docker Hub), then the
// layer tar, applied in order with whiteouts. Nothing here shells out, so a
// machine whose only job runner is this process can still fetch an image.
//
// A registry credential is the claim's `registryAuth` (`{server, username,
// password}`), used once for the token exchange and never written down.

import { createHash } from "node:crypto";
import { chmod, link as hardLink, lstat, mkdir, open, readdir, realpath, rm, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { createGunzip } from "node:zlib";
import { parseImageRef } from "./images.mjs";

const DOCKER_HUB = "registry-1.docker.io";
const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
const INDEX_TYPES = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);
const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** `busybox`, `ghcr.io/a/b:tag@sha256:…` → the registry host, repository and tag or digest. */
export function normalizeImageRef(reference) {
  const parsed = parseImageRef(reference);
  const name = parsed.repo;
  const firstSlash = name.indexOf("/");
  const first = firstSlash < 0 ? name : name.slice(0, firstSlash);
  const explicit = first.includes(".") || first.includes(":") || first === "localhost";
  let registry;
  let repository;
  if (!explicit) {
    registry = DOCKER_HUB;
    repository = firstSlash < 0 ? `library/${name}` : name;
  } else if (first === "docker.io") {
    registry = DOCKER_HUB;
    repository = name.slice("docker.io/".length);
  } else {
    registry = first;
    repository = name.slice(first.length + 1);
  }
  if (!repository) throw new Error(`image reference ${reference} has no repository`);
  const repo = registry === DOCKER_HUB ? `docker.io/${repository}` : `${registry}/${repository}`;
  return {
    raw: String(reference), registry, repository, repo,
    tag: parsed.digest ? null : (parsed.tag ?? "latest"),
    digest: parsed.digest,
    secure: !(registry.startsWith("localhost") || registry.startsWith("127.0.0.1")),
  };
}

/** The image config's command, with a spec's entrypoint and args applied the way `docker run` does. */
export function jobCommand(imageConfig, spec = {}) {
  const config = imageConfig?.config ?? imageConfig ?? {};
  const entrypoint = (config.Entrypoint ?? []).map(String);
  const cmd = (config.Cmd ?? []).map(String);
  const userEntrypoint = Array.isArray(spec.entrypoint) && spec.entrypoint.length ? spec.entrypoint.map(String) : null;
  const userArgs = (spec.args ?? []).map(String);
  if (userEntrypoint) return [...userEntrypoint, ...userArgs];
  if (userArgs.length) return [...entrypoint, ...userArgs];
  const command = [...entrypoint, ...cmd];
  if (!command.length) throw new Error("the image has no entrypoint or command");
  return command;
}

/** Image env, then the spec's env, then its secrets (a secret wins). PATH is filled in when the image sets none. */
export function jobEnv(imageConfig, spec = {}) {
  const config = imageConfig?.config ?? imageConfig ?? {};
  const env = {};
  for (const entry of config.Env ?? []) {
    const eq = String(entry).indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  if (!env.PATH) env.PATH = DEFAULT_PATH;
  for (const [name, value] of Object.entries(spec.env ?? {})) env[name] = String(value);
  for (const [name, value] of Object.entries(spec.secretEnv ?? {})) env[name] = String(value);
  return env;
}

export function jobWorkdir(imageConfig) {
  const dir = imageConfig?.config?.WorkingDir ?? imageConfig?.WorkingDir;
  return dir ? String(dir) : "/";
}

/** `user`, `uid` or `uid:gid` from the image config. Empty means root, as Docker does. */
export function jobUser(imageConfig) {
  return String(imageConfig?.config?.User ?? imageConfig?.User ?? "");
}

/** `WWW-Authenticate: Bearer realm="…",service="…",scope="…"`. */
export function parseWwwAuthenticate(header) {
  const text = String(header ?? "");
  const scheme = text.match(/^\s*([A-Za-z]+)/)?.[1] ?? "";
  const params = {};
  for (const match of text.matchAll(/([A-Za-z][A-Za-z0-9_-]*)\s*=\s*"([^"]*)"/g)) params[match[1].toLowerCase()] = match[2];
  return { scheme: scheme.toLowerCase(), ...params };
}

/** Whether `auth` (a claim's registryAuth) is for this registry host. */
export function authForRegistry(auth, registry) {
  if (!auth?.password) return null;
  if (!auth.server) return auth;
  const server = String(auth.server).replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const host = registry.replace(/:\d+$/, "");
  const serverHost = server.replace(/:\d+$/, "");
  const dockerHub = registry === DOCKER_HUB && (serverHost === "docker.io" || serverHost === "index.docker.io" || serverHost === "registry-1.docker.io");
  if (server === registry || serverHost === host || dockerHub) return auth;
  return null;
}

/** linux/amd64 (Node's `x64`) out of an index or manifest list. */
export function chooseManifest(index, { os = "linux", arch = process.arch } = {}) {
  const architecture = arch === "x64" ? "amd64" : arch;
  const manifests = (index?.manifests ?? []).filter((entry) => entry.platform?.os === os && entry.platform?.architecture === architecture);
  return manifests.find((entry) => !entry.platform?.variant) ?? manifests[0] ?? null;
}

function registryUrl(spec, pathname) {
  const base = `${spec.secure ? "https" : "http"}://${spec.registry}`;
  return `${base}${pathname}`;
}

/**
 * One registry pull. `fetch` is injectable. Resolves `{digest, config, rootfs}`
 * where `rootfs` is the directory the layers were unpacked into and `digest`
 * is the manifest the layers belong to (a tag's, or the pinned one).
 */
export async function pullImage(reference, { auth = null, rootfs, timeoutMs = 20 * 60_000, fetch: fetchImpl = globalThis.fetch, arch = process.arch } = {}) {
  const spec = normalizeImageRef(reference);
  const signal = AbortSignal.timeout(timeoutMs);
  const client = new RegistryClient(spec, authForRegistry(auth, spec.registry), fetchImpl, signal);
  let manifest = await client.manifest(spec.digest ?? spec.tag);
  const type = manifest.mediaType ?? manifest.body.mediaType ?? "";
  if (INDEX_TYPES.has(type) || Array.isArray(manifest.body.manifests)) {
    const chosen = chooseManifest(manifest.body, { arch });
    if (!chosen?.digest) throw new Error(`${reference} has no ${arch} Linux image`);
    manifest = await client.manifest(chosen.digest);
  }
  const configDigest = manifest.body.config?.digest;
  if (!configDigest) throw new Error(`${reference} is not an image manifest`);
  const configBytes = await client.blob(configDigest);
  const config = JSON.parse(configBytes.toString("utf8"));
  await mkdir(rootfs, { recursive: true });
  for (const layer of manifest.body.layers ?? []) {
    await client.blobStream(layer.digest, layer.mediaType, async (stream) => {
      await extractTar(stream, rootfs);
    });
  }
  return { digest: manifest.digest, config, rootfs };
}

class RegistryClient {
  constructor(spec, auth, fetchImpl, signal) {
    this.spec = spec;
    this.auth = auth;
    this.fetchImpl = fetchImpl;
    this.signal = signal;
    this.token = null;
    this.basic = Boolean(auth);
  }

  async manifest(reference) {
    const url = registryUrl(this.spec, `/v2/${this.spec.repository}/manifests/${reference}`);
    const response = await this.#request(url, { accept: MANIFEST_ACCEPT });
    if (!response.ok) throw new Error(`manifest ${reference}: ${response.status} ${await safeText(response)}`);
    const digest = response.headers.get("docker-content-digest")
      ?? response.headers.get("oci-content-digest")
      ?? (reference.startsWith("sha256:") ? reference : null);
    const body = await response.json();
    const bytes = Buffer.from(JSON.stringify(body));
    // A registry that omits the digest header still names a pinned manifest; a tag's digest is the header.
    return { body, mediaType: response.headers.get("content-type")?.split(";")[0].trim() ?? body.mediaType ?? "", digest, bytes };
  }

  async blob(digest) {
    const chunks = [];
    await this.blobStream(digest, "", async (stream) => {
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    });
    return Buffer.concat(chunks);
  }

  /** Checks the digest of the compressed blob, then hands the tar bytes (gunzipped when the layer says so) to `consume`. */
  async blobStream(digest, mediaType, consume) {
    const url = registryUrl(this.spec, `/v2/${this.spec.repository}/blobs/${digest}`);
    const response = await this.#request(url, { accept: "application/octet-stream" });
    if (!response.ok) throw new Error(`blob ${digest}: ${response.status} ${await safeText(response)}`);
    const { transform, checked } = hashCheck(digest);
    const source = Readable.fromWeb(response.body);
    const compression = layerCompression(mediaType);
    if (compression === "zstd") throw new Error(`layer ${digest} is zstd; this agent unpacks gzip and uncompressed layers`);
    const decoded = compression === "gzip" ? source.pipe(transform).pipe(createGunzip()) : source.pipe(transform);
    await Promise.all([consume(decoded), checked]);
  }

  async #request(url, { accept }) {
    const headers = { accept };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    else if (this.basic && this.auth) headers.authorization = basic(this.auth);
    let response = await this.fetchImpl(url, { headers, signal: this.signal, redirect: "follow" });
    if (response.status !== 401) return response;
    await this.#authenticate(response);
    const retry = { accept };
    if (this.token) retry.authorization = `Bearer ${this.token}`;
    else if (this.auth) retry.authorization = basic(this.auth);
    response = await this.fetchImpl(url, { headers: retry, signal: this.signal, redirect: "follow" });
    return response;
  }

  /** Turns a 401 challenge into a bearer token. Basic is kept for registries that ask for it. */
  async #authenticate(response) {
    const challenge = parseWwwAuthenticate(response.headers.get("www-authenticate"));
    if (challenge.scheme === "basic") {
      this.token = null;
      this.basic = true;
      return;
    }
    if (challenge.scheme !== "bearer" || !challenge.realm) {
      throw new Error("the registry refused the request and did not offer a bearer token");
    }
    const tokenUrl = new URL(challenge.realm);
    if (challenge.service) tokenUrl.searchParams.set("service", challenge.service);
    if (challenge.scope) tokenUrl.searchParams.set("scope", challenge.scope);
    const headers = {};
    if (this.auth) headers.authorization = basic(this.auth);
    const tokenResponse = await this.fetchImpl(tokenUrl, { headers, signal: this.signal });
    if (!tokenResponse.ok) throw new Error(`registry login failed: ${tokenResponse.status} ${await safeText(tokenResponse)}`);
    const body = await tokenResponse.json();
    const token = body.token ?? body.access_token;
    if (!token) throw new Error("registry login returned no token");
    this.token = token;
    this.basic = false;
  }
}

function basic(auth) {
  return `Basic ${Buffer.from(`${auth.username ?? ""}:${auth.password}`).toString("base64")}`;
}

async function safeText(response) {
  const text = await response.text().catch(() => "");
  return text.replace(/\s+/g, " ").slice(0, 200);
}

function layerCompression(mediaType) {
  const type = String(mediaType ?? "");
  if (type.endsWith("+gzip") || type.endsWith(".gzip")) return "gzip";
  if (type.endsWith("+zstd") || type.endsWith(".zstd")) return "zstd";
  return "none";
}

/** A stream transform that resolves once the bytes through it hash to `digest`, and rejects when they do not. */
export function hashCheck(digest) {
  const split = String(digest ?? "").split(":");
  const algo = split[0];
  const expected = split[1];
  if (!algo || !expected) throw new Error(`blob digest ${digest} is not algorithm:hex`);
  const hash = createHash(algo);
  let settle;
  const checked = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      const got = hash.digest("hex");
      if (got !== expected) settle.reject(new Error(`blob ${digest} did not match (got ${algo}:${got})`));
      else settle.resolve();
      callback();
    },
  });
  return { transform, checked };
}

// ---------- tar (ustar, GNU long names, pax) and OCI whiteouts

function readString(buffer, offset, length) {
  let end = offset + length;
  for (let index = offset; index < offset + length; index += 1) {
    if (buffer[index] === 0) { end = index; break; }
  }
  return buffer.toString("utf8", offset, end);
}

function readNumeric(buffer, offset, length) {
  // A high bit marks a base-256 size (GNU), used once a file passes the octal field.
  if (buffer[offset] & 0x80) {
    let value = 0n;
    const negative = buffer[offset] & 0x40;
    for (let index = 0; index < length; index += 1) {
      const byte = index === 0 ? buffer[offset] & 0x3f : buffer[offset + index];
      value = (value << 8n) + BigInt(byte);
    }
    if (negative) value = -value;
    return Number(value);
  }
  const text = buffer.toString("ascii", offset, offset + length).replace(/\0.*/, "").trim();
  if (!text) return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value)) throw new Error("tar header has a size that is not a number");
  return value;
}

function headerChecksum(header) {
  let sum = 0;
  for (let index = 0; index < 512; index += 1) sum += (index >= 148 && index < 156) ? 32 : header[index];
  return sum;
}

class ByteQueue {
  constructor(stream) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.chunks = [];
    this.length = 0;
    this.done = false;
  }

  async #pull() {
    if (this.done) return;
    const next = await this.iterator.next();
    if (next.done) { this.done = true; return; }
    const chunk = Buffer.from(next.value);
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  #consume(count) {
    const out = Buffer.allocUnsafe(count);
    let filled = 0;
    while (filled < count) {
      const chunk = this.chunks[0];
      const take = Math.min(chunk.length, count - filled);
      chunk.copy(out, filled, 0, take);
      filled += take;
      if (take === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(take);
    }
    this.length -= count;
    return out;
  }

  /** The next `count` bytes, or null at a clean end (nothing, or only the tar's trailing zeros). */
  async take(count) {
    while (this.length < count && !this.done) await this.#pull();
    if (this.length < count) {
      if (this.length === 0) return null;
      const rest = this.#consume(this.length);
      if (rest.every((byte) => byte === 0)) return null;
      throw new Error("truncated tar archive");
    }
    return this.#consume(count);
  }
}

function safeRelative(name) {
  // Image layers name the archive root as `./` or `/`. `.` and empty pieces are that directory, not an escape.
  const parts = [];
  for (const part of String(name ?? "").split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." || part.includes("\0")) throw new Error(`tar entry ${name} escapes the rootfs`);
    parts.push(part);
  }
  return parts;
}

/** Refuses a path whose real parent sits outside `rootReal` (a symlink planted by an earlier layer). */
async function destination(root, rootReal, parts) {
  let current = root;
  let currentReal = rootReal;
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = path.join(current, parts[index]);
    let info;
    try { info = await lstat(current); } catch { info = null; }
    if (!info) {
      await mkdir(current, { recursive: true });
      currentReal = await realpath(current);
    } else if (info.isSymbolicLink()) {
      currentReal = await realpath(current);
    } else {
      currentReal = path.join(currentReal, parts[index]);
    }
    if (currentReal !== rootReal && !currentReal.startsWith(`${rootReal}${path.sep}`)) {
      throw new Error(`tar entry ${parts.join("/")} escapes the rootfs through a symlink`);
    }
  }
  return path.join(current, parts.at(-1));
}

async function removeEntry(target) {
  let info;
  try { info = await lstat(target); } catch { return; }
  if (info.isSymbolicLink() || info.isFile()) await unlink(target);
  else await rm(target, { recursive: true, force: true });
}

/**
 * Unpacks a tar stream into `root`, applying OCI whiteouts as they appear:
 * `.wh.<name>` deletes that sibling, `.wh..wh..opq` hides everything the
 * lower layers had put in the directory. An entry that would leave `root`
 * (absolute, `..`, or a symlink that points out) is refused.
 */
export async function extractTar(stream, root) {
  await mkdir(root, { recursive: true });
  const rootReal = await realpath(root);
  const queue = new ByteQueue(stream);
  let longName = null;
  let longLink = null;
  const pax = {};
  for (;;) {
    const header = await queue.take(512);
    if (!header || header.every((byte) => byte === 0)) break;
    const stored = readNumeric(header, 148, 8);
    if (stored !== headerChecksum(header)) throw new Error("tar header checksum does not match");
    const type = String.fromCharCode(header[156] || 0x30);
    const size = Number(pax.size ?? readNumeric(header, 124, 12));
    const name = longName ?? pax.path ?? (readString(header, 345, 155)
      ? `${readString(header, 345, 155)}/${readString(header, 0, 100)}`
      : readString(header, 0, 100));
    const link = longLink ?? pax.linkpath ?? readString(header, 157, 100);
    longName = null;
    longLink = null;
    const dataBlocks = Math.ceil(size / 512);
    const raw = dataBlocks ? await queue.take(dataBlocks * 512) : Buffer.alloc(0);
    if (dataBlocks && !raw) throw new Error("truncated tar archive");
    const data = raw.subarray(0, size);
    if (type === "g" || type === "x") {
      const records = parsePax(data);
      if (type === "g") Object.assign(pax, records);
      else {
        // Extended headers describe the next entry only.
        Object.assign(pax, records);
        longName = records.path ?? longName;
        longLink = records.linkpath ?? longLink;
      }
      continue;
    }
    const entryPax = { ...pax };
    for (const key of ["path", "linkpath", "size"]) delete pax[key];
    if (type === "L") { longName = data.toString("utf8").replace(/\0+$/, ""); continue; }
    if (type === "K") { longLink = data.toString("utf8").replace(/\0+$/, ""); continue; }
    if (type === "5" && (name === "././@PaxHeader" || name === "././@LongLink")) continue;
    const parts = safeRelative(name);
    if (!parts.length) continue;
    const base = parts.at(-1);
    const target = await destination(root, rootReal, parts);
    if (base === ".wh..wh..opq") {
      const dir = path.dirname(target);
      await mkdir(dir, { recursive: true });
      for (const entry of await readdir(dir)) await removeEntry(path.join(dir, entry));
      continue;
    }
    if (base.startsWith(".wh.")) {
      await removeEntry(path.join(path.dirname(target), base.slice(4)));
      continue;
    }
    const mode = Number(entryPax.mode ?? readNumeric(header, 100, 8)) & 0o7777;
    if (type === "5") {
      await mkdir(target, { recursive: true });
      await chmodQuiet(target, mode || 0o755);
      continue;
    }
    if (type === "2") {
      await mkdir(path.dirname(target), { recursive: true });
      await removeEntry(target);
      await symlink(link, target);
      continue;
    }
    if (type === "1") {
      await mkdir(path.dirname(target), { recursive: true });
      await removeEntry(target);
      const sourceParts = safeRelative(link);
      const source = await destination(root, rootReal, sourceParts);
      await hardLink(source, target);
      continue;
    }
    if (type === "0" || type === "\0" || type === "7") {
      await mkdir(path.dirname(target), { recursive: true });
      await removeEntry(target);
      const handle = await open(target, "wx", mode || 0o644);
      try {
        await handle.writeFile(data);
        if (mode) await handle.chmod(mode);
      } finally {
        await handle.close();
      }
      continue;
    }
    // Devices, fifos: a job does not get the host's devices from a layer.
  }
}

function parsePax(data) {
  const records = {};
  const text = data.toString("utf8");
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(" ", offset);
    if (space < 0) break;
    const length = Number.parseInt(text.slice(offset, space), 10);
    if (!length) break;
    const record = text.slice(offset, offset + length);
    const eq = record.indexOf("=");
    if (eq > 0) records[record.slice(space + 1, eq)] = record.slice(eq + 1).replace(/\n$/, "");
    offset += length;
  }
  return records;
}

async function chmodQuiet(target, mode) {
  try {
    await chmod(target, mode);
  } catch {
    // A file we cannot chmod still runs when it is readable.
  }
}

/** Builds a ustar archive. Names that fit the prefix field are written that way; longer ones as GNU long-name entries. */
export function packTar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const name = String(entry.name);
    const type = entry.type ?? (entry.link ? "2" : (name.endsWith("/") ? "5" : "0"));
    const body = entry.data == null || type === "5" || type === "2" || type === "1" ? Buffer.alloc(0) : Buffer.from(entry.data);
    if (name.length > 100) {
      const long = Buffer.from(`${name}\0`);
      blocks.push(tarHeader("././@LongLink", "L", long.length, ""));
      blocks.push(long, padding(long.length));
    }
    blocks.push(tarHeader(name, type, body.length, entry.link ?? "", entry.mode));
    if (body.length) {
      blocks.push(body, padding(body.length));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks.filter((block) => block.length));
}

function padding(size) {
  const extra = (512 - (size % 512)) % 512;
  return extra ? Buffer.alloc(extra) : Buffer.alloc(0);
}

function tarHeader(name, type, size, linkName, mode) {
  const header = Buffer.alloc(512);
  const [prefix, base] = splitName(name);
  header.write(base, 0, "utf8");
  writeOctal(header, 100, mode ?? (type === "5" ? 0o755 : 0o644), 8);
  writeOctal(header, 108, 0, 8);
  writeOctal(header, 116, 0, 8);
  writeOctal(header, 124, size, 12);
  writeOctal(header, 136, 0, 12);
  header[156] = type.charCodeAt(0);
  if (linkName) header.write(linkName, 157, "utf8");
  header.write("ustar\0", 257, "binary");
  header.write("00", 263, "binary");
  if (prefix) header.write(prefix, 345, "utf8");
  const sum = headerChecksum(header).toString(8).padStart(6, "0");
  header.write(sum, 148, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function splitName(name) {
  if (name.length <= 100) return ["", name];
  const slash = name.lastIndexOf("/", name.length - 101);
  if (slash > 0 && slash <= 155 && name.length - slash - 1 <= 100) return [name.slice(0, slash), name.slice(slash + 1)];
  // The GNU long-name entry carries the real name; the ustar header still needs something short.
  return ["", name.slice(0, 100)];
}

function writeOctal(buffer, offset, value, length) {
  const text = Math.max(0, value).toString(8).padStart(length - 1, "0").slice(-(length - 1));
  buffer.write(text, offset, "ascii");
  buffer[offset + length - 1] = 0;
}


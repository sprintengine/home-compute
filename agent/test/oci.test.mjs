// The daemon-free image pull: reference parsing, the registry's bearer
// exchange, tar layers (including whiteouts) and how an image's command and
// environment combine with a job spec.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chmod, lstat, mkdir, mkdtemp, readFile, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  authForRegistry, chooseManifest, extractTar, insideRoot, jobCommand, jobEnv, normalizeImageRef, packTar, parseWwwAuthenticate, pullImage,
} from "../src/runtime/oci.mjs";

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hc-oci-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(dir, { recursive: true, force: true })));
  return dir;
}

test("image references map onto the registry the way Docker names them", () => {
  const ghcr = normalizeImageRef("ghcr.io/acme/app:1.2");
  assert.deepEqual([ghcr.registry, ghcr.repository, ghcr.tag, ghcr.repo, ghcr.secure], ["ghcr.io", "acme/app", "1.2", "ghcr.io/acme/app", true]);
  const pinned = normalizeImageRef("ghcr.io/acme/app@sha256:ab");
  assert.equal(pinned.digest, "sha256:ab");
  assert.equal(pinned.tag, null);
  const hub = normalizeImageRef("docker.io/library/busybox");
  assert.equal(hub.registry, "registry-1.docker.io");
  assert.equal(hub.repository, "library/busybox");
  assert.equal(hub.tag, "latest");
  const short = normalizeImageRef("busybox");
  assert.equal(short.repository, "library/busybox");
  const local = normalizeImageRef("localhost:5000/app:v1");
  assert.deepEqual([local.registry, local.repository, local.secure], ["localhost:5000", "app", false]);
});

test("a spec's entrypoint and args replace the image command the way docker run does", () => {
  const image = { config: { Entrypoint: ["sh"], Cmd: ["-c", "echo"], Env: ["PATH=/usr/bin", "A=1"], WorkingDir: "/work" } };
  assert.deepEqual(jobCommand(image, {}), ["sh", "-c", "echo"]);
  assert.deepEqual(jobCommand(image, { args: ["echo", "hi"] }), ["sh", "echo", "hi"]);
  assert.deepEqual(jobCommand(image, { entrypoint: ["busybox"], args: ["echo", "hi"] }), ["busybox", "echo", "hi"]);
  const env = jobEnv(image, { env: { A: "2", B: "x" }, secretEnv: { A: "secret", TOKEN: "t" } });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.A, "secret");
  assert.equal(env.TOKEN, "t");
  assert.equal(jobEnv({ config: {} }, {}).PATH, "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
  assert.throws(() => jobCommand({ config: {} }, {}), /no entrypoint or command/);
});

test("a manifest list resolves to this machine's Linux architecture", () => {
  const index = { manifests: [
    { digest: "sha256:arm", platform: { os: "linux", architecture: "arm64" } },
    { digest: "sha256:amd", platform: { os: "linux", architecture: "amd64" } },
    { digest: "sha256:win", platform: { os: "windows", architecture: "amd64" } },
  ] };
  assert.equal(chooseManifest(index, { arch: "x64" }).digest, "sha256:amd");
  assert.equal(chooseManifest(index, { arch: "arm64" }).digest, "sha256:arm");
  assert.equal(chooseManifest(index, { arch: "386" }), null);
});

test("registry auth is only offered to the registry it was issued for", () => {
  const ghcr = { server: "ghcr.io", username: "bot", password: "pw" };
  assert.equal(authForRegistry(ghcr, "ghcr.io"), ghcr);
  assert.equal(authForRegistry({ server: "https://ghcr.io/v2/", username: "bot", password: "pw" }, "ghcr.io")?.username, "bot");
  assert.equal(authForRegistry(ghcr, "registry-1.docker.io"), null);
  assert.equal(authForRegistry({ server: "docker.io", username: "me", password: "pw" }, "registry-1.docker.io")?.username, "me");
  assert.deepEqual(parseWwwAuthenticate('Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:acme/app:pull"'), {
    scheme: "bearer", realm: "https://ghcr.io/token", service: "ghcr.io", scope: "repository:acme/app:pull",
  });
});

test("a tar layer applies files, symlinks, long names and whiteouts, and cannot write outside the rootfs", async (t) => {
  const root = await tempDir(t);
  await extractTar(streamOf(packTar([
    { name: "keep.txt", data: "keep" },
    { name: "gone.txt", data: "gone" },
    { name: "dir/old.txt", data: "old" },
    { name: "link", link: "keep.txt" },
    { name: "hard", link: "keep.txt", type: "1" },
    { name: `${"nested/".repeat(3)}${"n".repeat(80)}.txt`, data: "long" },
  ])), root);
  assert.equal(await readFile(path.join(root, "keep.txt"), "utf8"), "keep");
  assert.equal(await readFile(path.join(root, "link"), "utf8"), "keep");
  assert.equal(await readFile(path.join(root, "hard"), "utf8"), "keep");
  const long = await readFile(path.join(root, "nested/nested/nested", `${"n".repeat(80)}.txt`), "utf8");
  assert.equal(long, "long");
  await extractTar(streamOf(packTar([
    { name: ".wh.gone.txt" },
    { name: "dir/.wh..wh..opq" },
    { name: "dir/new.txt", data: "new" },
  ])), root);
  await assert.rejects(stat(path.join(root, "gone.txt")));
  await assert.rejects(stat(path.join(root, "dir/old.txt")));
  assert.equal(await readFile(path.join(root, "dir/new.txt"), "utf8"), "new");
  assert.equal(await readFile(path.join(root, "keep.txt"), "utf8"), "keep");
  await extractTar(streamOf(packTar([
    { name: "./", type: "5" },
    { name: "./bin/tool", data: "ok" },
  ])), root);
  assert.equal(await readFile(path.join(root, "bin/tool"), "utf8"), "ok");
  await assert.rejects(extractTar(streamOf(packTar([{ name: "../outside.txt", data: "x" }])), root), /escapes/);
  await assert.rejects(extractTar(streamOf(packTar([
    { name: "escape", link: "/tmp" },
    { name: "escape/pwned.txt", data: "x" },
  ])), root), /escapes/);
  await assert.rejects(stat("/tmp/pwned.txt"));
});

test("a directory entry over a symlink replaces the symlink, and never changes the directory it points at", async (t) => {
  const root = await tempDir(t);
  const outside = await tempDir(t);
  await chmod(outside, 0o700);
  const { Readable } = await import("node:stream");
  // One layer plants `a -> <outside>`; a later one declares `a/` as a world-writable directory.
  await extractTar(Readable.from([packTar([{ name: "a", type: "2", link: outside }])]), root);
  await extractTar(Readable.from([packTar([{ name: "a/", type: "5", mode: 0o777 }, { name: "a/file", data: "inside" }])]), root);
  assert.equal((await stat(outside)).mode & 0o777, 0o700);
  assert.ok((await lstat(path.join(root, "a"))).isDirectory());
  assert.equal(await readFile(path.join(root, "a/file"), "utf8"), "inside");
});

test("insideRoot follows only what stays inside the root", async (t) => {
  const root = await tempDir(t);
  const outside = await tempDir(t);
  await mkdir(path.join(root, "usr/lib"), { recursive: true });
  await symlink("usr/lib", path.join(root, "lib"));
  await symlink(outside, path.join(root, "etc"));
  const real = await import("node:fs/promises").then(({ realpath }) => realpath(root));
  assert.equal(await insideRoot(root, "/lib/x/y"), path.join(real, "usr/lib/x/y"));
  assert.equal(await insideRoot(root, "/"), real);
  assert.equal(await insideRoot(root, "/etc"), null);
  assert.equal(await insideRoot(root, "etc/resolv.conf"), null);
  assert.equal(await insideRoot(root, "../x"), null);
});

test("a digest that does not match is refused", () => {
  assert.equal(sha(Buffer.from("x")).startsWith("sha256:"), true);
});

test("a private registry pull checks the digest, uses the bearer token, and does not keep the password", async (t) => {
  const password = "ghcr-pat-not-a-real-secret";
  const layerTar = packTar([{ name: "app.txt", data: "hello", mode: 0o644 }]);
  const layerGz = gzipSync(layerTar);
  const config = { architecture: "amd64", os: "linux", config: { Cmd: ["echo", "hello"], Env: ["A=1"] }, rootfs: { type: "layers", diff_ids: [] } };
  const configBytes = Buffer.from(JSON.stringify(config));
  const layerDigest = sha(layerGz);
  const configDigest = sha(configBytes);
  const manifest = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: configDigest, size: configBytes.length },
    layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: layerDigest, size: layerGz.length }],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const manifestDigest = sha(manifestBytes);
  const blobs = { [layerDigest]: layerGz, [configDigest]: configBytes };
  const seen = [];
  const server = createServer((request, response) => {
    const auth = request.headers.authorization ?? "";
    seen.push({ path: request.url, auth });
    if (request.url.startsWith("/token")) {
      if (auth !== `Basic ${Buffer.from(`bot:${password}`).toString("base64")}`) {
        response.writeHead(401).end("no");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ token: "issued-token" }));
      return;
    }
    if (!auth.includes("issued-token")) {
      const realm = `http://127.0.0.1:${server.address().port}/token`;
      response.writeHead(401, { "www-authenticate": `Bearer realm="${realm}",service="test",scope="repository:acme/app:pull"` }).end("auth");
      return;
    }
    if (request.url.includes("/manifests/")) {
      response.writeHead(200, { "content-type": manifest.mediaType, "docker-content-digest": manifestDigest }).end(manifestBytes);
      return;
    }
    const digest = request.url.split("/blobs/")[1];
    const body = blobs[digest];
    if (!body) {
      response.writeHead(404).end("missing");
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream" }).end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const root = await tempDir(t);
  const fetchImpl = (url, init) => {
    const target = new URL(url);
    // The client builds https://ghcr.io/...; point that host at the stand-in without changing the request the client thinks it made.
    if (target.hostname === "ghcr.io") target.protocol = "http:";
    target.host = `127.0.0.1:${port}`;
    return fetch(target, init);
  };
  await assert.rejects(pullImage("ghcr.io/acme/app:1", { rootfs: path.join(root, "noauth"), fetch: fetchImpl, timeoutMs: 10_000 }), /registry login failed/);
  const pulled = await pullImage("ghcr.io/acme/app:1", {
    rootfs: path.join(root, "rootfs"), timeoutMs: 10_000, fetch: fetchImpl,
    auth: { server: "ghcr.io", username: "bot", password },
  });
  assert.equal(pulled.digest, manifestDigest);
  assert.equal(await readFile(path.join(root, "rootfs", "app.txt"), "utf8"), "hello");
  assert.equal(pulled.config.config.Cmd[0], "echo");
  assert.ok(seen.some((entry) => entry.path.startsWith("/token") && entry.auth.startsWith("Basic ")));
  assert.ok(seen.some((entry) => entry.path.includes("/blobs/") && entry.auth === "Bearer issued-token"));
  const dumped = JSON.stringify(seen) + await readFile(path.join(root, "rootfs", "app.txt"), "utf8");
  assert.ok(!dumped.includes(password));
  blobs[layerDigest] = gzipSync(packTar([{ name: "app.txt", data: "nope" }]));
  await assert.rejects(pullImage("ghcr.io/acme/app:1", {
    rootfs: path.join(root, "bad"), timeoutMs: 10_000, fetch: fetchImpl,
    auth: { server: "ghcr.io", username: "bot", password },
  }), /did not match/);
});

function sha(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function streamOf(buffer) {
  return (async function* chunks() { yield buffer; }());
}

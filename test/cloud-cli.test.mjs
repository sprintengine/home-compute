import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { accessHeaders, cloudCommand, formatImport } from "../src/cloud-cli.mjs";

const FIXTURE = path.resolve(import.meta.dirname, "fixtures/wingfoil-home-compute.json");
const environment = { HC_URL: "https://hc.example.com/", HC_ACCESS_CLIENT_ID: "id.access", HC_ACCESS_CLIENT_SECRET: "s3cret" };

function output() {
  let text = "";
  return { write(chunk) { text += chunk; }, get text() { return text; } };
}

const plan = {
  dryRun: true, preset: "wingfoil", notInFile: ["hello"],
  summary: { create: 0, update: 1, kept: 1, unchanged: 1 },
  jobs: [
    { id: "ecmwf", action: "update", changes: [{ field: "image", before: "x:1", after: "x:2" }],
      kept: [{ field: "schedule", before: { at: { minutes: [25] } }, after: { at: { minutes: [30] } }, reason: "edited since the last import" }] },
    { id: "gfs", action: "kept", changes: [], kept: [{ field: "enabled", before: false, after: true }] },
    { id: "tides", action: "unchanged", changes: [], kept: [], warnings: ["optional S3_PREFIX not set by the preset, so not passed"] },
  ],
};

test("cloud import sends the job set, the preset and the image to /v1/import with the service token", async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(plan), { status: 200 });
  };
  const stdout = output();
  await cloudCommand(["import", FIXTURE, "--preset", "wingfoil", "--image", "ghcr.io/x@sha256:1", "--dry-run", "--force"],
    { environment, fetcher, stdout });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://hc.example.com/v1/import?dryRun=1");
  assert.equal(calls[0].init.headers["cf-access-client-id"], "id.access");
  assert.equal(calls[0].init.headers["cf-access-client-secret"], "s3cret");
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(body), ["config", "preset", "variables", "force"]);
  assert.deepEqual(Object.keys(body.config), ["jobs"], "only the jobs leave the machine, not its local settings");
  assert.equal(body.config.jobs.length, 21);
  assert.equal(body.preset.id, "wingfoil");
  assert.deepEqual(body.variables, { WINGFOIL_IMAGE: "ghcr.io/x@sha256:1" });
  assert.match(stdout.text, /^~ ecmwf {2}update: image$/m);
  assert.match(stdout.text, /^ {6}image: "x:1" → "x:2"$/m);
  assert.match(stdout.text, /kept schedule \(edited since the last import\).*--force overwrites it/);
  assert.match(stdout.text, /^! gfs {4}kept$/m);
  assert.match(stdout.text, /^= tides {2}unchanged$/m);
  assert.match(stdout.text, /note: optional S3_PREFIX/);
  assert.match(stdout.text, /^Not in the file, left as they are: hello$/m);
});

test("cloud import explains what is missing or refused", async () => {
  const stdout = output();
  await assert.rejects(cloudCommand(["import", FIXTURE], { environment: {}, stdout }), /Set HC_URL/);
  await assert.rejects(cloudCommand(["import"], { environment, stdout }), /needs one FILE/);
  await assert.rejects(cloudCommand(["import", FIXTURE, "--preset", "nope"], { environment, stdout }), /Cannot read preset nope/);
  await assert.rejects(cloudCommand(["import", FIXTURE, "--bogus"], { environment, stdout }), /Unknown option/);
  const refused = async () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
  await assert.rejects(cloudCommand(["import", FIXTURE], { environment, fetcher: refused, stdout }), /HTTP 403: forbidden/);
  const signIn = async () => new Response("", { status: 302, headers: { location: "https://team.cloudflareaccess.com/" } });
  await assert.rejects(cloudCommand(["import", FIXTURE], { environment, fetcher: signIn, stdout }), /Access sign-in/);
  assert.throws(() => accessHeaders({ HC_ACCESS_CLIENT_ID: "only-id" }), /both/);
  assert.deepEqual(accessHeaders({ HC_ACCESS_JWT: "a.b.c" }), { "cf-access-jwt-assertion": "a.b.c" });
  await cloudCommand(["help"], { stdout });
  assert.match(stdout.text, /HC_ACCESS_CLIENT_ID/);
});

test("a created job is summarised on one line", () => {
  const text = formatImport({
    dryRun: false, preset: null, notInFile: [], summary: { create: 1, update: 0, kept: 0, unchanged: 0 },
    jobs: [{ id: "prune", action: "create", kept: [], changes: [
      { field: "enabled", after: true }, { field: "schedule", after: { at: { minutes: [10] } } },
      { field: "resources", after: { cpus: 0.5, memoryMiB: 512, diskMiB: 1024 } }, { field: "timeouts", after: { runSeconds: 1500 } },
    ] }],
  }, { url: "https://hc.example.com" });
  assert.equal(text, "Import into https://hc.example.com\n+ prune  create  hourly at :10 · 0.5 CPU 512 MiB · 1500 s\n1 to create, 0 to update, 0 with kept edits, 0 unchanged.\n");
});

test("cloud secrets put-env seals the preset's secrets from an env file and prints names only", async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const directory = await mkdtemp(path.join(os.tmpdir(), "hc-cli-"));
  const envFile = path.join(directory, ".env");
  const values = {
    S3_BUCKET: "bucket-value-test", S3_ENDPOINT_URL: "https://endpoint.example.com", AWS_ACCESS_KEY_ID: "TESTKEYID0000000000000000000ABCD",
    AWS_SECRET_ACCESS_KEY: "secret-value-test-0123456789",
  };
  await writeFile(envFile, `# comment\n${Object.entries(values).map(([name, value]) => `${name}=${value}`).join("\n")}\nOTHER=x\n`);
  const sent = [];
  const fetcher = async (url, init) => {
    sent.push({ url, method: init.method, body: JSON.parse(init.body), headers: init.headers });
    const name = decodeURIComponent(url.split("/").pop());
    return Response.json({ name, set: true, keyId: "v1-abc", hint: name.endsWith("key-id") ? "…ABCD" : null, allowedLabels: { site: "home" } }, { status: 201 });
  };
  const stdout = output();
  await cloudCommand(["secrets", "put-env", envFile, "--preset", "wingfoil", "--labels", "site=home"], { environment, fetcher, stdout });
  assert.deepEqual(sent.map((request) => [request.method, request.url]), [
    ["PUT", "https://hc.example.com/v1/secrets/wingfoil-r2-bucket"],
    ["PUT", "https://hc.example.com/v1/secrets/wingfoil-r2-endpoint"],
    ["PUT", "https://hc.example.com/v1/secrets/wingfoil-r2-key-id"],
    ["PUT", "https://hc.example.com/v1/secrets/wingfoil-r2-secret"],
  ]);
  assert.deepEqual(sent.map((request) => request.body), [
    { value: values.S3_BUCKET, allowedLabels: { site: "home" } }, { value: values.S3_ENDPOINT_URL, allowedLabels: { site: "home" } },
    { value: values.AWS_ACCESS_KEY_ID, allowedLabels: { site: "home" } }, { value: values.AWS_SECRET_ACCESS_KEY, allowedLabels: { site: "home" } },
  ]);
  assert.equal(sent[0].headers["cf-access-client-id"], "id.access");
  for (const value of Object.values(values)) assert.ok(!stdout.text.includes(value), "a value was printed");
  assert.match(stdout.text, /^set wingfoil-r2-bucket \(from S3_BUCKET\), for machines with site=home$/m);
  assert.match(stdout.text, /^set wingfoil-r2-key-id \(from AWS_ACCESS_KEY_ID\) …ABCD, for machines with site=home$/m);

  // A missing value uploads nothing.
  await writeFile(envFile, "S3_BUCKET=x\n");
  sent.length = 0;
  await assert.rejects(cloudCommand(["secrets", "put-env", envFile, "--preset", "wingfoil"], { environment, fetcher, stdout: output() }),
    /no value for S3_ENDPOINT_URL, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY; nothing was uploaded/);
  assert.equal(sent.length, 0);
});

test("cloud secrets put reads the value from stdin, never argv, and list shows no values", async () => {
  const { Readable } = await import("node:stream");
  const sent = [];
  const fetcher = async (url, init) => {
    sent.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    if (init.method === "GET") {
      return Response.json({
        vault: { configured: true, keyId: "v1-abc" },
        secrets: [{ name: "ghcr-user", set: true, keyId: "v1-abc", hint: "…ABCD", allowedLabels: {}, updatedAt: "2026-10-12T00:00:00.000Z", updatedBy: "me", usedBy: ["a"] }],
        missing: [{ name: "r2", set: false, usedBy: ["b"] }],
      });
    }
    return Response.json({ name: "ghcr-user", set: true, keyId: "v1-abc", hint: null, allowedLabels: {} }, { status: 201 });
  };
  const stdout = output();
  await cloudCommand(["secrets", "put", "ghcr-user"], { environment, fetcher, stdout, stdin: Readable.from(["value-from-stdin\n"]) });
  assert.deepEqual(sent[0], { url: "https://hc.example.com/v1/secrets/ghcr-user", method: "PUT", body: { value: "value-from-stdin" } });
  assert.ok(!stdout.text.includes("value-from-stdin"));
  await assert.rejects(cloudCommand(["secrets", "put", "x"], { environment, fetcher, stdout, stdin: { isTTY: true } }), /reads the value from stdin/);
  const listed = output();
  await cloudCommand(["secrets", "list"], { environment, fetcher, stdout: listed });
  assert.match(listed.text, /^Vault: key v1-abc\n {2}ghcr-user …ABCD · used by a · 2026-10-12T00:00:00.000Z by me\n {2}r2 NOT SET · needed by b\n$/);
});

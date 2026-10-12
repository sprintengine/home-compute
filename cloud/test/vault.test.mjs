// The vault in workerd (§5, §11 M5): hc-web seals with the public key and
// never answers with a value; hc-core opens a secret only into the answer to
// a claim, and only for a machine whose labels the secret allows.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROUTES } from "../src/hc-web.mjs";
import { agentCall, call, createJob, enrolMachine, mockCertificates, resetDatabase, rows, syncAs } from "./helpers.mjs";

const DAY0 = Math.floor(Date.now() / 86_400_000) * 86_400_000 - 86_400_000;
const at = (hours, minutes = 0, seconds = 0) => DAY0 + ((hours * 60 + minutes) * 60 + seconds) * 1000;
const KEY_ID = "TESTKEYID0000000000000000000ABCD";
const SECRET = "test-r2-secret-1f0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c";
const ENDPOINT = "https://0123456789abcdef.r2.example.com";
let certificates;

beforeEach(async () => {
  await resetDatabase();
  certificates = mockCertificates();
});
afterEach(() => certificates.mockRestore());

/** Every encoding of `value` a response might carry it in. */
function forms(value) {
  const bytes = new TextEncoder().encode(value);
  const base64 = btoa(String.fromCharCode(...bytes));
  return [value, encodeURIComponent(value), base64, base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), JSON.stringify(value).slice(1, -1)];
}

function assertNoSecrets(text, where) {
  for (const value of [SECRET, KEY_ID, ENDPOINT]) {
    for (const form of forms(value)) expect(text.includes(form), `${where} contains a secret (${form.slice(0, 6)}…)`).toBe(false);
  }
}

async function putSecrets(labels) {
  for (const [name, value] of [["wingfoil-r2-secret", SECRET], ["wingfoil-r2-key-id", KEY_ID], ["wingfoil-r2-endpoint", ENDPOINT]]) {
    const response = await call(`/v1/secrets/${name}`, { method: "PUT", body: { value, ...(labels ? { allowedLabels: labels } : {}) }, now: at(7) });
    expect(response.status).toBe(201);
    assertNoSecrets(JSON.stringify(response.body), `PUT /v1/secrets/${name}`);
  }
}

const VAULTED = {
  schedule: null,
  secretEnv: { AWS_SECRET_ACCESS_KEY: "vault:wingfoil-r2-secret", AWS_ACCESS_KEY_ID: "vault:wingfoil-r2-key-id", S3_ENDPOINT_URL: "vault:wingfoil-r2-endpoint" },
  env: { AWS_REGION: "auto" },
};

async function manualRun(id, now = at(8)) {
  const response = await call(`/v1/jobs/${id}/run`, { method: "POST", body: {}, now });
  expect(response.status).toBe(202);
  return response.body.runId;
}

describe("the vault", () => {
  it("stores only an envelope, a key id, a hint for identifiers and the allowed labels; the audit names the secret only", async () => {
    await putSecrets({ site: "home" });
    const stored = await rows("SELECT * FROM secrets ORDER BY name");
    expect(stored.map((row) => row.name)).toEqual(["wingfoil-r2-endpoint", "wingfoil-r2-key-id", "wingfoil-r2-secret"]);
    for (const row of stored) {
      assertNoSecrets(JSON.stringify(row), `the ${row.name} row`);
      expect(row.envelope.split(".")).toHaveLength(3);
      expect(row.key_id).toMatch(/^v1-[0-9a-f]{12}$/);
      expect(JSON.parse(row.allowed_labels_json)).toEqual({ site: "home" });
    }
    expect(stored.map((row) => row.hint)).toEqual([null, "…ABCD", null]);
    const audit = await rows("SELECT action, target, before_json, after_json FROM audit_log ORDER BY id");
    expect(audit.map((row) => [row.action, row.target])).toEqual([
      ["secret.put", "wingfoil-r2-secret"], ["secret.put", "wingfoil-r2-key-id"], ["secret.put", "wingfoil-r2-endpoint"],
    ]);
    assertNoSecrets(JSON.stringify(audit), "the audit log");

    // Replacing a value keeps its labels unless new ones are given; the audit says update.
    const again = await call("/v1/secrets/wingfoil-r2-secret", { method: "PUT", body: { value: `${SECRET}-2` } });
    expect(again.status).toBe(200);
    expect(again.body.allowedLabels).toEqual({ site: "home" });
    expect((await rows("SELECT action FROM audit_log ORDER BY id DESC LIMIT 1"))[0].action).toBe("secret.update");
  });

  it("lists names, hints, labels and the jobs that use them, and the names jobs need that are not set", async () => {
    await createJob("ecmwf", { ...VAULTED, secretEnv: { ...VAULTED.secretEnv, S3_BUCKET: "vault:wingfoil-r2-bucket" } });
    await putSecrets();
    const list = await call("/v1/secrets");
    expect(list.status).toBe(200);
    assertNoSecrets(JSON.stringify(list.body), "GET /v1/secrets");
    expect(list.body.vault).toMatchObject({ configured: true, keyId: expect.stringMatching(/^v1-/) });
    expect(list.body.secrets.map((secret) => [secret.name, secret.usedBy])).toEqual([
      ["wingfoil-r2-endpoint", ["ecmwf"]], ["wingfoil-r2-key-id", ["ecmwf"]], ["wingfoil-r2-secret", ["ecmwf"]],
    ]);
    expect(list.body.missing).toEqual([{ name: "wingfoil-r2-bucket", set: false, usedBy: ["ecmwf"] }]);
    expect(list.body.secrets[0]).not.toHaveProperty("envelope");
  });

  it("is an admin's: an operator or viewer cannot list, set or delete secrets", async () => {
    await call("/v1/settings", { method: "PATCH", body: { roles: { "op@example.com": "operator", "viewer@example.com": "viewer" } } });
    for (const identity of ["op@example.com", "viewer@example.com"]) {
      expect((await call("/v1/secrets", { identity })).status).toBe(403);
      expect((await call("/v1/secrets/x", { method: "PUT", body: { value: "v" }, identity })).status).toBe(403);
      expect((await call("/v1/secrets/x", { method: "DELETE", identity })).status).toBe(403);
    }
    expect((await call("/v1/secrets/Bad%20Name", { method: "PUT", body: { value: "v" } })).status).toBe(404);
    expect((await call("/v1/secrets/ok", { method: "PUT", body: { value: "" } })).status).toBe(400);
    expect((await call("/v1/secrets/ok", { method: "PUT", body: { value: "v", extra: 1 } })).status).toBe(400);
  });

  it("refuses to seal without a public key (503) rather than store anything", async () => {
    const { putSecret } = await import("../src/secrets.mjs");
    const failed = await putSecret({
      db: env.DB, env: { ...env, VAULT_PUBLIC_KEY: "" }, params: { id: "y" }, identity: { actor: "owner@example.com" }, ip: null, now: at(8),
      request: new Request("https://hc.example.com/", { method: "PUT", body: JSON.stringify({ value: "v" }) }),
    }).catch((error) => error);
    expect([failed.status, failed.code]).toEqual([503, "vault_not_configured"]);
    expect(await rows("SELECT name FROM secrets")).toEqual([]);
  });

  it("no /v1 answer ever contains a secret value: every GET route, after secrets were set, claimed, run and completed", async () => {
    await createJob("ecmwf", VAULTED, { now: at(7) });
    await putSecrets({ site: "home" });
    const machine = await enrolMachine("mac-mini", { labels: { site: "home" } });
    const runId = await manualRun("ecmwf");
    const { claims } = (await syncAs(machine, at(8, 0, 5))).body;
    expect(claims).toHaveLength(1);
    // The agent echoes nothing secret back (it redacts), but the run's log and reports carry some text.
    await agentCall(`/agent/v1/runs/${runId}/complete`, {
      credential: machine.credential, now: at(8, 2),
      body: { protocol: 1, exitCode: 0, logTail: { text: "fetched ecmwf\npublished <redacted>\n" }, reports: [{ event: "forecast_complete", model: "ecmwf", run: "2026101200" }] },
    });
    const ids = { JOB: "ecmwf", RUN: runId, MACHINE: machine.machineId, SECRET: "wingfoil-r2-secret" };
    const visited = [];
    for (const route of ROUTES.filter((entry) => entry.method === "GET")) {
      // Fill each capture group with an id of its kind.
      const source = route.pattern.source.replace(/^\^|\$$/g, "");
      const path = source
        .replace("([a-z0-9][a-z0-9-]{0,62})", ids.JOB)
        .replace("(r_[0-9A-Za-z]{26})", ids.RUN)
        .replace("(m_[0-9A-Za-z]{26})", ids.MACHINE)
        .replace("([a-z0-9][a-z0-9._-]{0,62})", ids.SECRET)
        .replace(/\\\//g, "/");
      expect(path, `a route with an unknown parameter: ${source}`).not.toMatch(/[()[\]\\]/);
      const response = await call(path, { now: at(8, 3) });
      expect(response.status, path).toBeLessThan(400);
      assertNoSecrets(JSON.stringify(response.body), `GET ${path}`);
      visited.push(path);
    }
    for (const path of ["/v1/session", "/v1/changes"]) assertNoSecrets(JSON.stringify((await call(path)).body), path);
    expect(visited).toEqual(expect.arrayContaining(["/v1/snapshot", "/v1/secrets", "/v1/alerts", `/v1/runs/${runId}/logs`, "/v1/audit"]));
  });

  it("gives a claim the opened values for a machine whose labels match, with no-store", async () => {
    await createJob("ecmwf", VAULTED, { now: at(7) });
    await putSecrets({ site: "home" });
    const machine = await enrolMachine("mac-mini", { labels: { site: "home" } });
    await manualRun("ecmwf");
    const answer = await syncAs(machine, at(8, 0, 5));
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(answer.body.claims[0].spec.secretEnv).toEqual({ AWS_SECRET_ACCESS_KEY: SECRET, AWS_ACCESS_KEY_ID: KEY_ID, S3_ENDPOINT_URL: ENDPOINT });
    expect(answer.body.claims[0].spec.env).toEqual({ AWS_REGION: "auto" });
    // The run row records what ran, never the values.
    assertNoSecrets(JSON.stringify(await rows("SELECT * FROM runs")), "the runs table");
  });

  it("gives a machine whose labels do not match no secrets: it does not claim, and its answer holds no value", async () => {
    await createJob("ecmwf", VAULTED, { now: at(7) });
    await putSecrets({ site: "home" });
    const stranger = await enrolMachine("cloud-box", { labels: { site: "cloud" } });
    const runId = await manualRun("ecmwf");
    const answer = await syncAs(stranger, at(8, 0, 5));
    expect(answer.body.claims).toEqual([]);
    assertNoSecrets(JSON.stringify(answer.body), "a non-matching machine's sync");
    expect((await rows("SELECT state FROM runs WHERE id = ?", runId))[0].state).toBe("due");
    const snapshot = await call("/v1/snapshot", { now: at(8, 1) });
    expect(snapshot.body.jobs.find((job) => job.id === "ecmwf").waiting).toMatch(/no machine may receive wingfoil-r2-.*allowed labels/);

    // A matching machine then takes it.
    const home = await enrolMachine("mac-mini", { labels: { site: "home" } });
    expect((await syncAs(home, at(8, 1, 5))).body.claims.map((claim) => claim.run.id)).toEqual([runId]);
  });

  it("blocks a job whose secret is not set, and fails a won claim whose secret went away rather than run it without", async () => {
    await createJob("ecmwf", VAULTED, { now: at(7) });
    const machine = await enrolMachine("mac-mini", { labels: { site: "home" } });
    await manualRun("ecmwf");
    expect((await syncAs(machine, at(8, 0, 5))).body.claims).toEqual([]);
    expect((await call("/v1/snapshot")).body.jobs[0].blocked).toMatch(/not set: wingfoil-r2-endpoint, wingfoil-r2-key-id, wingfoil-r2-secret/);

    await putSecrets({ site: "home" });
    expect((await syncAs(machine, at(8, 0, 15))).body.claims).toHaveLength(1);
    await agentCall(`/agent/v1/runs/${(await rows("SELECT id FROM runs"))[0].id}/complete`, { credential: machine.credential, body: { protocol: 1, exitCode: 0 }, now: at(8, 1) });

    // The labels change behind hc-core's cached copy (no secrets_version move): the open refuses, and the run fails with why.
    await env.DB.prepare("UPDATE secrets SET allowed_labels_json = ? WHERE name = 'wingfoil-r2-secret'").bind(JSON.stringify({ site: "elsewhere" })).run();
    const second = await manualRun("ecmwf", at(8, 2));
    const answer = await syncAs(machine, at(8, 2, 5));
    expect(answer.body.claims).toEqual([]);
    assertNoSecrets(JSON.stringify(answer.body), "the refused claim's answer");
    const [run] = await rows("SELECT state, error FROM runs WHERE id = ?", second);
    expect(run.state).toBe("failed");
    expect(run.error).toMatch(/^vault: wingfoil-r2-secret not allowed for this machine's labels/);
    expect((await rows("SELECT fail_streak, last_run_id FROM schedule_state WHERE job_id = 'ecmwf'"))[0]).toEqual({ fail_streak: 1, last_run_id: second });

    // Deleted: blocked again, and audited by name.
    expect((await call("/v1/secrets/wingfoil-r2-key-id", { method: "DELETE" })).status).toBe(200);
    expect((await call("/v1/secrets/wingfoil-r2-key-id", { method: "DELETE" })).status).toBe(404);
    expect((await call("/v1/snapshot")).body.jobs[0].blocked).toMatch(/not set: wingfoil-r2-key-id/);
    expect((await rows("SELECT action, target FROM audit_log WHERE action = 'secret.delete'"))).toEqual([{ action: "secret.delete", target: "wingfoil-r2-key-id" }]);
  });

  it("opens a private registry's credential into spec.registryAuth, and fails the claim if it is not one", async () => {
    await createJob("private", { schedule: null, image: "ghcr.io/sprintengine/private:tag", registryAuth: "vault:ghcr-read" }, { now: at(7) });
    const credential = { server: "ghcr.io", username: "reader", password: "ghp_testtoken0000000000000000000000000000" };
    expect((await call("/v1/secrets/ghcr-read", { method: "PUT", body: { value: JSON.stringify(credential) } })).status).toBe(201);
    const machine = await enrolMachine("mac-mini", { labels: { site: "home" } });
    await manualRun("private");
    const answer = await syncAs(machine, at(8, 0, 5));
    expect(answer.body.claims[0].spec.registryAuth).toEqual(credential);
    expect((await call("/v1/jobs/private")).body.registryAuth).toBe("vault:ghcr-read");
    expect(JSON.stringify((await call("/v1/snapshot")).body)).not.toContain(credential.password);

    await call("/v1/secrets/ghcr-read", { method: "PUT", body: { value: "not json" } });
    await agentCall(`/agent/v1/runs/${answer.body.claims[0].run.id}/complete`, { credential: machine.credential, body: { protocol: 1, exitCode: 0 }, now: at(8, 1) });
    const second = await manualRun("private", at(8, 2));
    expect((await syncAs(machine, at(8, 2, 5))).body.claims).toEqual([]);
    expect((await rows("SELECT state, error FROM runs WHERE id = ?", second))[0]).toEqual({
      state: "failed", error: "vault: ghcr-read is not a registry credential ({server, username, password} JSON)",
    });
    // An admin points a job at a credential with the image; an operator may not.
    expect((await call("/v1/jobs/private/image", { method: "PATCH", body: { registryAuth: null } })).body.changed).toEqual(["registryAuth"]);
  });

  it("moves the changes cursor when a secret is set, so dashboards see a job unblock", async () => {
    const before = (await call("/v1/changes")).body.cursor;
    await putSecrets();
    expect((await call(`/v1/changes?since=${before}`)).status).toBe(200);
  });
});

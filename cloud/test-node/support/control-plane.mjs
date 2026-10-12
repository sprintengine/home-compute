// hc-core in Miniflare (workerd) with a local D1 that has the real
// migrations, for tests that drive it with real agents. The Worker is
// bundled with esbuild from test-node/support/core-under-test.mjs.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { normaliseJob } from "../../../src/core/job.mjs";
import { newId } from "../../../src/core/ids.mjs";
import { preferredUntil } from "../../../src/core/placement.mjs";
import { bumpJobsVersion, upsertJobsStatements } from "../../src/db.mjs";
import { joinTokenStatements } from "../../src/machines.mjs";

const CLOUD = path.resolve(import.meta.dirname, "../..");
let bundled = null;

async function bundle() {
  bundled ??= build({
    entryPoints: [path.join(import.meta.dirname, "core-under-test.mjs")],
    bundle: true, format: "esm", platform: "neutral", target: "es2022", write: false, logLevel: "warning", external: ["cloudflare:*"],
  }).then((result) => result.outputFiles[0].text);
  return bundled;
}

async function applyMigrations(db) {
  const directory = path.join(CLOUD, "migrations");
  for (const file of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = await readFile(path.join(directory, file), "utf8");
    const statements = sql.split(/;\s*$/m).map((statement) => statement.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
    await db.batch(statements.map((statement) => db.prepare(statement)));
  }
}

/**
 * A running hc-core: `url`, `db` (the D1 binding, from Node), helpers to
 * seed jobs, join tokens and runs, `cron(now)`, `fetchAt(clock)` (a fetch
 * that tells the Worker the clock's time and can be taken offline), and the
 * wall time of every agent request (`timings`).
 */
export async function startControlPlane() {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: await bundle(), compatibilityDate: "2026-10-01", d1Databases: { DB: "hc-integration" },
  }));
  const url = (await mf.ready).href.replace(/\/$/, "");
  const db = await mf.getD1Database("DB");
  await applyMigrations(db);
  const timings = [];
  const plane = {
    url, db, timings, offline: false,
    close: () => mf.dispose(),

    /** A fetch for agents: stamps the clock's time, records how long hc-core took, fails while `offline`. */
    fetchAt(clock) {
      return async (input, init = {}) => {
        if (plane.offline) throw new TypeError("fetch failed (the test took the control plane offline)");
        const started = performance.now();
        const response = await fetch(input, { ...init, headers: { ...(init.headers ?? {}), "x-hc-test-now": String(Math.round(clock.now())) } });
        const { pathname } = new URL(String(input));
        timings.push({ path: pathname.replace(/r_[0-9A-Z]{26}/, ":id"), ms: performance.now() - started, status: response.status });
        return response;
      };
    },

    async cron(now) {
      return (await fetch(`${url}/__test/cron?now=${Math.round(now)}`)).json();
    },

    async createJob(definition, now) {
      await db.batch([...upsertJobsStatements(db, [normaliseJob(definition)], { now, actor: "test" }), bumpJobsVersion(db)]);
    },

    async joinToken(name, now, labels = {}) {
      const created = await joinTokenStatements(db, { name, labels, actor: "test", now });
      await db.batch(created.statements);
      return created.token;
    },

    /** A manual run of `jobId`, due at `now`, as Run now makes it. */
    async runNow(jobId, now) {
      const job = await db.prepare("SELECT revision, placement_json FROM jobs WHERE id = ?").bind(jobId).first();
      const id = newId("r", now);
      await db.prepare(`INSERT INTO runs (id, job_id, job_revision, source, state, due_at, preferred_until, requested_by, created_at, updated_at)
        VALUES (?1, ?2, ?3, 'manual', 'due', ?4, ?5, 'test', ?4, ?4)`)
        .bind(id, jobId, job.revision, now, preferredUntil({ placement: JSON.parse(job.placement_json) }, now)).run();
      return id;
    },

    async run(id) {
      return db.prepare("SELECT * FROM runs WHERE id = ?").bind(id).first();
    },

    async runs(jobId) {
      return (await db.prepare("SELECT * FROM runs WHERE job_id = ? ORDER BY created_at, id").bind(jobId).all()).results;
    },
  };
  return plane;
}

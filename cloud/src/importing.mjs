// POST /v1/import: a v1 job set (plus a preset) → a per-job diff, applied
// unless `dryRun`. The plan itself is src/core/importer.mjs; this reads what
// the control plane has, and writes the result in one transaction.

import { jobFromV1, planImport, validatePreset } from "../../src/core/importer.mjs";
import { ENV_NAME } from "../../src/core/job.mjs";
import { HttpError } from "./http.mjs";
import { auditManyStatement, bumpJobsVersion, loadJobs, putSetting, readSettings, upsertJobsStatements } from "./db.mjs";

const MAX_JOBS = 200;

function definitionOf(job) {
  const { paused, preset, revision, createdAt, updatedAt, updatedBy, ...definition } = job;
  return definition;
}

function checkBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "The import must be an object");
  const jobs = body.config?.jobs;
  if (!Array.isArray(jobs) || !jobs.length) throw new HttpError(400, "config.jobs must be a non-empty array (a v1 home-compute.json)");
  if (jobs.length > MAX_JOBS) throw new HttpError(413, `At most ${MAX_JOBS} jobs per import`);
  const variables = body.variables ?? {};
  if (!variables || typeof variables !== "object" || Array.isArray(variables)
    || Object.entries(variables).some(([name, value]) => !ENV_NAME.test(name) || typeof value !== "string" || !value.trim())) {
    throw new HttpError(400, "variables must map NAME to a non-empty string");
  }
  for (const flag of ["force", "pause"]) {
    if (body[flag] !== undefined && typeof body[flag] !== "boolean") throw new HttpError(400, `${flag} must be true or false`);
  }
  return { jobs, variables };
}

/**
 * Plans the import and, unless `dryRun`, applies it: creates and updates
 * jobs (new ones paused when `pause` is set), remembers what was imported
 * (the baseline that later tells a dashboard edit from a stale file), and
 * audits each job it changed. Importing the same file twice writes nothing.
 */
export async function importJobs(db, body, { actor, ip, now, dryRun }) {
  const { jobs: v1Jobs, variables } = checkBody(body);
  let preset;
  try {
    preset = validatePreset(body.preset);
  } catch (error) {
    throw new HttpError(422, error.message);
  }
  const values = { ...(preset?.variables ?? {}), ...variables };
  const warnings = {};
  const incoming = v1Jobs.map((v1, index) => {
    try {
      const converted = jobFromV1(v1, { preset, variables: values });
      warnings[converted.job.id] = converted.warnings;
      return converted.job;
    } catch (error) {
      throw new HttpError(422, `jobs[${index}] (${v1?.id ?? "no id"}): ${error.message}`);
    }
  });
  const baselineKey = `import_baseline:${preset?.id ?? "none"}`;
  const [current, settings] = await Promise.all([loadJobs(db), readSettings(db, [baselineKey])]);
  const existing = Object.fromEntries(current.map((job) => [job.id, definitionOf(job)]));
  const baseline = settings[baselineKey] ?? {};
  let plan;
  try {
    plan = planImport({ incoming, existing, baseline, force: body.force === true });
  } catch (error) {
    throw new HttpError(422, error.message);
  }

  const writes = plan.jobs.filter((job) => job.action === "create" || job.action === "update");
  const nextBaseline = { ...baseline, ...Object.fromEntries(incoming.map((job) => [job.id, job])) };
  const baselineChanged = JSON.stringify(nextBaseline) !== JSON.stringify(baseline);
  if (!dryRun && (writes.length || baselineChanged)) {
    const statements = [];
    const created = writes.filter((job) => job.action === "create").map((job) => job.next);
    const updated = writes.filter((job) => job.action === "update").map((job) => job.next);
    const options = { now, actor, preset: preset?.id ?? null };
    if (created.length) statements.push(...upsertJobsStatements(db, created, { ...options, paused: body.pause === true }));
    if (updated.length) statements.push(...upsertJobsStatements(db, updated, options));
    statements.push(putSetting(db, baselineKey, nextBaseline));
    if (writes.length) {
      statements.push(bumpJobsVersion(db));
      statements.push(auditManyStatement(db, [
        ...writes.map((job) => ({
          at: now, actor, ip, target: job.id,
          action: job.action === "create" ? "job.create" : "job.update",
          before: job.action === "create" ? null : Object.fromEntries(job.changes.map((change) => [change.field, change.before])),
          after: Object.fromEntries(job.changes.map((change) => [change.field, change.after])),
        })),
        { at: now, actor, ip, action: "import.apply", target: preset?.id ?? null, after: { ...plan.summary, force: body.force === true } },
      ]));
    }
    await db.batch(statements);
  }
  return {
    dryRun,
    preset: preset?.id ?? null,
    summary: plan.summary,
    notInFile: plan.notInFile,
    jobs: plan.jobs.map(({ id, action, changes, kept }) => ({
      id, action, changes, kept, ...(warnings[id]?.length ? { warnings: warnings[id] } : {}),
    })),
  };
}

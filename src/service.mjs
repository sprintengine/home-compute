import { EventEmitter } from "node:events";
import path from "node:path";
import { buildJobSpec } from "./bacalhau.mjs";
import { configDifferences, loadConfig } from "./config.mjs";
import { HttpError } from "./errors.mjs";
import { HistoryStore, summarizeRun } from "./history.mjs";
import { classifyLines, tailLines } from "./logs.mjs";
import { createRedactor, secretValues } from "./redact.mjs";
import { nextDueAt, readState, reconcile, recordSubmitted, settleRun, writeState } from "./scheduler.mjs";
import { resolveTimetableCommand, runTimetableCommand, timetableArguments } from "./timetable.mjs";

const RUN_ID = /^j-[A-Za-z0-9-]{1,80}$/;
const LOG_LINES = 500;
const LOG_BYTES = 256 * 1024;
const RECENT_RUNS = 5;

function requireJob(config, id) {
  if (typeof id !== "string" || !id) throw new Error("A job id is required");
  const job = config.jobs.find((candidate) => candidate.id === id);
  if (!job) throw new Error(`Unknown job ${id}`);
  return job;
}

/** Bacalhau's word for a run's state, as the dashboard shows it. */
function liveStateOf(record, liveState) {
  return liveState ?? record.lastObservedState;
}

function nodeArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.Nodes)) return value.Nodes;
  if (Array.isArray(value?.nodes)) return value.nodes;
  return [];
}

export class HomeComputeService {
  constructor({ config, client, environment, stateFile, logger = console, history, secrets = [] }) {
    this.config = config;
    this.client = client;
    this.environment = environment;
    this.stateFile = stateFile;
    this.logger = logger;
    this.secrets = secrets;
    this.history = history ?? new HistoryStore(path.join(path.dirname(stateFile), "history"), {
      keep: config.history?.keep ?? 50,
    });
    this.redact = createRedactor(secretValues(config.jobs, environment, secrets));
    this.events = new EventEmitter();
    this.events.setMaxListeners(100);
    this.queue = Promise.resolve();
    this.timetableQueue = Promise.resolve();
    this.logCache = new Map();
    this.configLoadedAt = new Date().toISOString();
  }

  serial(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  emit(event) {
    this.events.emit("event", event);
  }

  subscribe(listener) {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  async reconcile(now = new Date()) {
    return this.serial(async () => {
      const result = await reconcile({
        config: this.config,
        client: this.client,
        environment: this.environment,
        stateFile: this.stateFile,
        now,
        logger: this.logger,
        history: this.history,
        redact: this.redact,
      });
      for (const event of result.events) this.emit(event);
      return result;
    });
  }

  async run(id, extraParameters = []) {
    return this.serial(async () => {
      const job = requireJob(this.config, id);
      if (!Array.isArray(extraParameters) || extraParameters.some((value) => typeof value !== "string")) {
        throw new Error("extraParameters must be an array of strings");
      }
      const state = await readState(this.stateFile);
      const record = (state.jobs[job.id] ??= {});
      if (record.activeJobId) {
        const status = await this.client.describe(record.activeJobId);
        if (!status.terminal) {
          throw new Error(`${job.id} already has active Bacalhau job ${record.activeJobId} (${status.state})`);
        }
        this.emit(await settleRun({
          job, record, status, client: this.client, now: new Date(),
          history: this.history, redact: this.redact, logger: this.logger,
        }));
      }
      const submittedJob = extraParameters.length
        ? { ...job, task: { ...job.task, parameters: [...(job.task.parameters ?? []), ...extraParameters] } }
        : job;
      const submittedAt = new Date();
      const bacalhauJobId = await this.client.submit(buildJobSpec(submittedJob, this.environment, { now: submittedAt }));
      const now = submittedAt.toISOString();
      Object.assign(record, {
        activeJobId: bacalhauJobId,
        lastSubmittedAt: now,
        lastObservedState: "Submitted",
        lastSubmissionError: undefined,
        lastSubmissionErrorAt: undefined,
      });
      state.updatedAt = now;
      await writeState(this.stateFile, state);
      await recordSubmitted({
        history: this.history, job, bacalhauJobId, submittedAt: now, source: "manual",
        parameters: extraParameters, logger: this.logger,
      });
      const event = { event: "job_submitted", job: job.id, bacalhauJobId, source: "manual" };
      this.emit(event);
      return event;
    });
  }

  async setPaused(id, paused) {
    return this.serial(async () => {
      const job = requireJob(this.config, id);
      const state = await readState(this.stateFile);
      const record = (state.jobs[job.id] ??= {});
      record.paused = Boolean(paused);
      state.updatedAt = new Date().toISOString();
      await writeState(this.stateFile, state);
      const event = { event: paused ? "job_paused" : "job_resumed", job: job.id };
      this.emit(event);
      return event;
    });
  }

  async snapshot({ live = true } = {}) {
    return this.serial(async () => {
      const state = await readState(this.stateFile);
      const now = new Date();
      const jobs = [];
      for (const job of this.config.jobs) {
        const record = state.jobs[job.id] ?? {};
        let liveState;
        let liveError;
        if (live && record.activeJobId) {
          try {
            liveState = (await this.client.describe(record.activeJobId)).state;
          } catch (error) {
            liveError = error.message;
          }
        }
        const recentRuns = (await this.history.runs(job.id, { limit: RECENT_RUNS })).map(summarizeRun);
        jobs.push({
          id: job.id,
          enabled: job.enabled !== false && record.paused !== true,
          configuredEnabled: job.enabled !== false,
          paused: record.paused === true,
          schedule: job.schedule,
          image: job.task.image,
          parameters: job.task.parameters ?? [],
          resources: job.task.resources ?? {},
          labels: job.labels ?? {},
          ...(job.description ? { description: job.description } : {}),
          ...record,
          running: Boolean(record.activeJobId),
          nextDueAt: nextDueAt(job, record, now),
          ...(liveState ? { liveState } : {}),
          ...(liveError ? { liveError } : {}),
          ...(record.activeJobId ? { activeState: liveStateOf(record, liveState) } : {}),
          recentRuns,
          runsUrl: `/v1/jobs/${job.id}/runs`,
        });
      }

      let nodes = [];
      let clusterError;
      if (live) {
        try {
          nodes = nodeArray(await this.client.nodes());
        } catch (error) {
          clusterError = error.message;
        }
      }
      return {
        version: 1,
        generatedAt: new Date().toISOString(),
        controller: {
          status: clusterError ? "degraded" : "online",
          pollEvery: this.config.pollEvery ?? "30s",
          configLoadedAt: this.configLoadedAt,
          features: ["history", "logs", "reload", ...(this.config.timetable?.command ? ["timetable"] : [])],
          ...(clusterError ? { clusterError } : {}),
        },
        timetable: { editable: Boolean(this.config.timetable?.command) },
        jobs,
        nodes,
        nodeCount: nodes.length,
        stateUpdatedAt: state.updatedAt ?? null,
      };
    });
  }

  /** A job's runs, newest first. */
  async runs(id, { limit } = {}) {
    const job = requireJob(this.config, id);
    const runs = await this.history.runs(job.id, limit ? { limit } : {});
    return { job: job.id, keep: this.history.keep, runs };
  }

  /** Which job a run belongs to, and whether it is still going; undefined if it is none of ours. */
  async ownerOf(bacalhauJobId) {
    const state = await readState(this.stateFile);
    for (const job of this.config.jobs) {
      const record = state.jobs[job.id] ?? {};
      if (record.activeJobId === bacalhauJobId) return { job: job.id, active: true };
      if (record.lastFinishedJobId === bacalhauJobId) return { job: job.id, active: false };
    }
    const found = await this.history.locate(bacalhauJobId, this.config.jobs.map((job) => job.id));
    if (!found) return undefined;
    return { job: found.job, active: !found.run.finishedAt, run: found.run };
  }

  /**
   * The end of a run's log (at most LOG_LINES lines and LOG_BYTES bytes),
   * redacted, each line with a level. Only runs this controller submitted
   * can be read. A finished run's log cannot change, so it is kept a while.
   */
  async logs(bacalhauJobId, { lines = LOG_LINES } = {}) {
    if (!RUN_ID.test(bacalhauJobId ?? "")) throw new HttpError(400, "Invalid run id");
    const maxLines = Math.min(Math.max(Number.parseInt(lines, 10) || LOG_LINES, 1), LOG_LINES);
    const owner = await this.ownerOf(bacalhauJobId);
    if (!owner) throw new HttpError(404, `Unknown run ${bacalhauJobId}`);
    const cached = this.logCache.get(bacalhauJobId);
    let read = cached;
    if (!read) {
      if (!this.client.logTail) throw new HttpError(501, "This Bacalhau client cannot read logs");
      try {
        read = await this.client.logTail(bacalhauJobId, { maxBytes: LOG_BYTES });
      } catch (error) {
        throw new HttpError(502, `Bacalhau could not return the log: ${this.redact(error.message)}`);
      }
      read = { ...read, text: this.redact(read.text), fetchedAt: new Date().toISOString() };
      if (!owner.active && !read.partial) {
        this.logCache.set(bacalhauJobId, read);
        while (this.logCache.size > 20) this.logCache.delete(this.logCache.keys().next().value);
      }
    }
    const tail = tailLines(read.text, maxLines);
    const classified = classifyLines(tail.lines);
    return {
      bacalhauJobId,
      job: owner.job,
      active: owner.active,
      fetchedAt: read.fetchedAt,
      bytes: read.bytes,
      truncated: read.truncated || tail.omitted > 0,
      partial: Boolean(read.partial),
      errorCount: classified.filter((line) => line.level === "error").length,
      lines: classified,
    };
  }

  /**
   * Reads the configuration file again and applies its jobs in place, between
   * two scheduler passes. A file that fails validation changes nothing. Other
   * sections (API, Bacalhau, dashboard...) apply at the next restart; the
   * answer names any that differ.
   */
  async reloadConfig({ reason = "request" } = {}) {
    if (!this.config.filename) throw new HttpError(409, "This controller was not started from a configuration file");
    let next;
    try {
      next = await loadConfig(this.config.filename);
    } catch (error) {
      throw new HttpError(422, `The configuration was not reloaded: ${error.message}`);
    }
    return this.serial(async () => {
      const differences = configDifferences(this.config, next);
      const state = await readState(this.stateFile);
      const orphaned = differences.removed.filter((id) => state.jobs[id]?.activeJobId);
      this.config = { ...this.config, jobs: next.jobs };
      this.redact = createRedactor(secretValues(next.jobs, this.environment, this.secrets));
      this.configLoadedAt = new Date().toISOString();
      const event = {
        event: "config_reloaded",
        reason,
        ...differences,
        ...(orphaned.length ? { untracked: orphaned } : {}),
      };
      this.logger.log(JSON.stringify(event));
      this.emit(event);
      return event;
    });
  }

  /**
   * Changes one job's timetable through the project's own command (the file
   * the controller reads is the project's), then reloads it. One change runs
   * at a time.
   */
  async setTimetable(id, changes) {
    const command = resolveTimetableCommand(this.config);
    if (!command) throw new HttpError(501, "Timetable editing is not configured (timetable.command)");
    const job = requireJob(this.config, id);
    const args = timetableArguments(job, changes);
    const operation = async () => {
      const answer = await runTimetableCommand(command, args, {
        timeoutMs: (this.config.timetable.timeoutSeconds ?? 120) * 1000,
      });
      this.logger.log(JSON.stringify({ event: "timetable_changed", job: job.id, arguments: args.slice(1) }));
      let reload;
      try {
        reload = await this.reloadConfig({ reason: "timetable" });
      } catch (error) {
        throw new HttpError(502, `The timetable changed but the controller could not apply it: ${error.message}. Restart it.`);
      }
      return { ok: true, job: job.id, changes, answer, reload };
    };
    const result = this.timetableQueue.then(operation, operation);
    this.timetableQueue = result.catch(() => undefined);
    return result;
  }
}

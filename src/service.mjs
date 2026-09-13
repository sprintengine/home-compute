import { EventEmitter } from "node:events";
import { buildJobSpec } from "./bacalhau.mjs";
import { readState, reconcile, writeState } from "./scheduler.mjs";

function requireJob(config, id) {
  if (typeof id !== "string" || !id) throw new Error("A job id is required");
  const job = config.jobs.find((candidate) => candidate.id === id);
  if (!job) throw new Error(`Unknown job ${id}`);
  return job;
}

function nodeArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.Nodes)) return value.Nodes;
  if (Array.isArray(value?.nodes)) return value.nodes;
  return [];
}

export class HomeComputeService {
  constructor({ config, client, environment, stateFile, logger = console }) {
    this.config = config;
    this.client = client;
    this.environment = environment;
    this.stateFile = stateFile;
    this.logger = logger;
    this.events = new EventEmitter();
    this.queue = Promise.resolve();
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
        record.lastFinishedJobId = record.activeJobId;
        record.lastFinishedState = status.state;
        record.lastFinishedAt = new Date().toISOString();
        record.activeJobId = undefined;
      }
      const submittedJob = extraParameters.length
        ? { ...job, task: { ...job.task, parameters: [...(job.task.parameters ?? []), ...extraParameters] } }
        : job;
      const bacalhauJobId = await this.client.submit(buildJobSpec(submittedJob, this.environment));
      const now = new Date().toISOString();
      Object.assign(record, {
        activeJobId: bacalhauJobId,
        lastSubmittedAt: now,
        lastObservedState: "Submitted",
        lastSubmissionError: undefined,
        lastSubmissionErrorAt: undefined,
      });
      state.updatedAt = now;
      await writeState(this.stateFile, state);
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
          ...record,
          ...(liveState ? { liveState } : {}),
          ...(liveError ? { liveError } : {}),
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
          ...(clusterError ? { clusterError } : {}),
        },
        jobs,
        nodes,
        nodeCount: nodes.length,
        stateUpdatedAt: state.updatedAt ?? null,
      };
    });
  }
}

// The outbox (§4.2): a run's final record is written here (0600) before it
// is sent, and deleted only after the control plane answers 2xx, so a result
// survives the network, the control plane and the agent itself going away.

import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { RUN_ID } from "../../src/core/protocol.mjs";

export class Outbox {
  /** `state` is a StateDir; entries live in its `outbox/` directory as `<run>.json`. */
  constructor(state) {
    this.state = state;
  }

  pathOf(runId) {
    if (!RUN_ID.test(runId)) throw new Error(`Not a run id: ${runId}`);
    return path.join(this.state.outboxDir, `${runId}.json`);
  }

  async put(runId, record) {
    await this.state.ensure();
    await this.state.writeSecure(this.pathOf(runId), `${JSON.stringify(record)}\n`);
  }

  async ids() {
    try {
      return (await readdir(this.state.outboxDir)).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5))
        .filter((id) => RUN_ID.test(id)).sort();
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async get(runId) {
    try {
      return JSON.parse(await readFile(this.pathOf(runId), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async remove(runId) {
    await rm(this.pathOf(runId), { force: true });
  }
}

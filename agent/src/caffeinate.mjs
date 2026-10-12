// Keeping a Mac awake while a run is active (§4.4): `caffeinate -i -w <pid>`
// holds an idle-sleep assertion until it is killed or the agent's process
// ends (-w), so a crashed agent never leaves the Mac unable to sleep.

import { spawn } from "node:child_process";

export class Caffeinate {
  constructor({ binary = "caffeinate", pid = process.pid, env = process.env, spawnFn = spawn, log = () => {} } = {}) {
    Object.assign(this, { binary, pid, env, spawnFn, log });
    this.child = null;
  }

  get holding() {
    return this.child !== null;
  }

  /** Starts holding the assertion (once). */
  hold() {
    if (this.child) return;
    let child;
    try {
      child = this.spawnFn(this.binary, ["-i", "-w", String(this.pid)], { env: this.env, stdio: "ignore" });
    } catch (error) {
      this.log("caffeinate_error", { error: error.message });
      return;
    }
    if (!(child.pid > 0)) {
      child.on?.("error", (error) => this.log("caffeinate_error", { error: error.message }));
      return;
    }
    this.child = child;
    child.unref?.();
    child.on("error", (error) => {
      this.log("caffeinate_error", { error: error.message });
      if (this.child === child) this.child = null;
    });
    child.on("exit", () => {
      if (this.child === child) this.child = null;
    });
    this.log("caffeinate_hold", { pid: child.pid });
  }

  /** Lets the Mac sleep again. */
  release() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    // Never signal a child that did not start: with no pid, a kill may reach the agent's whole process group.
    if (child.pid > 0 && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    this.log("caffeinate_release", { pid: child.pid });
  }
}

/** The configuration's choice: `caffeinate: true`, or `"auto"` on a Mac with a real runtime. */
export function createCaffeinate(config, { platform = process.platform, ...options } = {}) {
  const wanted = config.caffeinate === true || (config.caffeinate !== false && platform === "darwin" && config.runtime !== "fake");
  return wanted ? new Caffeinate(options) : null;
}

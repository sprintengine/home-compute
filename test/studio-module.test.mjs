import assert from "node:assert/strict";
import test from "node:test";
import { registerMain } from "../studio-module/src/main.js";

test("Studio module registers only namespaced control API channels", async () => {
  const channels = new Map();
  registerMain({ registerIpc(name, handler) { channels.set(name, handler); } });
  assert.deepEqual([...channels.keys()].sort(), [
    "home-compute:pause",
    "home-compute:resume",
    "home-compute:run",
    "home-compute:snapshot",
    "home-compute:test-connection",
  ]);
  await assert.rejects(
    channels.get("home-compute:snapshot")(undefined, { endpoint: "file:///tmp/controller" }),
    /http or https/,
  );
});

// The service templates (§4.7): the systemd unit and slice carry the
// priorities §4.3 asks for, and the LaunchAgent keeps the VM across restarts.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const SERVICE = path.join(import.meta.dirname, "..", "service");
const read = (name) => readFile(path.join(SERVICE, name), "utf8");

test("systemd: the agent at Nice=10, restarted always; its containers' slice at CPUWeight=20 with a memory ceiling to fill in", async () => {
  const unit = await read("home-compute-agent.service");
  for (const line of ["Nice=10", "Restart=always", "User=hcagent", "SupplementaryGroups=docker", "Environment=HC_AGENT_STATE_DIR=/etc/home-compute",
    "ExecStart=/opt/home-compute/node/bin/node /opt/home-compute/agent/current/home-compute-agent.mjs run", "WantedBy=multi-user.target"]) {
    assert.ok(unit.split("\n").includes(line), line);
  }
  const slice = await read("home-compute.slice");
  for (const line of ["CPUWeight=20", "MemoryMax=@MEMORY_MAX@", "MemoryAccounting=yes"]) assert.ok(slice.split("\n").includes(line), line);
});

test("launchd: a KeepAlive LaunchAgent that finds colima, leaves the VM running across restarts and keeps normal priority", async () => {
  const plist = await read("dev.homecompute.agent.plist");
  assert.match(plist, /<key>Label<\/key>\s*<string>dev\.homecompute\.agent<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>AbandonProcessGroup<\/key>\s*<true\/>/);
  assert.match(plist, /<key>ProcessType<\/key>\s*<string>Standard<\/string>/);
  assert.match(plist, /<string>\/opt\/homebrew\/bin:\/usr\/local\/bin:/);
  assert.match(plist, /home-compute-agent\.mjs<\/string>\s*<string>run<\/string>/);
});

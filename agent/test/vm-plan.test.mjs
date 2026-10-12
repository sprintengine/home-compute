// The VM lifecycle's decisions (§4.4), without a VM: pre-warm timing, the
// sizing rule and its clamps, resizing only while empty, idle stop, keep
// warm, the always-on fallback, and start failures holding pre-warm back.
import assert from "node:assert/strict";
import test from "node:test";
import { ownUpcoming, planVmSize, sizeFor, vmDecision, vmFits } from "../src/runtime/vm-plan.mjs";

const NOW = Date.UTC(2026, 9, 11, 10, 0, 0);
const S = 1000;
const MIN = 60 * S;
const caps = { cpus: 4, memoryMiB: 6144 };
const slot = (minutes, extra = {}) => ({ jobId: `job-${minutes}`, dueAt: NOW + minutes * MIN, cpus: 1, memoryMiB: 1024, preferred: true, ...extra });
const running = (cpus, memoryMiB) => ({ state: "running", cpus, memoryMiB });
const decide = (extra) => vmDecision({ now: NOW, vm: { state: "stopped" }, busy: false, lastBusyAt: NOW, upcoming: [], bootSeconds: 20,
  desired: { cpus: 2, memoryMiB: 2048 }, ...extra });

test("size: ceil(Σ GiB of the runs expected at once in 15 min) + 0.75 GiB, clamped to [2 GiB, cap]; CPUs the largest, clamped", () => {
  assert.deepEqual(planVmSize({ now: NOW, caps }), { cpus: 2, memoryMiB: 2048 }, "nothing expected: the minimum");
  assert.deepEqual(planVmSize({ now: NOW, caps, upcoming: [slot(5, { memoryMiB: 512 })] }), { cpus: 2, memoryMiB: 2048 }, "1 + 0.75 GiB clamps up to 2 GiB");
  assert.deepEqual(planVmSize({ now: NOW, caps, upcoming: [slot(5), slot(10, { memoryMiB: 512 })] }), { cpus: 2, memoryMiB: 2816 }, "1.5 → 2 GiB + 0.75");
  assert.deepEqual(planVmSize({ now: NOW, caps, upcoming: [slot(5, { memoryMiB: 4096, cpus: 3 }), slot(6, { memoryMiB: 4096 })] }), { cpus: 3, memoryMiB: 6144 },
    "clamped to the cap");
  assert.deepEqual(planVmSize({ now: NOW, caps, upcoming: [slot(5, { cpus: 8 })] }).cpus, 4, "CPUs clamp to the cap too");
  assert.deepEqual(planVmSize({ now: NOW, caps, maxRuns: 1, upcoming: [slot(5, { memoryMiB: 512 }), slot(6, { memoryMiB: 3072 })] }), { cpus: 2, memoryMiB: 3840 },
    "at most maxRuns at once: the largest");
  assert.deepEqual(planVmSize({ now: NOW, caps, upcoming: [slot(16, { memoryMiB: 4096 })] }), { cpus: 2, memoryMiB: 2048 }, "beyond 15 minutes it does not count");
  assert.deepEqual(planVmSize({ now: NOW, caps, upcoming: [slot(5, { memoryMiB: 4096, preferredElsewhere: true })] }), { cpus: 2, memoryMiB: 2048 },
    "a slot another machine is preferred for does not count");
  assert.deepEqual(planVmSize({ now: NOW, caps, maxRuns: 1, runs: [{ cpus: 1, memoryMiB: 1024 }], upcoming: [slot(5, { memoryMiB: 3072 })] }),
    { cpus: 2, memoryMiB: 2048 }, "what runs now always counts; the run slot is taken");
  assert.deepEqual(planVmSize({ now: NOW, caps: { cpus: 1, memoryMiB: 1024 }, min: { cpus: 1, memoryMiB: 1024 } }), { cpus: 1, memoryMiB: 1024 },
    "a test profile's smaller minimum");
  assert.deepEqual(planVmSize({ now: NOW, caps: { cpus: 1, memoryMiB: 1536 }, min: { cpus: 2, memoryMiB: 2048 } }), { cpus: 2, memoryMiB: 2048 },
    "a cap below the minimum gives the minimum");
});

test("fits and grows: a run fits beside what runs only within the VM less its overhead", () => {
  assert.equal(vmFits({ cpus: 2, memoryMiB: 2048 }, { cpus: 1, memoryMiB: 1024 }), true);
  assert.equal(vmFits({ cpus: 2, memoryMiB: 2048 }, { cpus: 1, memoryMiB: 1024 }, 512), false);
  assert.equal(vmFits({ cpus: 2, memoryMiB: 2048 }, { cpus: 3, memoryMiB: 256 }), false);
  assert.equal(vmFits({ cpus: null, memoryMiB: null }, { cpus: 1 }), false);
  assert.deepEqual(sizeFor({ cpus: 2, memoryMiB: 2048 }, { cpus: 1, memoryMiB: 3000 }, 0, caps), { cpus: 2, memoryMiB: 3840 });
  assert.deepEqual(sizeFor({ cpus: 2, memoryMiB: 2048 }, { cpus: 8, memoryMiB: 9000 }, 0, caps), caps, "never past the cap");
});

test("pre-warm: the VM starts bootSeconds + 10 s before the first upcoming slot, and not before", () => {
  const upcoming = [slot(10), slot(2)];
  const early = decide({ now: NOW, upcoming });
  assert.equal(early.action, "none");
  assert.equal(early.wakeAt, NOW + 2 * MIN - 30 * S, "it wakes at the lead: 20 s boot + 10 s");
  assert.equal(decide({ now: NOW + 2 * MIN - 31 * S, upcoming }).action, "none");
  const due = decide({ now: NOW + 2 * MIN - 30 * S, upcoming });
  assert.deepEqual([due.action, due.size], ["start", { cpus: 2, memoryMiB: 2048 }]);
  assert.match(due.reason, /pre-warm for job-2/);
  assert.equal(decide({ now: NOW + 2 * MIN - 50 * S, upcoming, bootSeconds: 45 }).action, "start", "a slower measured boot starts earlier");
  assert.equal(decide({ now: NOW, upcoming: [] }).action, "none");
  assert.equal(decide({ now: NOW, upcoming: [slot(0.25, { preferredElsewhere: true })] }).action, "none", "not for another machine's slot");
  assert.equal(decide({ vm: { state: "absent" }, upcoming: [slot(0.25)] }).action, "start", "a profile never created starts the same way");
  assert.deepEqual(ownUpcoming([slot(-5), slot(1)], NOW).map((entry) => entry.jobId), ["job-1"]);
});

test("after three failed starts, pre-warm and resizes are held back (the agent's probe retries)", () => {
  const held = decide({ upcoming: [slot(0.25)], mayStart: false });
  assert.equal(held.action, "none");
  assert.match(held.reason, /held back/);
  const resize = decide({ vm: running(2, 2048), desired: { cpus: 2, memoryMiB: 4096 }, upcoming: [slot(3)], mayStart: false });
  assert.equal(resize.action, "none");
});

test("resize only while the VM holds no containers: grow for what is coming, shrink only when there is time to boot", () => {
  const big = { cpus: 2, memoryMiB: 4864 };
  assert.equal(decide({ vm: running(2, 2048), busy: true, desired: big, upcoming: [slot(3)] }).action, "none", "busy: never resized");
  const grow = decide({ vm: running(2, 2048), desired: big, upcoming: [slot(3)] });
  assert.deepEqual([grow.action, grow.size], ["resize", big]);
  assert.match(grow.reason, /^grow/);
  const shrink = decide({ vm: running(2, 4864), desired: { cpus: 2, memoryMiB: 2048 }, upcoming: [slot(3)] });
  assert.deepEqual([shrink.action, shrink.size], ["resize", { cpus: 2, memoryMiB: 2048 }]);
  assert.equal(decide({ vm: running(2, 4864), desired: { cpus: 2, memoryMiB: 2048 }, upcoming: [slot(0.5)] }).action, "none",
    "no shrink when the boot would end after the slot");
  assert.equal(decide({ vm: running(2, 2816), desired: { cpus: 2, memoryMiB: 2048 }, upcoming: [slot(3)] }).action, "none",
    "no restart to save less than 1 GiB");
  assert.equal(decide({ vm: running(2, 2048), desired: big, upcoming: [slot(30)], lastBusyAt: NOW }).action, "none",
    "nothing within keep-warm: no resize for a slot the VM will stop before");
});

test("idle stop: no containers, no claims, nothing upcoming within keepWarmSeconds, after idleStopSeconds", () => {
  const config = { idleStopSeconds: 300, keepWarmSeconds: 600 };
  const idle = decide({ vm: running(2, 2048), config, lastBusyAt: NOW - 100 * S });
  assert.deepEqual([idle.action, idle.wakeAt], ["none", NOW + 200 * S]);
  const stop = decide({ vm: running(2, 2048), config, lastBusyAt: NOW - 300 * S });
  assert.equal(stop.action, "stop");
  assert.match(stop.reason, /idle for 300 s/);
  assert.equal(decide({ vm: running(2, 2048), config, busy: true, lastBusyAt: NOW - 900 * S }).action, "none", "never while busy");
  const warm = decide({ vm: running(2, 2048), config, lastBusyAt: NOW - 900 * S, upcoming: [slot(9)] });
  assert.equal(warm.action, "none", "a slot within keepWarmSeconds keeps it running");
  assert.match(warm.reason, /kept warm for job-9/);
  const later = decide({ vm: running(2, 2048), config, lastBusyAt: NOW - 100 * S, upcoming: [slot(12)] });
  assert.deepEqual([later.action, later.wakeAt], ["none", NOW + 2 * MIN], "it looks again when the slot comes within keep-warm");
  assert.equal(decide({ vm: running(2, 2048), config, lastBusyAt: NOW - 900 * S, upcoming: [slot(11)] }).action, "stop",
    "a slot beyond keepWarmSeconds does not");
  assert.equal(decide({ vm: running(2, 2048), config: { idleStopSeconds: 0, keepWarmSeconds: 600 }, lastBusyAt: NOW - 86_400 * S }).action, "none",
    "idleStopSeconds 0: always on");
  assert.equal(decide({ vm: running(2, 2048), config: { idleStopSeconds: 20, keepWarmSeconds: 0 }, lastBusyAt: NOW - 20 * S }).action, "stop",
    "the control plane's (or the machine's) config decides the times");
  assert.equal(decide({ vm: { state: "starting" } }).action, "none");
});

// Clocks. The agent stamps nothing the server relies on: phase times come
// from the server's receipt (§3.1). Durations come from `monotonic()`, which
// a wall-clock change cannot distort. `sleep` resolves early when its signal
// aborts; callers check why they woke.

function sleeper(now, timers) {
  return (ms, signal) => new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = { at: now() + ms, wake: done };
    const handle = setTimeout(done, Math.max(0, ms));
    function done() {
      clearTimeout(handle);
      timers?.delete(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    timers?.add(timer);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export const systemClock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  sleep: sleeper(() => Date.now()),
};

/**
 * A clock that runs in real time but can be moved forward (`advance`), for
 * tests: a lease expiring after 90 s or a grace of 10 minutes passes at once,
 * and any sleep whose end is passed wakes. The control plane under test is
 * given the same time on each request.
 */
export function offsetClock(start = Date.now()) {
  let offset = start - Date.now();
  const timers = new Set();
  const now = () => Date.now() + offset;
  return {
    now,
    monotonic: () => performance.now() + offset,
    sleep: sleeper(now, timers),
    advance(ms) {
      offset += ms;
      for (const timer of [...timers]) if (timer.at <= now()) timer.wake();
    },
  };
}

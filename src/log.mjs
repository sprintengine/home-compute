// Timestamps for the daemon's log (controller.log under launchd): every line
// it writes gets the time it was written. A JSON event gets `at` (ISO 8601,
// UTC) as its first field, so the file stays one JSON object per line; any
// other line is prefixed with the time. Lines that already carry `at` are
// left alone.

/** The line with its time: `{"at": …, …}` for a JSON object, `<iso> <text>` otherwise. */
export function stampLine(line, now = new Date()) {
  const at = now.toISOString();
  if (typeof line !== "string") return line;
  const text = line.trimStart();
  if (text.startsWith("{")) {
    try {
      const event = JSON.parse(text);
      if (event && typeof event === "object" && !Array.isArray(event)) {
        return "at" in event ? line : JSON.stringify({ at, ...event });
      }
    } catch {
      // Not JSON after all: prefixed below.
    }
  }
  return `${at} ${line}`;
}

/**
 * Makes `console.log/info/warn/error` stamp their first argument when it is
 * a string (the daemon logs one string per event). Returns the undo.
 */
export function stampConsole(target = console, clock = () => new Date()) {
  const originals = {};
  for (const method of ["log", "info", "warn", "error"]) {
    originals[method] = target[method];
    target[method] = (first, ...rest) => originals[method].call(target, typeof first === "string" ? stampLine(first, clock()) : first, ...rest);
  }
  return () => Object.assign(target, originals);
}

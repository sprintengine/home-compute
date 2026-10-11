const ERROR_LINE = [
  /Traceback \(most recent call last\)/,
  /\b(?:ERROR|CRITICAL|FATAL|PANIC)\b/,
  /^\s*(?:[A-Za-z_][\w.]*)?(?:Error|Exception|Interrupt|Exit)(?::|$)/,
  /\b(?:error|failed|failure|fatal)\s*[:!]/i,
  /"(?:level|severity|levelname)"\s*:\s*"(?:error|critical|fatal|panic)"/i,
  /"event"\s*:\s*"[^"]*_failed"/,
  /\blevel=(?:error|critical|fatal)\b/i,
];
const WARNING_LINE = [
  /\b(?:WARN|WARNING)\b/,
  /"(?:level|severity|levelname)"\s*:\s*"warn(?:ing)?"/i,
  /\blevel=warn(?:ing)?\b/i,
];
const REPORT_LINE = /^\s*\{.*"event"\s*:/;

/**
 * Each line with a level for the dashboard to colour: `error` for error
 * lines, a Python traceback (its indented frames and the exception that
 * ends it) or a `*_failed` report; `warning`; `report` for a JSON-line
 * report; else `info`.
 */
export function classifyLines(lines) {
  let inTraceback = false;
  return lines.map((text) => {
    let level = "info";
    if (inTraceback) {
      level = "error";
      // The traceback ends with its first unindented line, the exception itself.
      if (text.trim() && !/^\s/.test(text)) inTraceback = false;
    }
    if (/Traceback \(most recent call last\)/.test(text)) {
      inTraceback = true;
      level = "error";
    } else if (level === "info") {
      if (ERROR_LINE.some((pattern) => pattern.test(text))) level = "error";
      else if (WARNING_LINE.some((pattern) => pattern.test(text))) level = "warning";
      else if (REPORT_LINE.test(text)) level = "report";
    }
    return { text, level };
  });
}

/** The last `maxLines` lines of `text`, and whether any were left out. */
export function tailLines(text, maxLines) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  if (lines.length === 1 && lines[0] === "") return { lines: [], omitted: 0 };
  const omitted = Math.max(0, lines.length - maxLines);
  return { lines: lines.slice(omitted), omitted };
}

/**
 * The newest lines that fit both `maxLines` and `maxBytes` (UTF-16 length,
 * which is what a JSON body carries), and whether any were left out.
 */
export function boundLines(lines, { lines: maxLines, bytes: maxBytes }) {
  const kept = [];
  let size = 0;
  for (let index = lines.length - 1; index >= 0 && kept.length < maxLines; index -= 1) {
    const length = lines[index].length + 1;
    if (size + length > maxBytes) break;
    kept.push(lines[index]);
    size += length;
  }
  kept.reverse();
  return { lines: kept, truncated: kept.length < lines.length };
}

function sizeLabel(bytes) {
  const mib = bytes / 1048576;
  if (mib >= 1024 && Number.isInteger(mib / 1024)) return `${mib / 1024} GiB`;
  if (mib >= 1024) return `${(mib / 1024).toFixed(1)} GiB`;
  return `${Math.round(mib)} MiB`;
}

/**
 * A failed run's one-line error and its detail (§4.6), in this order: the
 * last `*_failed` report's error; the last line of the first Python
 * traceback; the last error-level line; out of memory; timed out; the exit
 * code. The detail is the first traceback, else the 40 lines that end at the
 * last error line, cut to `maxDetail` characters from the end.
 */
export function extractError(lines, {
  reports = [], oomKilled = false, memoryLimitBytes = null, timedOut = false, runSeconds = null, exitCode = null, maxDetail = 4096,
} = {}) {
  const classified = classifyLines(lines);
  let traceback = null;
  for (let index = 0; index < classified.length && !traceback; index += 1) {
    if (!/Traceback \(most recent call last\)/.test(classified[index].text)) continue;
    let end = index + 1;
    while (end < classified.length && (classified[end].text.trim() === "" || /^\s/.test(classified[end].text))) end += 1;
    traceback = classified.slice(index, Math.min(end + 1, classified.length)).map((line) => line.text);
  }
  const lastErrorIndex = classified.findLastIndex((line) => line.level === "error");
  const failed = reports.findLast((report) => typeof report?.event === "string" && report.event.endsWith("_failed") && report.error);
  let error = null;
  if (failed) error = String(failed.error);
  else if (traceback) error = traceback.findLast((text) => text.trim() && !/^\s/.test(text))?.trim() ?? null;
  if (!error && lastErrorIndex >= 0) error = classified[lastErrorIndex].text.trim();
  if (!error && oomKilled) error = memoryLimitBytes ? `out of memory (limit ${sizeLabel(memoryLimitBytes)})` : "out of memory";
  if (!error && timedOut) error = runSeconds ? `timed out after ${runSeconds} s` : "timed out";
  if (!error && exitCode !== null && exitCode !== undefined && exitCode !== 0) error = `exited with ${exitCode}`;
  let detail = traceback
    ?? (lastErrorIndex >= 0 ? classified.slice(Math.max(0, lastErrorIndex - 39), lastErrorIndex + 1).map((line) => line.text) : null);
  detail = detail ? detail.join("\n") : null;
  if (detail && detail.length > maxDetail) detail = detail.slice(-maxDetail);
  if (error && error.length > 500) error = `${error.slice(0, 497)}...`;
  return { error, errorDetail: detail };
}

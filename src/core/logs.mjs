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

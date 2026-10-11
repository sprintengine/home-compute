// A run's output as the agent keeps it (§4.6): every line redacted on
// arrival (the run's secret values in their plain, URL- and base64-encoded
// forms, then the credential patterns), cut to 4 KB, then kept three ways:
// the newest lines for the tail, the json-lines reports apart from the tail
// so a long log never loses a `forecast_complete`, and the whole redacted
// log gzipped to the state directory for 7 days.

import { createWriteStream } from "node:fs";
import { createGzip } from "node:zlib";
import { boundLines, classifyLines } from "../../src/core/logs.mjs";
import { FINAL_TAIL, MAX_LINE_CHARS, RUNNING_TAIL } from "../../src/core/protocol.mjs";
import { createRedactor, secretForms } from "../../src/core/redact.mjs";
import { parseReports } from "../../src/core/reports.mjs";

const MAX_REPORTS = 1000;

export class LogCapture {
  /** `secrets`: the run's secret values. `file`: where the gzipped copy goes, or null; `append: false` starts it afresh. */
  constructor({ secrets = [], file = null, append = true } = {}) {
    this.redact = createRedactor(secretForms(secrets));
    this.lines = [];
    this.reports = [];
    this.bytesTotal = 0;
    this.linesTotal = 0;
    this.version = 0;
    this.sentVersion = 0;
    this.gzip = null;
    if (file) {
      this.gzip = createGzip();
      const output = createWriteStream(file, { flags: append ? "a" : "w", mode: 0o600 });
      this.gzip.pipe(output);
      this.closed = new Promise((resolve) => output.on("close", resolve).on("error", resolve));
    }
  }

  /** One line of output, redacted before anything else sees it. Returns the stored line. */
  push(raw) {
    let line = this.redact(String(raw).replace(/\r?\n$/, ""));
    if (line.length > MAX_LINE_CHARS) line = `${line.slice(0, MAX_LINE_CHARS)} …[line cut]`;
    this.bytesTotal += line.length + 1;
    this.linesTotal += 1;
    this.lines.push(line);
    if (this.lines.length > FINAL_TAIL.lines * 2) this.lines.splice(0, this.lines.length - FINAL_TAIL.lines);
    if (line.trimStart().startsWith("{")) {
      this.reports.push(...parseReports(line));
      if (this.reports.length > MAX_REPORTS) this.reports.splice(0, this.reports.length - MAX_REPORTS);
    }
    this.gzip?.write(`${line}\n`);
    this.version += 1;
    return line;
  }

  tail(bounds) {
    const { lines, truncated } = boundLines(this.lines, bounds);
    return {
      text: lines.join("\n"),
      bytesTotal: this.bytesTotal,
      linesTotal: this.linesTotal,
      truncated: truncated || this.linesTotal > this.lines.length,
      errorCount: classifyLines(lines).filter((entry) => entry.level === "error").length,
    };
  }

  /** The running tail (200 lines / 32 KB), only when it changed since the last one the server took. */
  pendingTail() {
    return this.version === this.sentVersion ? null : { ...this.tail(RUNNING_TAIL), version: this.version };
  }

  markSent(version) {
    if (version > this.sentVersion) this.sentVersion = version;
  }

  finalTail() {
    return this.tail(FINAL_TAIL);
  }

  /** The lines error extraction reads: the newest 500. */
  recentLines() {
    return this.lines.slice(-FINAL_TAIL.lines);
  }

  async close() {
    if (!this.gzip) return;
    this.gzip.end();
    await this.closed;
    this.gzip = null;
  }
}

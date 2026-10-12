// A container's output as `docker logs -f --timestamps` gives it (§4.6):
// stdout and stderr, each line prefixed with an RFC 3339 timestamp. This
// turns that into lines for the capture: the timestamp is taken off (and
// kept, so a reattach after `docker logs` dies resumes after the last line
// rather than repeating the log), and a line rewritten with carriage returns
// (a progress bar) becomes what a terminal would end up showing.

import { StringDecoder } from "node:string_decoder";

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})) ?/;

/** A timestamp as a string that sorts in time order: `2026-10-11T10:00:00.5Z` → `2026-10-11T10:00:00.500000000`. */
export function timestampKey(timestamp) {
  const match = String(timestamp ?? "").match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/);
  if (!match) {
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? `${new Date(parsed).toISOString().slice(0, 19)}.${String(parsed % 1000).padStart(3, "0")}000000` : "";
  }
  return `${match[1]}.${(match[2] ?? "").padEnd(9, "0").slice(0, 9)}`;
}

/**
 * One line of `docker logs --timestamps` output: `{at, text}`. `text` loses
 * a trailing CR (CRLF output), and of a line rewritten with CRs keeps the
 * part after the last one, as a terminal shows it: `10%\r50%\r100%` → `100%`.
 */
export function parseLogLine(raw) {
  let text = String(raw);
  let at = null;
  const match = text.match(TIMESTAMP);
  if (match) {
    at = match[1];
    text = text.slice(match[0].length);
  }
  text = text.replace(/\r+$/, "");
  const cr = text.lastIndexOf("\r");
  if (cr >= 0) text = text.slice(cr + 1);
  return { at, text };
}

/** Splits a byte stream into lines (UTF-8 safe across chunks); the last line may lack its newline. */
export class LineSplitter {
  constructor(onLine) {
    this.onLine = onLine;
    this.decoder = new StringDecoder("utf8");
    this.rest = "";
  }

  push(chunk) {
    this.rest += this.decoder.write(chunk);
    let newline = this.rest.indexOf("\n");
    while (newline >= 0) {
      this.onLine(this.rest.slice(0, newline));
      this.rest = this.rest.slice(newline + 1);
      newline = this.rest.indexOf("\n");
    }
  }

  end() {
    this.rest += this.decoder.end();
    if (this.rest) this.onLine(this.rest);
    this.rest = "";
  }
}

/** An async queue of lines that ends when `close()` is called; `fail(error)` ends it with an error. */
export class LineQueue {
  constructor() {
    this.items = [];
    this.closed = false;
    this.error = null;
    this.wake = null;
  }

  push(line) {
    this.items.push(line);
    this.#notify();
  }

  close() {
    this.closed = true;
    this.#notify();
  }

  fail(error) {
    this.error = error;
    this.close();
  }

  #notify() {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (this.items.length) yield this.items.shift();
      if (this.closed) {
        if (this.error) throw this.error;
        return;
      }
      await new Promise((resolve) => { this.wake = resolve; });
    }
  }
}

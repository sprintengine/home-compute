// Keeping request bodies inside hc-core's limits (128 KB sync, 256 KB
// complete), measured as hc-core measures them: UTF-8 bytes of the JSON.
// Tails are bounded per run in characters, which non-ASCII output (progress
// bars, CJK) and JSON escaping can push past a byte limit, and several runs'
// tails add up; a body the server refuses would be refused again on every
// retry. So the largest tail is cut (from its start, keeping the newest
// lines) until the body fits, then reports, then the error detail.

import { MAX_COMPLETE_BYTES, MAX_SYNC_BYTES } from "../../src/core/protocol.mjs";

/** Room left for headers and the server's own reading. */
const MARGIN = 2048;

export function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

/** `text` without its oldest part, about half as long, cut at a line boundary. */
function halve(text) {
  if (text.length < 64) return "";
  const rest = text.slice(Math.floor(text.length / 2));
  const newline = rest.indexOf("\n");
  return newline >= 0 && newline < rest.length - 1 ? rest.slice(newline + 1) : rest;
}

/** Cuts the largest of `tails` (objects with `text`) until `size()` fits `limit`. Returns whether it fits. */
function shrinkTails(tails, size, limit) {
  while (size() > limit) {
    const largest = tails.filter((tail) => tail?.text).sort((a, b) => b.text.length - a.text.length)[0];
    if (!largest) return false;
    largest.text = halve(largest.text);
    largest.truncated = true;
  }
  return true;
}

/** A sync body that fits 128 KB: its runs' tails cut as needed (the request is changed in place and returned). */
export function fitSyncBody(body, limit = MAX_SYNC_BYTES - MARGIN) {
  shrinkTails(body.runs.map((run) => run.logTail), () => jsonBytes(body), limit);
  return body;
}

/** A completion record that fits 256 KB: its tail cut, then its oldest reports, then its error detail. */
export function fitRecord(record, limit = MAX_COMPLETE_BYTES - MARGIN) {
  const size = () => jsonBytes(record);
  if (size() <= limit) return record;
  if (record.logTail) shrinkTails([record.logTail], size, limit);
  while (size() > limit && record.reports?.length) record.reports = record.reports.slice(Math.ceil(record.reports.length / 4));
  if (size() > limit && record.errorDetail) record.errorDetail = record.errorDetail.slice(-1024);
  if (size() > limit && record.error) record.error = record.error.slice(0, 200);
  return record;
}

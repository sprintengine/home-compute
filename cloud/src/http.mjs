// Small HTTP helpers shared by hc-web and hc-core.

import { HttpError } from "../../src/core/errors.mjs";

export { HttpError };

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export function json(status, body, headers = {}) {
  return new Response(`${JSON.stringify(body)}\n`, { status, headers: { ...JSON_HEADERS, ...headers } });
}

export function empty(status, headers = {}) {
  return new Response(null, { status, headers: { "cache-control": "no-store", ...headers } });
}

/**
 * The request's JSON body, refused past `maxBytes` before it is parsed (a
 * large body is the main way to spend the 10 ms CPU budget). An empty body is {}.
 */
export async function readJson(request, { maxBytes = 64 * 1024 } = {}) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, "Request body is too large");
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, "Request body is too large");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
}

/** An error as the response a client sees: its own status, or 400 for a validation message, or 500. */
export function errorResponse(error) {
  if (error instanceof HttpError || Number.isInteger(error?.status)) {
    return json(error.status, { error: error.message, ...(error.code ? { code: error.code } : {}) });
  }
  if (error instanceof Error && !(error instanceof TypeError) && !/D1_|SQLITE/.test(error.message)) {
    return json(400, { error: error.message });
  }
  console.error(JSON.stringify({ event: "unhandled_error", error: String(error?.message ?? error) }));
  return json(500, { error: "internal_error" });
}

export function iso(time) {
  return time === null || time === undefined ? null : new Date(time).toISOString();
}

/** A query parameter as a whole number within bounds, or the fallback. */
export function integerParam(url, name, { fallback, minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new HttpError(400, `${name} must be a whole number from ${minimum} to ${maximum}`);
  }
  return value;
}

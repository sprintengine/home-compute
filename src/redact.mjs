import { jobEnvironmentNames } from "./bacalhau.mjs";

const REDACTED = "<redacted>";
// Names whose value is a credential however short it is.
const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH|PRIVATE|SESSION/i;
// Names whose value may carry an account id or credentials in a URL.
const LOCATOR_NAME = /URL|URI|ENDPOINT|DSN/i;

// Credential shapes that may show up in output whatever the environment holds.
const PATTERNS = [
  // AWS-style access key ids.
  [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{12,}\b/g, () => REDACTED],
  // NAME=value / NAME: value for credential-looking names.
  [/\b([A-Za-z0-9_.-]*(?:secret|token|password|passwd|api[_-]?key|access[_-]?key)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([^\s"',;&]+)/gi,
    (_, name, separator) => `${name}${separator}${REDACTED}`],
  // HTTP authorization headers.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, (_, scheme) => `${scheme} ${REDACTED}`],
  // Pre-signed URL signatures and credentials.
  [/([?&](?:X-Amz-(?:Signature|Credential|Security-Token)|Signature|AWSAccessKeyId|sig|token)=)[^&\s"']+/gi,
    (_, prefix) => `${prefix}${REDACTED}`],
  // user:password@ in URLs.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, (_, scheme) => `${scheme}${REDACTED}@`],
];

/**
 * The values a job's output must never show: what the controller passes to
 * jobs (the same names `buildJobSpec` redacts in a rendered spec) where the
 * name says it is a credential or a locator, plus any extra secrets such as
 * the API token. Short values of other names ("0", "auto") would only mangle
 * the log, and are not secret.
 */
export function secretValues(jobs, environment, extra = []) {
  const values = new Set(extra.filter((value) => typeof value === "string" && value.length >= 4));
  for (const job of jobs) {
    for (const name of jobEnvironmentNames(job)) {
      const value = environment?.[name];
      if (typeof value !== "string") continue;
      if ((SECRET_NAME.test(name) && value.length >= 4) || (LOCATOR_NAME.test(name) && value.length >= 8)) {
        values.add(value);
      }
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/** A function that replaces every known secret value and credential shape in text. */
export function createRedactor(values = []) {
  const known = [...new Set(values)].filter(Boolean).sort((a, b) => b.length - a.length);
  return function redact(text) {
    let result = String(text ?? "");
    for (const value of known) {
      if (result.includes(value)) result = result.split(value).join(REDACTED);
    }
    for (const [pattern, replace] of PATTERNS) result = result.replace(pattern, replace);
    return result;
  };
}

/** Redacts every string inside a JSON-like value (a report, say), keeping its shape. */
export function redactValue(value, redact, depth = 0) {
  if (typeof value === "string") return redact(value);
  if (!value || typeof value !== "object" || depth > 8) return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, redact, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, redact, depth + 1)]));
}

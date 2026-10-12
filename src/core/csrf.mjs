// The checks a state-changing browser request must pass, shared by the local
// controller (DashboardAuth) and the hosted API. Pure: callers pass header
// values in, so a Node request and a Fetch Request both fit.

/** Whether two strings are equal, in time that depends only on their lengths. */
export function constantTimeEqual(a, b) {
  const left = String(a ?? "");
  const right = String(b ?? "");
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

/** Whether an Origin header names one of `hosts` (host[:port], any case). */
export function originMatches(origin, hosts) {
  if (!origin) return false;
  let host;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  return hosts.filter(Boolean).map((value) => value.split(",")[0].trim().toLowerCase()).includes(host);
}

/**
 * Why a state-changing request is refused, or null when it may go ahead.
 *
 * Every such request must be JSON (a form post cannot set that type without
 * a preflight, and CORS is never enabled), and when a browser says where it
 * comes from (`Origin`, `Sec-Fetch-Site`), it must be this site. A browser
 * identity (`browser: true`) must also send its Origin and echo its CSRF
 * token. A client holding a header credential (a service token, a bearer
 * token) is not a browser, so it carries its own proof.
 */
export function csrfRefusal({ contentType, origin, hosts, fetchSite, browser, token, expected }) {
  if (!/^application\/json\b/i.test(String(contentType ?? "").trim())) return "content_type";
  if (fetchSite && fetchSite !== "same-origin") return "cross_site";
  if (origin && !originMatches(origin, hosts)) return "origin";
  if (!browser) return null;
  if (!origin) return "origin";
  if (!expected || !constantTimeEqual(token, expected)) return "csrf_token";
  return null;
}

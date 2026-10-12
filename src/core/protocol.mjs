// The agent protocol (§4.2 and §7 of docs/hosted-control-plane.md): its
// version, timings, size limits and credential formats, shared by hc-core and
// the agent. Pure: Web Crypto and TextEncoder only, which Node and Workers
// both provide.

/** The protocol this code speaks, and the oldest hc-core still accepts (older agents get 426). */
export const PROTOCOL = 1;
export const MIN_PROTOCOL = 1;

/** A claimed run's lease, renewed by its machine's syncs (§3.3). */
export const LEASE_MS = 90_000;
/** A lease is renewed once it is this old, so a busy machine writes its runs' rows every 30 s, not every 10 s. */
export const LEASE_RENEW_AFTER_MS = 30_000;
/** `machines.last_seen_at` is written at most this often unless something else about the machine changed. */
export const LAST_SEEN_WRITE_MS = 60_000;
/**
 * A machine is offline once its last recorded sync is older than this: the
 * design's 90 s without a sync, plus the 60 s by which `last_seen_at` may lag.
 */
export const OFFLINE_MS = 150_000;

/** The server-set sync interval (§4.2): 10 s with work, at most 30 s idle, 2 s after a slot it may claim. */
export const SYNC_BUSY_MS = 10_000;
export const SYNC_IDLE_MS = 30_000;
export const SYNC_SLOT_MARGIN_MS = 2_000;
export const SYNC_MIN_MS = 1_000;
/** Due runs one sync looks at, and how far ahead `upcoming` looks (the VM sizing window of §4.4). */
export const CLAIM_SCAN = 20;
export const UPCOMING_MS = 15 * 60_000;

/** Request body limits (§7): the main way to spend a Worker's 10 ms of CPU is a large body. */
export const MAX_ENROL_BYTES = 16 * 1024;
export const MAX_SYNC_BYTES = 128 * 1024;
export const MAX_COMPLETE_BYTES = 256 * 1024;
/** Log tails: the last 200 lines / 32 KB while running, 500 lines / 64 KB at completion (§4.6). */
export const RUNNING_TAIL = { lines: 200, bytes: 32 * 1024 };
export const FINAL_TAIL = { lines: 500, bytes: 64 * 1024 };
export const MAX_ERROR_DETAIL = 4 * 1024;
export const MAX_LINE_CHARS = 4 * 1024;

/** Container labels the agent sets and finds its runs by after a restart (§3.4, §4.3). */
export const RUN_LABEL = "dev.homecompute.run";
export const JOB_LABEL = "dev.homecompute.job";

/** A credential: `hca_<machineId>_<43 base64url characters>` (32 random bytes). */
const CREDENTIAL = /^hca_(m_[0-9A-HJKMNP-TV-Z]{26})_([A-Za-z0-9_-]{43})$/;
/** A join token: `hcj_<43 base64url characters>`. */
export const JOIN_TOKEN = /^hcj_[A-Za-z0-9_-]{43}$/;
export const MACHINE_ID = /^m_[0-9A-HJKMNP-TV-Z]{26}$/;
export const RUN_ID = /^r_[0-9A-HJKMNP-TV-Z]{26}$/;
/** Machine names, as `preferMachines` lists them: the job id rules. */
export const MACHINE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The machine a credential names, or null when it is not a credential at all. */
export function parseCredential(text) {
  const match = typeof text === "string" && text.match(CREDENTIAL);
  return match ? { machineId: match[1] } : null;
}

export function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 32 random bytes as base64url: the secret part of a credential or join token. */
export function randomSecret() {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function newCredential(machineId) {
  return `hca_${machineId}_${randomSecret()}`;
}

export function newJoinToken() {
  return `hcj_${randomSecret()}`;
}

/** SHA-256 of a string, as lowercase hex: how credentials and join tokens are stored. */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

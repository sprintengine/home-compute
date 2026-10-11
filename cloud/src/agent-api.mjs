// hc-core's agent API (§7): enrol, sync and complete. Agents authenticate
// with their machine credential (never Access); bodies are size-capped
// before they are parsed; an agent speaking a protocol older than hc-core
// accepts is told to update (426). Every answer is `Cache-Control: no-store`
// (claims will carry secrets from M5).

import { MAX_COMPLETE_BYTES, MAX_ENROL_BYTES, MAX_SYNC_BYTES, MIN_PROTOCOL, PROTOCOL } from "../../src/core/protocol.mjs";
import { parseComplete, parseEnrol, parseSync } from "./agent-body.mjs";
import { complete } from "./complete.mjs";
import { HttpError, json, readJson } from "./http.mjs";
import { authenticateMachine, enrol } from "./machines.mjs";
import { sync } from "./sync.mjs";

const COMPLETE = /^\/agent\/v1\/runs\/(r_[0-9A-HJKMNP-TV-Z]{26})\/complete$/;
const PROVISIONING = /^\/agent\/v1\/provisioning\/[^/]+\/events$/;

/** 426 for an agent whose protocol is older than hc-core still speaks. */
function checkProtocol(body) {
  const protocol = body?.protocol;
  if (!Number.isInteger(protocol) || protocol < MIN_PROTOCOL) {
    const error = new HttpError(426, `This control plane needs agent protocol ${MIN_PROTOCOL} or later; update the agent`);
    error.code = "upgrade_required";
    throw error;
  }
}

/** The answer to an /agent/v1/* request, or null when the path is not one. */
export async function handleAgent(request, env, url, now) {
  const { pathname } = url;
  const completing = pathname.match(COMPLETE);
  const known = pathname === "/agent/v1/enrol" || pathname === "/agent/v1/sync" || completing || PROVISIONING.test(pathname);
  if (!known) return null;
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
  const ip = request.headers.get("cf-connecting-ip");
  const headers = { "x-hc-protocol": String(PROTOCOL) };

  if (pathname === "/agent/v1/enrol") {
    const body = await readJson(request, { maxBytes: MAX_ENROL_BYTES });
    checkProtocol(body);
    return json(201, await enrol(env.DB, parseEnrol(body), { now, ip }), headers);
  }
  const { machine, rotated } = await authenticateMachine(env.DB, request, now);
  if (PROVISIONING.test(pathname)) return json(501, { error: "not_implemented", detail: "Provisioning arrives in M6" });
  if (pathname === "/agent/v1/sync") {
    const body = await readJson(request, { maxBytes: MAX_SYNC_BYTES });
    checkProtocol(body);
    return json(200, await sync(env.DB, parseSync(body), { machine, rotated, now, ip }), headers);
  }
  const body = await readJson(request, { maxBytes: MAX_COMPLETE_BYTES });
  checkProtocol(body);
  return json(200, await complete(env.DB, completing[1], parseComplete(body), { machine, now }), headers);
}

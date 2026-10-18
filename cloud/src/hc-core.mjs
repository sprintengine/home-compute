// hc-core: the agent API and the per-minute cron. It never serves people:
// no dashboard, no /v1, no Access in front. Agents authenticate with their
// own machine credentials (§5, §7).

import { WorkerEntrypoint } from "cloudflare:workers";
import { handleAgent } from "./agent-api.mjs";
import { errorResponse, json } from "./http.mjs";
import { CRON_STALE_MS } from "./alerts.mjs";
import { minute } from "./cron.mjs";

export { HcContainerBasic, HcContainerLite, HcContainerStandard1 } from "./container-do.mjs";

/**
 * hc-web's way in (a service binding, never a public route): after Run now,
 * Cancel or Retry on a Cloudflare job, check and start containers at once
 * instead of at the next cron minute. Safe beside the cron: every claim is a
 * compare-and-set and each run's object checks one at a time.
 */
export class Dispatcher extends WorkerEntrypoint {
  async dispatch() {
    const { dispatchCloudflare } = await import("./containers.mjs");
    return dispatchCloudflare(this.env, Date.now());
  }
}

/**
 * GET /health: the Worker answers (200), with the cron's last tick. GET
 * /health/cron, for the dead-man check outside Cloudflare: 200 only while
 * the cron has ticked in the last 5 minutes and D1 answers, else 503 with
 * why. Neither says anything a stranger could use: no jobs, machines or alerts.
 */
async function health(env, now, { strict = false } = {}) {
  let lastTick = null;
  try {
    const row = await env.DB.prepare("SELECT value_json FROM settings WHERE key = 'cron_last_tick'").first();
    lastTick = row ? Number(JSON.parse(row.value_json)) : null;
  } catch {
    return json(strict ? 503 : 200, { status: "error", service: "hc-core", problem: "database unavailable" });
  }
  const ageSeconds = lastTick === null ? null : Math.round((now - lastTick) / 1000);
  const stale = lastTick === null || now - lastTick > CRON_STALE_MS;
  return json(stale && strict ? 503 : 200, {
    status: stale ? "error" : "ok", service: "hc-core", cronLastTickAt: lastTick === null ? null : new Date(lastTick).toISOString(),
    cronAgeSeconds: ageSeconds, ...(stale ? { problem: lastTick === null ? "the cron has never ticked" : "the cron has stopped ticking" } : {}),
  });
}

/** hc-core's answer to a request; `now` (epoch ms) is for tests. */
export async function handleCore(request, env, { now = Date.now() } = {}) {
  const url = new URL(request.url);
  try {
    if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/health/cron")) {
      return await health(env, now, { strict: url.pathname === "/health/cron" });
    }
    const answer = await handleAgent(request, env, url, now);
    return answer ?? json(404, { error: "not_found" });
  } catch (error) {
    return errorResponse(error);
  }
}

export default {
  fetch: (request, env) => handleCore(request, env),

  async scheduled(controller, env, ctx) {
    const summary = await minute(env, controller.scheduledTime);
    const alerts = summary.alerts ?? {};
    const containers = summary.containers ?? {};
    if (summary.materialised.created || summary.lost || summary.retried || summary.timedOut || summary.retention
      || alerts.error || alerts.opened || alerts.resolved || alerts.emailed
      || containers.started || containers.failed || containers.error) {
      console.log(JSON.stringify({ event: "cron", cron: controller.cron, ...summary }));
    }
    return summary;
  },
};

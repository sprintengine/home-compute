// hc-core: the agent API and the per-minute cron. It never serves people:
// no dashboard, no /v1, no Access in front. Agents authenticate with their
// own machine credentials (§5, §7).

import { handleAgent } from "./agent-api.mjs";
import { errorResponse, json } from "./http.mjs";
import { minute } from "./cron.mjs";

/** hc-core's answer to a request; `now` (epoch ms) is for tests. */
export async function handleCore(request, env, { now = Date.now() } = {}) {
  const url = new URL(request.url);
  try {
    if (request.method === "GET" && url.pathname === "/health") return json(200, { status: "ok", service: "hc-core" });
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
    if (summary.materialised.created || summary.lost || summary.retried || summary.timedOut || summary.retention) {
      console.log(JSON.stringify({ event: "cron", cron: controller.cron, ...summary }));
    }
    return summary;
  },
};

// hc-core: the agent API and the per-minute cron. It never serves people:
// no dashboard, no /v1. In M1 only the cron is live; the agent endpoints
// (§7, "Agent API") arrive with the agent in M2.

import { errorResponse, json } from "./http.mjs";
import { minute } from "./cron.mjs";

const AGENT_PATHS = /^\/agent\/v1\/(?:enrol|sync|runs\/[^/]+\/complete|provisioning\/[^/]+\/events)$/;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/health") return json(200, { status: "ok", service: "hc-core" });
      if (AGENT_PATHS.test(url.pathname)) return json(501, { error: "not_implemented", detail: "The agent protocol ships in M2" });
      return json(404, { error: "not_found" });
    } catch (error) {
      return errorResponse(error);
    }
  },

  async scheduled(controller, env, ctx) {
    const summary = await minute(env, controller.scheduledTime);
    if (summary.materialised.created || summary.lost || summary.timedOut || summary.retention) {
      console.log(JSON.stringify({ event: "cron", cron: controller.cron, ...summary }));
    }
    return summary;
  },
};

// hc-core as the integration tests run it: the real Worker, plus two things
// only a test may do. The time a request is handled at comes from its
// `x-hc-test-now` header (the test's movable clock), and GET /__test/cron
// runs one cron minute at `?now=`. Never deployed: only test-node bundles it.
import { handleCore } from "../../src/hc-core.mjs";
import { minute } from "../../src/cron.mjs";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const now = Number(request.headers.get("x-hc-test-now") ?? url.searchParams.get("now") ?? Date.now());
    if (url.pathname === "/__test/cron") return Response.json(await minute(env, now));
    return handleCore(request, env, { now });
  },
};

// The hosted dashboard in a real browser (Chromium through playwright-core)
// at a phone's 390×844 and a desktop's 1440×900, against hc-web and hc-core
// under `wrangler dev` with a local D1 seeded by support/dashboard-seed.mjs:
// Wingfoil's timetable, demo jobs, a FakeRuntime agent and runs in several
// states. People are signed in as Access would sign them in (a
// Cf-Access-Jwt-Assertion from a local JWKS); one context relies on
// DEV_ACCESS_EMAIL instead.
//
// Skipped when Playwright's Chromium is not installed (npx playwright install
// chromium) unless HC_REQUIRE_BROWSER_TESTS=1, which CI sets.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ADMIN, DEV_USER, startDevStack } from "./support/dev-stack.mjs";
import { seedDashboard } from "./support/dashboard-seed.mjs";

const VIEWER = "viewer@example.com";
const VIEWPORTS = [{ name: "phone", width: 390, height: 844, mobile: true }, { name: "desktop", width: 1440, height: 900, mobile: false }];

let chromium = null;
let skip = false;
try {
  ({ chromium } = await import("playwright-core"));
  const probe = await chromium.launch();
  await probe.close();
} catch (error) {
  if (process.env.HC_REQUIRE_BROWSER_TESTS === "1") throw error;
  skip = `no Chromium for playwright-core (${String(error.message).split("\n")[0]}): run npx playwright install chromium`;
}

let stack;
let seeded;
let browser;

async function waitUntil(check, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/** A signed-in page: `email` as Access would present it, or null for DEV_ACCESS_EMAIL. */
async function open(viewport, email, hash = "#/") {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.mobile, hasTouch: viewport.mobile,
    serviceWorkers: "block", ...(email ? { extraHTTPHeaders: { "cf-access-jwt-assertion": stack.jwtFor(email) } } : {}),
  });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && !/status of 40[349]/.test(message.text())) problems.push(message.text()); });
  await page.goto(`${stack.web}/${hash}`);
  await page.waitForSelector("main h1, main .summary");
  return { page, context, problems };
}

describe("the hosted dashboard in a browser", { skip, timeout: 600_000 }, () => {
  before(async () => {
    stack = await startDevStack();
    seeded = await seedDashboard(stack);
    await stack.api("/v1/settings", { method: "PATCH", body: { roles: { [VIEWER]: "viewer" } } });
    browser = await chromium.launch();
  }, { timeout: 300_000 });

  after(async () => {
    await browser?.close();
    await seeded?.stop();
    await stack?.close();
  });

  for (const viewport of VIEWPORTS) {
    describe(`at ${viewport.width}×${viewport.height}`, () => {
      it("leads the overview with what needs attention, then what runs and what is next", async () => {
        const { page, context, problems } = await open(viewport, ADMIN);
        const attention = page.locator("ul.attention");
        await attention.waitFor();
        const text = await attention.innerText();
        for (const expected of [
          "flaky: last run failed", "No space left on device", "nightly-backup: run lost", "gpu-render: waiting", "no machine has labels gpu=yes",
          "old-box is offline", "linux-1: VM failed to start", "linux-1: clock 42 s ahead", "old-box: agent 0.1.0 needs an update", "jobs blocked",
        ]) assert.ok(text.includes(expected), `attention shows "${expected}":\n${text}`);
        // Critical items come first.
        assert.ok(text.indexOf("flaky: last run failed") < text.indexOf("gpu-render: waiting"));
        assert.match(await page.locator("ul.running").innerText(), /slow[\s\S]*mac-mini[\s\S]*peak 412 MiB of 1 GiB/);
        assert.equal(await page.locator("ol.next > li").count(), 6);
        assert.match(await page.locator(".job-grid").innerText(), /ecmwf[\s\S]*Daily at 08:20, 10:20 UTC/);
        assert.match(await page.locator(".off-line").innerText(), /Off in the timetable \(7\): aifs/);
        assert.ok(await page.locator("svg.spark").count() >= 4, "duration sparklines");
        assert.equal(await page.locator("nav#nav a[aria-current=page] .nav-label").innerText(), "Overview");
        assert.deepEqual(problems, []);
        await context.close();
      });

      it("shows a change made elsewhere without a reload (GET /v1/changes)", async () => {
        const { page, context } = await open(viewport, ADMIN);
        let changesCalls = 0;
        page.on("request", (request) => { if (request.url().includes("/v1/changes")) changesCalls += 1; });
        const job = viewport.mobile ? "tides" : "verify";
        await stack.api(`/v1/jobs/${job}/pause`, { method: "POST" });
        const card = page.locator("a.job", { hasText: job });
        await waitUntil(async () => /Paused/.test(await card.innerText()), `${job} to show as paused`);
        assert.ok(changesCalls >= 1);
        await stack.api(`/v1/jobs/${job}/resume`, { method: "POST" });
        if (!viewport.mobile) {
          // Hidden, it stops asking; visible again, it asks at once.
          const visibility = (state) => page.evaluate((value) => {
            Object.defineProperty(document, "visibilityState", { value, configurable: true });
            document.dispatchEvent(new Event("visibilitychange"));
          }, state);
          await visibility("hidden");
          const before = changesCalls;
          await new Promise((resolve) => setTimeout(resolve, 12_000));
          assert.equal(changesCalls, before, "no polling while hidden");
          await visibility("visible");
          await waitUntil(() => changesCalls > before, "a poll on becoming visible", 3000);
        }
        await context.close();
      });

      it("Run now with extra arguments creates a manual run", async () => {
        const job = viewport.mobile ? "hello" : "nightly-backup";
        const { page, context } = await open(viewport, ADMIN, `#/job/${job}`);
        await page.click("#run-now");
        await page.fill("#run-args", `--models ${job} --note "two words"`);
        await page.click("#run-submit");
        await page.locator("#toast", { hasText: "submitted" }).waitFor();
        const { runs } = await stack.api(`/v1/jobs/${job}/runs?limit=1`);
        assert.equal(runs[0].source, "manual");
        assert.deepEqual(runs[0].parameters, ["--models", job, "--note", "two words"]);
        assert.equal(runs[0].requestedBy, ADMIN);
        await context.close();
      });

      it("saves a timetable edit through PATCH /v1/jobs/:id/timetable, and it persists", async () => {
        const job = viewport.mobile ? "flaky" : "hello";
        const { page, context } = await open(viewport, ADMIN, `#/job/${job}`);
        await page.click("#tt-edit");
        if (viewport.mobile) await page.click('button[aria-label="14:00 UTC"]');
        else await page.click('button[aria-label="minute 30"]');
        assert.match(await page.locator('[data-edit="timetable"] p[aria-live]').innerText(), viewport.mobile ? /2 slots a day: 09:45, 14:45 UTC/ : /6 slots a day/);
        const patch = page.waitForRequest((request) => request.url().endsWith(`/v1/jobs/${job}/timetable`) && request.method() === "PATCH");
        await page.click("#tt-save");
        const request = await patch;
        assert.ok(request.headers()["x-hc-csrf"], "the CSRF token goes with it");
        await page.locator("#toast", { hasText: "Timetable saved" }).waitFor();
        const saved = await stack.api(`/v1/jobs/${job}`);
        assert.deepEqual(saved.schedule.at, viewport.mobile ? { hours: [9, 14], minutes: [45] } : { hours: [6, 12, 18], minutes: [15, 30] });
        await page.reload();
        await page.locator(".schedule-text").waitFor();
        assert.equal(await page.locator(".schedule-text").innerText(),
          viewport.mobile ? "Daily at 09:45, 14:45 UTC" : "Daily at 06:15, 06:30, 12:15, 12:30, 18:15, 18:30 UTC");
        await context.close();
      });

      it("drains and undrains a machine", async () => {
        const { page, context } = await open(viewport, ADMIN, "#/machines");
        const card = page.locator("article.machine", { hasText: "linux-1" });
        await page.click("#drain-linux-1");
        await page.locator("#toast", { hasText: "draining" }).waitFor();
        await waitUntil(async () => /Draining/.test(await card.innerText()), "the Draining chip");
        assert.equal((await stack.api(`/v1/machines/${seeded.ids.machines.linux}`)).drain, true);
        await page.click("#drain-linux-1");
        await page.locator("#toast", { hasText: "takes work again" }).waitFor();
        assert.equal((await stack.api(`/v1/machines/${seeded.ids.machines.linux}`)).drain, false);
        await context.close();
      });

      it("shows a join token once, with install commands that do not contain it", async () => {
        const { page, context } = await open(viewport, ADMIN, "#/machines/add");
        await page.fill("#jt-name", `box-${viewport.width}`);
        await page.click("#jt-create");
        const token = await page.locator("#join-token").inputValue();
        assert.match(token, /^hcj_[A-Za-z0-9_-]{43}$/);
        const commands = await page.locator("pre.commands").allInnerTexts();
        assert.equal(commands.length, 6);
        assert.ok(commands.every((text) => !text.includes(token)), "the token is never in a command");
        assert.ok(commands.some((text) => text.includes(`--server ${stack.core} --join-token-stdin`)));
        await page.click("#token-done");
        await page.waitForURL(/#\/machines$/);
        await page.goto(`${stack.web}/#/machines/add`);
        await page.locator("#jt-create").waitFor();
        assert.equal(await page.locator("#join-token").count(), 0, "gone once left");
        const audit = await stack.api("/v1/audit?limit=20");
        const entry = audit.entries.find((candidate) => candidate.action === "machine.join-token" && candidate.target === `box-${viewport.width}`);
        assert.ok(entry);
        assert.ok(!JSON.stringify(audit).includes(token), "the audit log never holds the token");
        await context.close();
      });

      it("refuses a change without the CSRF token, and accepts it with", async () => {
        const { page, context } = await open(viewport, ADMIN, "#/settings");
        const result = await page.evaluate(async () => {
          const send = (headers) => fetch("/v1/jobs/hello/resources", {
            method: "PATCH", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ memoryMiB: 512 }),
          }).then(async (response) => ({ status: response.status, body: await response.json() }));
          const token = window.homeCompute.state.session.csrfToken;
          return { without: await send({}), forged: await send({ "x-hc-csrf": "forged" }), with: await send({ "x-hc-csrf": token }) };
        });
        assert.deepEqual([result.without.status, result.without.body], [403, { error: "csrf_check_failed", reason: "csrf_token" }]);
        assert.equal(result.forged.status, 403);
        assert.equal(result.with.status, 200);
        await context.close();
      });

      it("hides every change from a viewer, and the API refuses one anyway", async () => {
        const { page, context, problems } = await open(viewport, VIEWER, "#/job/hello");
        await page.locator(".schedule-text").waitFor();
        assert.match(await page.locator("main").innerText(), /You can look but not change anything/);
        for (const selector of ["#run-now", "#tt-edit", "#pl-edit", "#rs-edit", "#im-edit", "#im-pin"]) {
          assert.equal(await page.locator(selector).count(), 0, selector);
        }
        await page.goto(`${stack.web}/#/machines`);
        await page.locator("article.machine").first().waitFor();
        assert.equal(await page.locator("#add-machine, [id^=drain-]").count(), 0);
        await page.goto(`${stack.web}/#/run/${seeded.ids.runs.slow}`);
        await page.locator(".phases-list").waitFor();
        assert.equal(await page.locator("#run-cancel, #run-retry").count(), 0);
        await page.goto(`${stack.web}/#/settings`);
        await page.locator("#me-title").waitFor();
        assert.equal(await page.locator("#global-pause, #settings-edit").count(), 0);
        const refused = await page.evaluate(async () => {
          const response = await fetch("/v1/jobs/hello/run", {
            method: "POST", headers: { "content-type": "application/json", "x-hc-csrf": window.homeCompute.state.session.csrfToken }, body: "{}",
          });
          return { status: response.status, body: await response.json() };
        });
        assert.deepEqual(refused, { status: 403, body: { error: "forbidden", role: "viewer", needs: "operator" } });
        assert.deepEqual(problems, []);
        await context.close();
      });

      it("opens a failed run at its first error, with errors only", async () => {
        const { page, context } = await open(viewport, ADMIN, `#/run/${seeded.ids.runs.flaky}`);
        await page.locator(".log-line.error").first().waitFor();
        assert.match(await page.locator(".error-summary").innerText(), /OSError: \[Errno 28\] No space left on device/);
        assert.match(await page.locator(".phases-list").innerText(), /Due[\s\S]*Claimed[\s\S]*Run[\s\S]*Failed/);
        await page.click("#log-errors");
        const visible = await page.locator(".log-line:visible").count();
        assert.equal(visible, 4, "the traceback's four lines");
        await page.click("#log-first-error");
        assert.equal(await page.locator("#L3.flash").count(), 1);
        await context.close();
      });
    });
  }

  it("signs in as DEV_ACCESS_EMAIL under wrangler dev when no Access token comes", async () => {
    const { page, context } = await open(VIEWPORTS[1], null, "#/settings");
    await page.locator("#me-title").waitFor();
    assert.match(await page.locator("main").innerText(), new RegExp(`Signed in as\\s+${DEV_USER.replace(".", "\\.")}[\\s\\S]*Role\\s+admin`));
    await context.close();
  });

  it("revokes a machine after its name is typed", async () => {
    const { page, context } = await open(VIEWPORTS[0], ADMIN, `#/machine/${seeded.ids.machines.oldBox}`);
    await page.click("#machine-revoke");
    const confirm = page.locator("#confirm-ok");
    assert.equal(await confirm.isDisabled(), true, "not until the name is typed");
    await page.fill("#confirm-input", "old-box");
    await confirm.click();
    await page.waitForURL(/#\/machines$/);
    await page.locator("#toast", { hasText: "old-box revoked" }).waitFor();
    assert.equal(await page.locator("article.machine", { hasText: "old-box" }).count(), 0);
    const all = await stack.api("/v1/machines?all=1");
    assert.equal(all.machines.find((machine) => machine.name === "old-box").status, "revoked");
    await context.close();
  });
});

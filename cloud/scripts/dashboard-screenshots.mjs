#!/usr/bin/env node
// Screenshots of every dashboard page at a phone's 390×844 and a desktop's
// 1440×900, against hc-web and hc-core under `wrangler dev` with the seeded
// control plane of test-node/support/dashboard-seed.mjs.
//
//   node cloud/scripts/dashboard-screenshots.mjs [outdir]     # default /tmp/hc-m4
//   node cloud/scripts/dashboard-screenshots.mjs --serve      # seed, print the URL and a sign-in header, keep running
//
// Needs Playwright's Chromium (npx playwright install chromium).
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { ADMIN, startDevStack } from "../test-node/support/dev-stack.mjs";
import { seedDashboard } from "../test-node/support/dashboard-seed.mjs";

const serve = process.argv.includes("--serve");
const out = path.resolve(process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "/tmp/hc-m4");
const VIEWPORTS = [{ name: "390x844", width: 390, height: 844, mobile: true }, { name: "1440x900", width: 1440, height: 900, mobile: false }];

/** The screen as a person sees it (`name.png`), and the whole page (`name-full.png`). */
async function shoot(page, name) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  await page.screenshot({ path: path.join(out, `${name}-full.png`), fullPage: true });
  console.log(path.join(out, `${name}.png`));
}

const stack = await startDevStack();
let seeded;
try {
  seeded = await seedDashboard(stack);
  if (serve) {
    console.log(`hc-web ${stack.web} (no header: ${"dev@example.com"}, an admin); hc-core ${stack.core}`);
    console.log(`viewer JWT: ${stack.jwtFor("viewer@example.com")}`);
    console.log(JSON.stringify(seeded.ids, null, 2));
    await new Promise((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  } else {
    await mkdir(out, { recursive: true });
    const { runs, machines } = seeded.ids;
    await stack.api("/v1/settings", { method: "PATCH", body: { roles: { "viewer@example.com": "viewer", "op@example.com": "operator" } } });
    const pages = [
      ["overview", "#/"],
      ["job", "#/job/hello"],
      ["job-wingfoil", "#/job/harmonie"],
      ["run-failed", `#/run/${runs.flaky}`],
      ["run-running", `#/run/${runs.slow}`],
      ["run-succeeded", `#/run/${runs.hello}`],
      ["timetable", "#/timetable"],
      ["machines", "#/machines"],
      ["machine", `#/machine/${machines.mac}`],
      ["machine-unhealthy", `#/machine/${machines.linux}`],
      ["add-machine", "#/machines/add"],
      ["settings", "#/settings"],
      ["audit", "#/audit"],
    ];
    const browser = await chromium.launch();
    try {
      for (const viewport of VIEWPORTS) {
        for (const [role, email] of [["admin", ADMIN], ["viewer", "viewer@example.com"]]) {
          const context = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: viewport.mobile ? 2 : 1, isMobile: viewport.mobile, hasTouch: viewport.mobile,
            extraHTTPHeaders: { "cf-access-jwt-assertion": stack.jwtFor(email) }, serviceWorkers: "block", colorScheme: "light",
          });
          const page = await context.newPage();
          const list = role === "admin" ? pages : [["overview", "#/"], ["job", "#/job/hello"], ["machines", "#/machines"]];
          for (const [name, hash] of list) {
            await page.goto(`${stack.web}/${hash}`);
            await page.waitForSelector("main h1, main .summary", { timeout: 20_000 });
            await page.waitForLoadState("networkidle");
            await page.waitForTimeout(400);
            await shoot(page, `${name}${role === "viewer" ? "-viewer" : ""}-${viewport.name}`);
          }
          if (role === "admin") {
            await page.goto(`${stack.web}/#/machines/add`);
            await page.fill("#jt-name", "linux-box");
            await page.click("#jt-create");
            await page.waitForSelector("#join-token");
            await shoot(page, `add-machine-token-${viewport.name}`);
            await page.goto(`${stack.web}/#/job/hello`);
            await page.waitForSelector("#tt-edit");
            await page.click("#tt-edit");
            await page.click("#rs-edit");
            await page.waitForTimeout(300);
            await shoot(page, `job-editing-${viewport.name}`);
          }
          await context.close();
        }
        // Dark mode, once per size.
        const dark = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: "dark", serviceWorkers: "block",
          extraHTTPHeaders: { "cf-access-jwt-assertion": stack.jwtFor(ADMIN) }, deviceScaleFactor: viewport.mobile ? 2 : 1 });
        const page = await dark.newPage();
        await page.goto(`${stack.web}/#/`);
        await page.waitForSelector("main .summary");
        await page.waitForLoadState("networkidle");
        await shoot(page, `overview-dark-${viewport.name}`);
        await dark.close();
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await seeded?.stop();
  await stack.close();
}

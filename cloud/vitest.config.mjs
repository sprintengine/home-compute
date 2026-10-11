// Worker tests run inside workerd (the Workers runtime) with a local D1 that
// has the real migrations applied: @cloudflare/vitest-plugin, the successor
// to @cloudflare/vitest-pool-workers. The vars here stand in for Access.
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/hc-web.mjs",
      wrangler: { configPath: "./wrangler.web.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          CSRF_KEY: "test-csrf-key",
          ACCESS_TEAM_DOMAIN: "test-team.cloudflareaccess.com",
          ACCESS_AUD: "test-application-aud",
          BOOTSTRAP_ADMINS: "owner@example.com",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.mjs"],
    setupFiles: ["./test/apply-migrations.mjs"],
  },
});

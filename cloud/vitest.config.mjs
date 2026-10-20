// Worker tests run inside workerd (the Workers runtime) with a local D1 that
// has the real migrations applied: @cloudflare/vitest-plugin, the successor
// to @cloudflare/vitest-pool-workers. The vars here stand in for Access.
import { generateKeyPairSync } from "node:crypto";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
// A vault key pair for the tests only: hc-web seals with the public half, hc-core opens with the private one.
const vault = generateKeyPairSync("rsa", { modulusLength: 3072, publicExponent: 0x10001 });
const VAULT_PUBLIC_KEY = vault.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const VAULT_PRIVATE_KEY = vault.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");

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
          VAULT_PUBLIC_KEY,
          VAULT_PRIVATE_KEY,
        },
        // hc-core is not running beside the tests: its Dispatcher answers nothing, and the nudge after Run now is best effort.
        serviceBindings: { HC_CORE: () => new Response(null, { status: 204 }) },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.mjs"],
    setupFiles: ["./test/apply-migrations.mjs"],
  },
});

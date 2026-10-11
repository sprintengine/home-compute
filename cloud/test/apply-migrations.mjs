// Applies migrations/*.sql to the test D1 before any test file runs (once per file; it is idempotent).
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

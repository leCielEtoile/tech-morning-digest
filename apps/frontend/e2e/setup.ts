import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";

interface SetupEnv {
  DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
}

const setupEnv = env as unknown as SetupEnv;
await applyD1Migrations(setupEnv.DB, setupEnv.TEST_MIGRATIONS);

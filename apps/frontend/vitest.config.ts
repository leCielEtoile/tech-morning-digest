import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

/**
 * ローカルe2e専用のvitest設定。既存のnode:test単体テスト(`pnpm test`)とは別レイヤーで、
 * 実workerd + 実(ローカル)D1上で `/api/*` を実際にfetchして検証する(`pnpm test:e2e`)。
 * GOOGLE_CLIENT_ID/SECRETはテスト専用のダミー値で上書きし、実secretsは不要にする。
 */
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            GOOGLE_CLIENT_ID: "dummy-client-id-for-e2e.apps.googleusercontent.com",
            GOOGLE_CLIENT_SECRET: "dummy-client-secret-for-e2e",
          },
        },
      }),
    ],
    test: {
      include: ["e2e/**/*.e2e.test.ts"],
      setupFiles: ["./e2e/setup.ts"],
    },
  };
});

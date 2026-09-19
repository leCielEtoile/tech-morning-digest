import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * 実際にデプロイされた環境に対するスモークテスト。認証済みAPIの実DB往復は対象外とし
 * (実データを汚すリスクがあるため。ローカルe2e(`pnpm test:e2e`)で既にカバー済み)、
 * 未認証パス・OAuthログイン開始のリダイレクト構築・ドキュメント公開のみを確認する。
 * `PROD_BASE_URL`未設定時はローカル実行を妨げないようスキップする(CIのe2e-prod.ymlでは
 * 常に設定される)。
 */
const baseUrl = process.env["PROD_BASE_URL"];
const skipReason = baseUrl ? false : "PROD_BASE_URLが未設定のためスキップ";

test("GET / -> 200", { skip: skipReason }, async () => {
  const res = await fetch(new URL("/", baseUrl));
  assert.equal(res.status, 200);
});

for (const path of ["/api/preferences", "/api/bookmarks", "/api/read-state"]) {
  test(`GET ${path}(未認証) -> 401`, { skip: skipReason }, async () => {
    const res = await fetch(new URL(path, baseUrl));
    assert.equal(res.status, 401);
  });
}

test("GET /api/unknown -> 404", { skip: skipReason }, async () => {
  const res = await fetch(new URL("/api/unknown", baseUrl));
  assert.equal(res.status, 404);
});

test("GET /api/auth/login -> Google認可URLへの302リダイレクト(PKCE + Cookie属性)", { skip: skipReason }, async () => {
  const res = await fetch(new URL("/api/auth/login", baseUrl), { redirect: "manual" });
  assert.equal(res.status, 302);
  const location = res.headers.get("location");
  assert.match(location ?? "", /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  assert.match(location ?? "", /code_challenge_method=S256/);
  const setCookies = res.headers.getSetCookie();
  assert.ok(setCookies.some((c) => c.startsWith("oauth_state=") && c.includes("HttpOnly") && c.includes("SameSite=Lax")));
  assert.ok(setCookies.some((c) => c.startsWith("oauth_code_verifier=")));
});

test("GET /api/openapi.json -> 200", { skip: skipReason }, async () => {
  const res = await fetch(new URL("/api/openapi.json", baseUrl));
  assert.equal(res.status, 200);
  const spec = (await res.json()) as { openapi: string };
  assert.equal(spec.openapi, "3.1.0");
});

test("GET /api/docs -> 200", { skip: skipReason }, async () => {
  const res = await fetch(new URL("/api/docs", baseUrl));
  assert.equal(res.status, 200);
});

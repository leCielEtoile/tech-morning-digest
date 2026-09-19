import { describe, expect, test } from "vitest";
import { env, SELF } from "cloudflare:test";
import { findOrCreateUserByGoogleSub } from "../worker/db/users.js";
import { createSession } from "../worker/db/sessions.js";
import type { ApiEnv } from "../worker/api/router.js";

/**
 * `Cloudflare.Env`はwrangler非公式のグローバル型で、このプロジェクトは`wrangler types`を
 * 導入していないため空({})のまま。既存のfakeDb系テストと同様、ここでも実バインディング形状を
 * 表す既存の`ApiEnv`型へキャストする。
 */
const testEnv = env as unknown as ApiEnv;

/**
 * 実際のGoogle OAuthを経由せず、実装済みのDB関数でユーザー・セッションを直接作成する。
 * `@cloudflare/vitest-plugin`にはテストごとのストレージ分離がなく、同一D1がファイル内の
 * 全describeで共有される。`findOrCreateUserByGoogleSub`は同じsubなら既存ユーザーを返すため、
 * 固定文字列のsubのまま再実行(--retryやwatchモード)するとブックマーク上限テスト等が
 * 「既に9件登録済みのユーザー」に対して実行されて失敗する。呼び出しごとに一意なsubにして
 * この非冪等性を避ける。
 */
async function seedSession(label: string): Promise<string> {
  const user = await findOrCreateUserByGoogleSub(testEnv.DB, `${label}-${crypto.randomUUID()}`);
  const session = await createSession(testEnv.DB, user.id);
  return session.id;
}

function withSession(sessionId: string, headers: Record<string, string> = {}): HeadersInit {
  return { ...headers, Cookie: `session_id=${sessionId}` };
}

describe("未認証パス", () => {
  test.each(["/api/preferences", "/api/bookmarks", "/api/read-state"])("GET %s -> 401", async (path) => {
    const res = await SELF.fetch(`https://example.com${path}`);
    expect(res.status).toBe(401);
  });

  test("GET /api/unknown -> 404", async () => {
    const res = await SELF.fetch("https://example.com/api/unknown");
    expect(res.status).toBe(404);
  });

  test("GET /api/auth/login -> Google認可URLへの302リダイレクト(PKCE + Cookie属性)", async () => {
    const res = await SELF.fetch("https://example.com/api/auth/login", { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    expect(location).toContain("code_challenge_method=S256");
    expect(location).toContain("redirect_uri=");
    const setCookies = res.headers.getSetCookie();
    expect(setCookies.some((c) => c.startsWith("oauth_state=") && c.includes("HttpOnly") && c.includes("SameSite=Lax"))).toBe(true);
    expect(setCookies.some((c) => c.startsWith("oauth_code_verifier="))).toBe(true);
  });

  test("GET /api/openapi.json -> OpenAPI 3.1のspecを返す", async () => {
    const res = await SELF.fetch("https://example.com/api/openapi.json");
    expect(res.status).toBe(200);
    const spec = await res.json<{ openapi: string; paths: Record<string, unknown> }>();
    expect(spec.openapi).toBe("3.1.0");
    expect(Object.keys(spec.paths)).toContain("/api/bookmarks");
  });

  test("GET /api/docs -> Swagger UIのHTMLを返す", async () => {
    const res = await SELF.fetch("https://example.com/api/docs");
    expect(res.status).toBe(200);
  });
});

describe("preferences", () => {
  test("GET/PUT往復、ホワイトリスト外400、不正JSON400", async () => {
    const sessionId = await seedSession("e2e-google-sub-prefs");

    const empty = await SELF.fetch("https://example.com/api/preferences", { headers: withSession(sessionId) });
    expect(await empty.json()).toEqual({ prefs: [] });

    const put = await SELF.fetch("https://example.com/api/preferences", {
      method: "PUT",
      headers: withSession(sessionId, { "content-type": "application/json" }),
      body: JSON.stringify([{ category: "開発・プログラミング", enabled: true }]),
    });
    expect(put.status).toBe(200);

    const after = await SELF.fetch("https://example.com/api/preferences", { headers: withSession(sessionId) });
    expect(await after.json()).toEqual({ prefs: [{ category: "開発・プログラミング", enabled: true }] });

    const invalidCategory = await SELF.fetch("https://example.com/api/preferences", {
      method: "PUT",
      headers: withSession(sessionId, { "content-type": "application/json" }),
      body: JSON.stringify([{ category: "存在しないカテゴリ", enabled: true }]),
    });
    expect(invalidCategory.status).toBe(400);

    const invalidJson = await SELF.fetch("https://example.com/api/preferences", {
      method: "PUT",
      headers: withSession(sessionId, { "content-type": "application/json" }),
      body: "{not valid json",
    });
    expect(invalidJson.status).toBe(400);
  });
});

describe("bookmarks", () => {
  test("10件上限で409、他人の削除はDB上反映されない(IDOR)", async () => {
    const session1 = await seedSession("e2e-google-sub-bm-1");
    const session2 = await seedSession("e2e-google-sub-bm-2");

    let lastId = "";
    for (let i = 0; i < 10; i += 1) {
      const res = await SELF.fetch("https://example.com/api/bookmarks", {
        method: "POST",
        headers: withSession(session1, { "content-type": "application/json" }),
        body: JSON.stringify({ articleLink: `https://example.com/${i}`, articleTitle: `記事${i}` }),
      });
      expect(res.status).toBe(201);
      const body = await res.json<{ bookmark: { id: string } }>();
      lastId = body.bookmark.id;
    }

    const overLimit = await SELF.fetch("https://example.com/api/bookmarks", {
      method: "POST",
      headers: withSession(session1, { "content-type": "application/json" }),
      body: JSON.stringify({ articleLink: "https://example.com/11", articleTitle: "記事11" }),
    });
    expect(overLimit.status).toBe(409);

    // user2がuser1のブックマークIDを指定して削除しても、実DB上は削除されないこと
    const idorDelete = await SELF.fetch(`https://example.com/api/bookmarks/${lastId}`, {
      method: "DELETE",
      headers: withSession(session2),
    });
    expect(idorDelete.status).toBe(200);

    const afterIdor = await SELF.fetch("https://example.com/api/bookmarks", { headers: withSession(session1) });
    const afterIdorBody = await afterIdor.json<{ bookmarks: { id: string }[] }>();
    expect(afterIdorBody.bookmarks.some((b) => b.id === lastId)).toBe(true);

    // 本人による削除は反映されること
    const ownDelete = await SELF.fetch(`https://example.com/api/bookmarks/${lastId}`, {
      method: "DELETE",
      headers: withSession(session1),
    });
    expect(ownDelete.status).toBe(200);

    const afterOwn = await SELF.fetch("https://example.com/api/bookmarks", { headers: withSession(session1) });
    const afterOwnBody = await afterOwn.json<{ bookmarks: { id: string }[] }>();
    expect(afterOwnBody.bookmarks.some((b) => b.id === lastId)).toBe(false);
  });

  test("javascript:スキームは400", async () => {
    const sessionId = await seedSession("e2e-google-sub-bm-xss");
    const res = await SELF.fetch("https://example.com/api/bookmarks", {
      method: "POST",
      headers: withSession(sessionId, { "content-type": "application/json" }),
      body: JSON.stringify({ articleLink: "javascript:alert(1)", articleTitle: "XSS" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("read-state", () => {
  test("POSTの冪等性", async () => {
    const sessionId = await seedSession("e2e-google-sub-read");
    const first = await SELF.fetch("https://example.com/api/read-state", {
      method: "POST",
      headers: withSession(sessionId, { "content-type": "application/json" }),
      body: JSON.stringify({ articleGuidHash: "hash-e2e" }),
    });
    expect(first.status).toBe(200);
    const second = await SELF.fetch("https://example.com/api/read-state", {
      method: "POST",
      headers: withSession(sessionId, { "content-type": "application/json" }),
      body: JSON.stringify({ articleGuidHash: "hash-e2e" }),
    });
    expect(second.status).toBe(200);

    const list = await SELF.fetch("https://example.com/api/read-state", { headers: withSession(sessionId) });
    expect(await list.json()).toEqual({ readArticleHashes: ["hash-e2e"] });
  });
});

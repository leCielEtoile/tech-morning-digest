import assert from "node:assert/strict";
import { test } from "node:test";
import { handleApiRequest, requireSession, type ApiEnv } from "./router.js";

function fakeEnv(): ApiEnv {
  const db = {
    prepare() {
      return {
        bind() {
          return this;
        },
        async first() {
          return null;
        },
        async run() {
          return { success: true } as unknown as D1Result;
        },
      };
    },
  } as unknown as D1Database;
  return { DB: db, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" };
}

test("handleApiRequest: /api/ 以外のパスはnullを返す(静的アセットへフォールバック)", async () => {
  const request = new Request("http://localhost/archive/");
  assert.equal(await handleApiRequest(request, fakeEnv()), null);
});

test("handleApiRequest: GET /api/auth/login は302を返す", async () => {
  const request = new Request("http://localhost/api/auth/login");
  const response = await handleApiRequest(request, fakeEnv());
  assert.equal(response?.status, 302);
});

test("handleApiRequest: 未知の /api/ パスは404を返す", async () => {
  const request = new Request("http://localhost/api/does-not-exist");
  const response = await handleApiRequest(request, fakeEnv());
  assert.equal(response?.status, 404);
});

test("requireSession: Cookieがなければnull", async () => {
  const request = new Request("http://localhost/api/bookmarks");
  assert.equal(await requireSession(request, fakeEnv().DB), null);
});

test("handleApiRequest: GET /api/preferences は認証必須(未ログインで401)", async () => {
  const request = new Request("http://localhost/api/preferences");
  const response = await handleApiRequest(request, fakeEnv());
  assert.equal(response?.status, 401);
});

test("handleApiRequest: GET /api/bookmarks は認証必須(未ログインで401)", async () => {
  const request = new Request("http://localhost/api/bookmarks");
  const response = await handleApiRequest(request, fakeEnv());
  assert.equal(response?.status, 401);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { handleCallback, handleLogin, handleLogout, parseSessionCookie } from "./auth-handlers.js";

const CONFIG = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  redirectUri: "http://localhost:8787/api/auth/google/callback",
};

function fakeDb(): D1Database {
  return {
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
}

test("parseSessionCookie: Cookieヘッダーからsession_idを取り出す", () => {
  const request = new Request("http://localhost/", { headers: { Cookie: "other=1; session_id=abc123; foo=bar" } });
  assert.equal(parseSessionCookie(request), "abc123");
});

test("parseSessionCookie: Cookieヘッダーがなければnull", () => {
  assert.equal(parseSessionCookie(new Request("http://localhost/")), null);
});

test("handleLogin: Googleへの302リダイレクトとstate/code_verifier Cookieを返す", async () => {
  const response = await handleLogin(CONFIG);

  assert.equal(response.status, 302);
  const location = response.headers.get("Location");
  assert.ok(location?.startsWith("https://accounts.google.com/"));
  const setCookies = response.headers.getSetCookie?.() ?? [];
  assert.ok(setCookies.some((c) => c.startsWith("oauth_state=")));
  assert.ok(setCookies.some((c) => c.startsWith("oauth_code_verifier=")));
});

test("handleCallback: state不一致は400を返す", async () => {
  const request = new Request("http://localhost/api/auth/google/callback?code=abc&state=wrong", {
    headers: { Cookie: "oauth_state=expected; oauth_code_verifier=verifier" },
  });
  const response = await handleCallback(request, fakeDb(), CONFIG);
  assert.equal(response.status, 400);
});

test("handleLogout: session_id CookieがあればdeleteSessionを呼びCookieを削除する", async () => {
  const request = new Request("http://localhost/api/auth/logout", { headers: { Cookie: "session_id=sess-1" } });
  const response = await handleLogout(request, fakeDb());

  assert.equal(response.status, 200);
  const setCookies = response.headers.getSetCookie?.() ?? [];
  assert.ok(setCookies.some((c) => c.includes("session_id=;") || c.includes("session_id=deleted")));
});

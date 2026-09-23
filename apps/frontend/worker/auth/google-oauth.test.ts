import assert from "node:assert/strict";
import { test } from "node:test";
import { createGoogleAuthorizationRequest, exchangeGoogleCode } from "./google-oauth.js";

const CONFIG = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  redirectUri: "http://localhost:8787/api/auth/google/callback",
};

/**
 * 署名は検証しないため任意の文字列でよいが、headerはoauth4webapiが
 * base64url JSONとしてパースするため有効な形式にする必要がある。
 */
function fakeIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-kid", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.signature`;
}

test("createGoogleAuthorizationRequest: Google認可URL・state・codeVerifierを返す", async () => {
  const req = await createGoogleAuthorizationRequest(CONFIG);

  assert.ok(req.url.startsWith("https://accounts.google.com/o/oauth2/v2/auth"));
  assert.ok(req.url.includes(`client_id=${CONFIG.clientId}`));
  assert.ok(req.url.includes("code_challenge_method=S256"));
  assert.ok(req.state.length > 0);
  assert.ok(req.codeVerifier.length > 0);
});

test("exchangeGoogleCode: トークン交換で得たID tokenからsubを取り出す", async () => {
  const original = globalThis.fetch;
  const calledUrls: string[] = [];
  globalThis.fetch = (async (input: string | Request | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    calledUrls.push(url);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      const nowSeconds = Math.floor(Date.now() / 1000);
      return new Response(
        JSON.stringify({
          access_token: "fake-access-token",
          token_type: "Bearer",
          expires_in: 3600,
          id_token: fakeIdToken({
            iss: "https://accounts.google.com",
            aud: CONFIG.clientId,
            sub: "google-sub-123",
            iat: nowSeconds,
            exp: nowSeconds + 3600,
          }),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const callbackUrl = new URL(`${CONFIG.redirectUri}?code=fake-code&state=expected-state`);
    const sub = await exchangeGoogleCode(CONFIG, callbackUrl, "expected-state", "fake-verifier");
    assert.equal(sub, "google-sub-123");
    assert.equal(calledUrls.length, 1, "トークンエンドポイント以外への追加fetchが発生していないこと");
  } finally {
    globalThis.fetch = original;
  }
});

test("exchangeGoogleCode: stateが一致しない場合は例外を投げる", async () => {
  const callbackUrl = new URL(`${CONFIG.redirectUri}?code=fake-code&state=wrong-state`);
  await assert.rejects(() => exchangeGoogleCode(CONFIG, callbackUrl, "expected-state", "fake-verifier"));
});

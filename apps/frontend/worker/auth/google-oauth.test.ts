import assert from "node:assert/strict";
import { test } from "node:test";
import { createGoogleAuthorizationRequest, exchangeGoogleCode } from "./google-oauth.js";

const CONFIG = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  redirectUri: "http://localhost:8787/api/auth/google/callback",
};

test("createGoogleAuthorizationRequest: Google認可URL・state・codeVerifierを返す", () => {
  const req = createGoogleAuthorizationRequest(CONFIG);

  assert.ok(req.url.startsWith("https://accounts.google.com/o/oauth2/v2/auth"));
  assert.ok(req.url.includes(`client_id=${CONFIG.clientId}`));
  assert.ok(req.state.length > 0);
  assert.ok(req.codeVerifier.length > 0);
});

/** header・署名はdecodeIdTokenが検証しないため任意の文字列でよい。payloadのみ実データにする。 */
function fakeIdToken(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `header.${payload}.signature`;
}

test("exchangeGoogleCode: トークン交換で得たID tokenをデコードしsubを返す(userinfoへの追加fetchはしない)", async () => {
  const original = globalThis.fetch;
  const calledUrls: string[] = [];
  globalThis.fetch = (async (input: string | Request | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    calledUrls.push(url);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({
          access_token: "fake-access-token",
          token_type: "Bearer",
          expires_in: 3600,
          id_token: fakeIdToken({ sub: "google-sub-123", iss: "https://accounts.google.com" }),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const sub = await exchangeGoogleCode(CONFIG, "fake-code", "fake-verifier");
    assert.equal(sub, "google-sub-123");
    assert.equal(calledUrls.length, 1, "userinfoエンドポイントへの追加fetchが発生していないこと");
  } finally {
    globalThis.fetch = original;
  }
});

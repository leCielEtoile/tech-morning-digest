import assert from "node:assert/strict";
import { test } from "node:test";
import { main } from "./index.js";

const ENV_VARS: Record<string, string> = {
  GEMINI_API_KEY: "test-gemini-key",
  CLOUDFLARE_ACCOUNT_ID: "test-account",
  R2_ACCESS_KEY_ID: "test-access-key",
  R2_SECRET_ACCESS_KEY: "test-secret-key",
  R2_BUCKET_NAME: "test-bucket",
};

async function withEnv<T>(fn: () => Promise<T>): Promise<T> {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(ENV_VARS)) {
    original[key] = process.env[key];
    process.env[key] = ENV_VARS[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(ENV_VARS)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

/** globalThis.fetch を差し替え、渡された Request を検査できるようにする(r2-client.test.tsと同じパターン) */
function mockFetch(handler: (req: Request) => Response | Promise<Response>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | Request | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    return handler(req);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("main: 本日分が既にR2に存在する場合は生成をスキップし、既読状態読み込み等それ以外のR2アクセスは行わない", async () => {
  let callCount = 0;
  const restore = mockFetch((req) => {
    callCount += 1;
    assert.equal(req.method, "GET");
    assert.match(req.url, /\/\d{4}-\d{2}-\d{2}\.json$/);
    return new Response('{"date":"dummy"}', { status: 200 });
  });
  try {
    await withEnv(() => main());
    assert.equal(callCount, 1, "本日分の存在確認のみでmainが終了し、他のR2/フィード取得が行われないこと");
  } finally {
    restore();
  }
});

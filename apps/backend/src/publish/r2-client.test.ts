import assert from "node:assert/strict";
import { test } from "node:test";
import { getR2Text, putR2Text } from "./r2-client.js";
import type { R2Config } from "./r2-client.js";

const R2: R2Config = {
  accountId: "acc",
  accessKeyId: "AKIA_TEST",
  secretAccessKey: "secret_test",
  bucketName: "bucket",
};

/** globalThis.fetch を差し替え、渡された Request を検査できるようにする */
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

test("getR2Text: 404はnullを返す", async () => {
  const restore = mockFetch(() => new Response("", { status: 404 }));
  try {
    assert.equal(await getR2Text(R2, "state/read-guids.json"), null);
  } finally {
    restore();
  }
});

test("getR2Text: 200は本文をそのまま返す", async () => {
  const restore = mockFetch(() => new Response('{"h":"2026-09-01T00:00:00.000Z"}', { status: 200 }));
  try {
    assert.equal(await getR2Text(R2, "state/read-guids.json"), '{"h":"2026-09-01T00:00:00.000Z"}');
  } finally {
    restore();
  }
});

test("getR2Text: 403など非リトライ対象の非2xxはthrowする", async () => {
  const restore = mockFetch(() => new Response("denied", { status: 403 }));
  try {
    await assert.rejects(() => getR2Text(R2, "k"));
  } finally {
    restore();
  }
});

test("putR2Text: PUTメソッド・本文・Content-Typeを送る", async () => {
  let captured: Request | undefined;
  const restore = mockFetch(async (req) => {
    captured = req;
    return new Response("", { status: 200 });
  });
  try {
    await putR2Text(R2, "state/read-guids.json", "body-text", "application/json; charset=utf-8");
    assert.ok(captured);
    assert.equal(captured.method, "PUT");
    assert.match(captured.url, /\/bucket\/state\/read-guids\.json$/);
    assert.equal(await captured.text(), "body-text");
    assert.equal(captured.headers.get("content-type"), "application/json; charset=utf-8");
  } finally {
    restore();
  }
});

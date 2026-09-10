import assert from "node:assert/strict";
import { test } from "node:test";
import { postWithRetry } from "./retry.js";

function mockFetch(responses: Array<Response | (() => never)>): { restore: () => void; calls: () => number } {
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async () => {
    const entry = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (typeof entry === "function") entry();
    return entry as Response;
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = original; }, calls: () => i };
}

test("postWithRetry: 初回200で成功し1回だけ呼ぶ", async () => {
  const m = mockFetch([new Response("", { status: 200 })]);
  try {
    await postWithRetry("https://example.test/hook", 3);
    assert.equal(m.calls(), 1);
  } finally {
    m.restore();
  }
});

test("postWithRetry: 500が続くと指定回数リトライして最後にthrow", async () => {
  const m = mockFetch([new Response("", { status: 500 })]);
  try {
    await assert.rejects(() => postWithRetry("https://example.test/hook", 3));
    assert.equal(m.calls(), 3);
  } finally {
    m.restore();
  }
});

test("postWithRetry: 500の後に200なら成功", async () => {
  const m = mockFetch([new Response("", { status: 500 }), new Response("", { status: 200 })]);
  try {
    await postWithRetry("https://example.test/hook", 3);
    assert.equal(m.calls(), 2);
  } finally {
    m.restore();
  }
});

test("postWithRetry: 400は即throw(リトライしない)", async () => {
  const m = mockFetch([new Response("", { status: 400 })]);
  try {
    await assert.rejects(() => postWithRetry("https://example.test/hook", 3));
    assert.equal(m.calls(), 1);
  } finally {
    m.restore();
  }
});

test("postWithRetry: ネットワークエラーが続くと指定回数リトライして最後にthrow", async () => {
  const m = mockFetch([() => { throw new Error("Network error"); }]);
  try {
    await assert.rejects(() => postWithRetry("https://example.test/hook", 3));
    assert.equal(m.calls(), 3);
  } finally {
    m.restore();
  }
});

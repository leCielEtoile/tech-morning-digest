import assert from "node:assert/strict";
import { test } from "node:test";
import { RetryableFetchError, isRetryableStatus, isTransientError, withRetry } from "./retry.js";

const FAST_OPTIONS = { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5 };

test("withRetry: 初回で成功すれば1回だけ呼ばれる", async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    return "ok";
  }, FAST_OPTIONS);

  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

test("withRetry: 一時的エラーで2回失敗しても3回目で成功する", async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    if (calls < 3) throw new TypeError("network down");
    return "recovered";
  }, FAST_OPTIONS);

  assert.equal(result, "recovered");
  assert.equal(calls, 3);
});

test("withRetry: maxRetries回すべて失敗したら最後のエラーをthrowする", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls += 1;
      throw new TypeError(`fail ${calls}`);
    }, FAST_OPTIONS),
    /fail 3/,
  );
  assert.equal(calls, 3, "maxRetries=3回ちょうど試行して打ち切るべき");
});

test("withRetry: isRetryableがfalseを返すエラーは即座に投げ直しリトライしない", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new Error("永続的エラー");
      },
      { ...FAST_OPTIONS, isRetryable: () => false },
    ),
    /永続的エラー/,
  );
  assert.equal(calls, 1);
});

test("isRetryableStatus: 429と5xxはtrue、その他4xxはfalse", () => {
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(500), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus(404), false);
});

test("isTransientError: RetryableFetchErrorとTypeErrorはtrue、それ以外はfalse", () => {
  const response = new Response(null, { status: 500 });
  assert.equal(isTransientError(new RetryableFetchError("x", response)), true);
  assert.equal(isTransientError(new TypeError("network")), true);
  assert.equal(isTransientError(new Error("plain")), false);
});

test("withRetry: respectRetryAfter=trueの場合、Retry-Afterヘッダーの秒数を待機時間に使う", async () => {
  let calls = 0;
  const response = new Response(null, { status: 429, headers: { "Retry-After": "0" } });
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 2) throw new RetryableFetchError("rate limited", response);
      return "ok";
    },
    { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5, respectRetryAfter: true },
  );

  assert.equal(result, "ok");
  assert.equal(calls, 2);
});

test("withRetry: Retry-AfterがmaxDelayMsを超える場合はmaxDelayMsにキャップされる", async () => {
  let calls = 0;
  // 3600秒(1時間)というQuota reset相当の現実的な値。maxDelayMs(5ms)にキャップされないと
  // テストが実質タイムアウトするまで終わらない
  const response = new Response(null, { status: 429, headers: { "Retry-After": "3600" } });
  const waits: number[] = [];
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 2) throw new RetryableFetchError("rate limited", response);
      return "ok";
    },
    {
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 5,
      respectRetryAfter: true,
      onRetry: (_attempt, _error, waitMs) => waits.push(waitMs),
    },
  );

  assert.equal(result, "ok");
  assert.equal(waits.length, 1);
  assert.ok(waits[0]! <= 5, `待機時間はmaxDelayMs(5ms)を超えてはならないが${waits[0]}msだった`);
});

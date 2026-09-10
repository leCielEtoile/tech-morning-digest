import assert from "node:assert/strict";
import { test } from "node:test";
import { toJstDateString } from "@rss-summary/shared";
import worker from "./index.js";

interface CapturedCall {
  url: string;
  method: string;
}

function installFetchMock(handler: (url: string) => Response): {
  restore: () => void;
  calls: CapturedCall[];
} {
  const original = globalThis.fetch;
  const calls: CapturedCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const method =
      init?.method ?? (typeof input === "object" && "method" in input ? (input as Request).method : "GET");
    calls.push({ url, method });
    return handler(url);
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    calls,
  };
}

const env = {
  DEPLOY_HOOK_URL: "https://deploy.test/hook",
  ALERT_WEBHOOK_URL: "https://alert.test/webhook",
  CLOUDFLARE_ACCOUNT_ID: "acct123",
  R2_ACCESS_KEY_ID: "akid",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_BUCKET_NAME: "bucket",
  ASSETS: { fetch: async () => new Response("asset") },
} as unknown as Parameters<NonNullable<typeof worker.scheduled>>[1];

const ctx = {} as unknown as Parameters<NonNullable<typeof worker.scheduled>>[2];

function run(cron: string): Promise<void> {
  const controller = { cron } as unknown as Parameters<NonNullable<typeof worker.scheduled>>[0];
  return worker.scheduled!(controller, env, ctx);
}

const R2_HOST = "r2.cloudflarestorage.com";

test("scheduled: buildクローンはDEPLOY_HOOK_URLへPOSTする", async () => {
  const m = installFetchMock(() => new Response("", { status: 200 }));
  try {
    await run("30 23 * * *");
    assert.ok(
      m.calls.some((c) => c.url === "https://deploy.test/hook" && c.method === "POST"),
    );
  } finally {
    m.restore();
  }
});

test("scheduled: watchdogは当日分が新鮮ならアラートを送らない", async () => {
  const today = toJstDateString(new Date());
  const m = installFetchMock((url) => {
    if (url.includes(R2_HOST)) {
      return new Response(JSON.stringify({ date: today }), { status: 200 });
    }
    throw new Error(`想定外のfetch: ${url}`);
  });
  try {
    await run("0 2 * * *");
    assert.equal(m.calls.length, 1);
    assert.ok(m.calls[0]?.url.includes(R2_HOST));
    assert.ok(!m.calls.some((c) => c.url.includes("alert.test")));
  } finally {
    m.restore();
  }
});

test("scheduled: watchdogはR2が404ならALERT_WEBHOOK_URLへPOSTする", async () => {
  const m = installFetchMock((url) => {
    if (url.includes(R2_HOST)) return new Response("", { status: 404 });
    return new Response("", { status: 200 });
  });
  try {
    await run("0 2 * * *");
    assert.ok(
      m.calls.some((c) => c.url === "https://alert.test/webhook" && c.method === "POST"),
    );
  } finally {
    m.restore();
  }
});

test("scheduled: 未知のcronはthrowせずfetchも呼ばない", async () => {
  const m = installFetchMock(() => {
    throw new Error("未知cronでfetchが呼ばれた");
  });
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    await assert.doesNotReject(() => run("* * * * *"));
    assert.equal(m.calls.length, 0);
    assert.ok(errors.some((e) => e.includes("未知のcron")));
  } finally {
    console.error = originalError;
    m.restore();
  }
});

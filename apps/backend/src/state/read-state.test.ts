import assert from "node:assert/strict";
import { test } from "node:test";
import type { R2Config } from "../publish/r2-client.js";
import {
  computeGuidHash,
  filterNewArticles,
  loadReadState,
  markAsRead,
  pruneReadState,
  saveReadState,
  type ReadState,
} from "./read-state.js";

const R2: R2Config = {
  accountId: "acc",
  accessKeyId: "AKIA_TEST",
  secretAccessKey: "secret_test",
  bucketName: "bucket",
};

function mockFetch(handler: (req: Request) => Response | Promise<Response>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    return handler(req);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("computeGuidHash: 同じfeedName+guidは同じハッシュ、異なれば異なるハッシュになる", () => {
  const a = computeGuidHash("FeedA", "guid-1");
  const b = computeGuidHash("FeedA", "guid-1");
  const c = computeGuidHash("FeedB", "guid-1"); // 同じguidでもフィードが違えば別扱い(フィード間衝突回避)
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("filterNewArticles: 既読状態にないものだけを新着として返す", () => {
  const state: ReadState = {
    [computeGuidHash("FeedA", "guid-1")]: "2026-08-01T00:00:00.000Z",
  };
  const articles = [
    { feedName: "FeedA", guid: "guid-1" },
    { feedName: "FeedA", guid: "guid-2" },
  ];

  const result = filterNewArticles(articles, state);

  assert.equal(result.length, 1);
  assert.equal(result[0]!.guid, "guid-2");
});

test("markAsRead: 既存stateを変更せず、新着記事を追加した新しいstateを返す", () => {
  const state: ReadState = {};
  const articles = [{ feedName: "FeedA", guid: "guid-1" }];
  const now = new Date("2026-08-02T00:00:00.000Z");

  const updated = markAsRead(state, articles, now);

  assert.deepEqual(state, {}, "元のstateは変更されない");
  assert.equal(updated[computeGuidHash("FeedA", "guid-1")], "2026-08-02T00:00:00.000Z");
});

test("pruneReadState: 14日以上前のエントリは削除され、それ以内は残る(境界値)", () => {
  const now = new Date("2026-08-15T00:00:00.000Z");
  const exactly14DaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const justOver14DaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000 - 1).toISOString();
  const recentlyRead = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();

  const state: ReadState = {
    exact: exactly14DaysAgo,
    over: justOver14DaysAgo,
    recent: recentlyRead,
  };

  const pruned = pruneReadState(state, now);

  assert.ok("exact" in pruned, "ちょうど14日前は境界として残す");
  assert.ok(!("over" in pruned), "14日を過ぎたものはプルーニングされる");
  assert.ok("recent" in pruned);
});

test("pruneReadState: 不正な日時文字列のエントリは安全に除去される", () => {
  const now = new Date();
  const state: ReadState = { broken: "not-a-date" };

  const pruned = pruneReadState(state, now);

  assert.deepEqual(pruned, {});
});

test("loadReadState: R2にオブジェクトが無ければ空stateを返す", async () => {
  const restore = mockFetch(() => new Response("", { status: 404 }));
  try {
    assert.deepEqual(await loadReadState(R2), {});
  } finally {
    restore();
  }
});

test("loadReadState: 保存済みJSONをReadStateとして返す", async () => {
  const stored = { [computeGuidHash("FeedA", "guid-1")]: "2026-09-01T00:00:00.000Z" };
  const restore = mockFetch(() => new Response(JSON.stringify(stored), { status: 200 }));
  try {
    assert.deepEqual(await loadReadState(R2), stored);
  } finally {
    restore();
  }
});

test("loadReadState: 配列など不正な形式はthrowする", async () => {
  const restore = mockFetch(() => new Response("[1,2,3]", { status: 200 }));
  try {
    await assert.rejects(() => loadReadState(R2));
  } finally {
    restore();
  }
});

test("saveReadState: state/read-guids.json へ整形済みJSONをPUTする", async () => {
  let captured: Request | undefined;
  const restore = mockFetch(async (req) => {
    captured = req;
    return new Response("", { status: 200 });
  });
  try {
    const state: ReadState = { abc: "2026-09-01T00:00:00.000Z" };
    await saveReadState(R2, state);
    assert.ok(captured);
    assert.equal(captured.method, "PUT");
    assert.match(captured.url, /\/bucket\/state\/read-guids\.json$/);
    assert.deepEqual(JSON.parse(await captured.text()), state);
  } finally {
    restore();
  }
});

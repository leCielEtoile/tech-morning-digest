import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeGuidHash,
  filterNewArticles,
  markAsRead,
  pruneReadState,
  type ReadState,
} from "./read-state.js";

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

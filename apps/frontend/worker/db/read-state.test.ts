import assert from "node:assert/strict";
import { test } from "node:test";
import { getReadArticleHashes, markArticleRead } from "./read-state.js";

function fakeDb(hashes: string[]): {
  db: D1Database;
  calls: { method: string; sql: string; params: unknown[] }[];
} {
  const calls: { method: string; sql: string; params: unknown[] }[] = [];
  const rawRows = hashes.map((hash) => [hash]);
  const db = {
    prepare(sql: string) {
      let params: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          params = args;
          return stmt;
        },
        async raw<T>() {
          calls.push({ method: "raw", sql, params });
          return rawRows as unknown as T[];
        },
        async run() {
          calls.push({ method: "run", sql, params });
          return { success: true } as unknown as D1Result;
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, calls };
}

test("getReadArticleHashes: 既読hashの配列を返す", async () => {
  const { db } = fakeDb(["hash-1", "hash-2"]);
  const hashes = await getReadArticleHashes(db, "user-1");
  assert.deepEqual(hashes, ["hash-1", "hash-2"]);
});

test("markArticleRead: user_idとarticleGuidHashを渡して登録する(冪等)", async () => {
  const { db, calls } = fakeDb([]);
  await markArticleRead(db, "user-1", "hash-1");
  const insertCall = calls.find((c) => c.method === "run" && c.params.includes("user-1") && c.params.includes("hash-1"));
  assert.ok(insertCall, "userIdとarticleGuidHashを含むINSERT呼び出しが記録されていること");
  // onConflictDoNothing()が実際にSQLへ反映されていること(冪等性の担保)を、
  // 完全一致ではなく機能の存在(conflictという語の有無)で確認する。
  assert.match(insertCall?.sql ?? "", /conflict/i);
});

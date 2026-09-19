import assert from "node:assert/strict";
import { test } from "node:test";
import { findOrCreateUserByGoogleSub } from "./users.js";

const USER_COLUMNS = ["id", "google_sub", "created_at"];

/**
 * Drizzleの単純なselect()は`.raw()`(位置ベースの配列を返すD1の生API)経由で実行される。
 * `selectCallCount`で1回目(find)と2回目(UNIQUE制約違反後の再取得)を切り替える。
 */
function fakeDb(
  options: {
    existingRow?: Record<string, unknown> | null;
    insertShouldFail?: boolean;
    rowAfterFailedInsert?: Record<string, unknown> | null;
  } = {},
): {
  db: D1Database;
  calls: { method: string; sql: string; params: unknown[] }[];
} {
  const calls: { method: string; sql: string; params: unknown[] }[] = [];
  let selectCallCount = 0;
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
          selectCallCount += 1;
          const row = selectCallCount === 1 ? (options.existingRow ?? null) : (options.rowAfterFailedInsert ?? null);
          return (row ? [USER_COLUMNS.map((c) => row[c])] : []) as unknown as T[];
        },
        async run() {
          calls.push({ method: "run", sql, params });
          if (options.insertShouldFail) {
            throw new Error("UNIQUE constraint failed: users.google_sub");
          }
          return { success: true } as unknown as D1Result;
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, calls };
}

test("findOrCreateUserByGoogleSub: 既存ユーザーがいればそのまま返す(INSERTしない)", async () => {
  const { db, calls } = fakeDb({ existingRow: { id: "user-1", google_sub: "google-sub-1" } });

  const user = await findOrCreateUserByGoogleSub(db, "google-sub-1");

  assert.deepEqual(user, { id: "user-1", googleSub: "google-sub-1" });
  assert.equal(calls.filter((c) => c.method === "run").length, 0);
});

test("findOrCreateUserByGoogleSub: 存在しなければ新規作成してから返す", async () => {
  const { db, calls } = fakeDb();

  const user = await findOrCreateUserByGoogleSub(db, "google-sub-2");

  assert.equal(user.googleSub, "google-sub-2");
  assert.ok(user.id.length > 0);
  const insertCall = calls.find((c) => c.method === "run" && c.params.includes(user.id) && c.params.includes("google-sub-2"));
  assert.ok(insertCall, "生成したidとgoogleSubを含むINSERT呼び出しが記録されていること");
});

test("findOrCreateUserByGoogleSub: INSERT時にUNIQUE制約違反が起きたら再取得して返す(同時コールバックのレース対策)", async () => {
  const { db } = fakeDb({
    insertShouldFail: true,
    rowAfterFailedInsert: { id: "user-3", google_sub: "google-sub-3" },
  });

  const user = await findOrCreateUserByGoogleSub(db, "google-sub-3");

  assert.deepEqual(user, { id: "user-3", googleSub: "google-sub-3" });
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { findOrCreateUserByGoogleSub } from "./users.js";

function fakeDb(options: {
  existingRow?: Record<string, unknown> | null;
  insertShouldFail?: boolean;
  rowAfterFailedInsert?: Record<string, unknown> | null;
} = {}): {
  db: D1Database;
  calls: { sql: string; params: unknown[] }[];
} {
  const calls: { sql: string; params: unknown[] }[] = [];
  let selectCallCount = 0;
  const db = {
    prepare(sql: string) {
      let params: unknown[] = [];
      return {
        bind(...args: unknown[]) {
          params = args;
          return this;
        },
        async first<T>() {
          calls.push({ sql, params });
          selectCallCount += 1;
          if (selectCallCount === 1) return (options.existingRow ?? null) as T | null;
          return (options.rowAfterFailedInsert ?? null) as T | null;
        },
        async run() {
          calls.push({ sql, params });
          if (options.insertShouldFail) {
            throw new Error("UNIQUE constraint failed: users.google_sub");
          }
          return { success: true } as unknown as D1Result;
        },
      };
    },
  } as unknown as D1Database;
  return { db, calls };
}

test("findOrCreateUserByGoogleSub: 既存ユーザーがいればそのまま返す(INSERTしない)", async () => {
  const { db, calls } = fakeDb({ existingRow: { id: "user-1", google_sub: "google-sub-1" } });

  const user = await findOrCreateUserByGoogleSub(db, "google-sub-1");

  assert.deepEqual(user, { id: "user-1", googleSub: "google-sub-1" });
  assert.equal(calls.filter((c) => /INSERT/.test(c.sql)).length, 0);
});

test("findOrCreateUserByGoogleSub: 存在しなければ新規作成してから返す", async () => {
  const { db, calls } = fakeDb();

  const user = await findOrCreateUserByGoogleSub(db, "google-sub-2");

  assert.equal(user.googleSub, "google-sub-2");
  assert.ok(user.id.length > 0);
  const insertCall = calls.find((c) => /INSERT INTO users/.test(c.sql));
  assert.ok(insertCall);
  assert.deepEqual(insertCall?.params, [user.id, "google-sub-2", insertCall?.params[2]]);
});

test("findOrCreateUserByGoogleSub: INSERT時にUNIQUE制約違反が起きたら再取得して返す(同時コールバックのレース対策)", async () => {
  const { db } = fakeDb({
    insertShouldFail: true,
    rowAfterFailedInsert: { id: "user-3", google_sub: "google-sub-3" },
  });

  const user = await findOrCreateUserByGoogleSub(db, "google-sub-3");

  assert.deepEqual(user, { id: "user-3", googleSub: "google-sub-3" });
});

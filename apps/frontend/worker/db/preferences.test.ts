import assert from "node:assert/strict";
import { test } from "node:test";
import { getCategoryPrefs, setCategoryPrefs } from "./preferences.js";

function fakeDb(rows: Record<string, unknown>[]): { db: D1Database; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      let params: unknown[] = [];
      return {
        bind(...args: unknown[]) {
          params = args;
          return this;
        },
        async all<T>() {
          calls.push({ sql, params });
          return { results: rows as T[] };
        },
        async run() {
          calls.push({ sql, params });
          return { success: true } as unknown as D1Result;
        },
      };
    },
    async batch(statements: unknown[]) {
      calls.push({ sql: "BATCH", params: [statements.length] });
      return [];
    },
  } as unknown as D1Database;
  return { db, calls };
}

test("getCategoryPrefs: 保存済みの設定を返す", async () => {
  const { db } = fakeDb([{ category: "開発・プログラミング", enabled: 1 }]);
  const prefs = await getCategoryPrefs(db, "user-1");
  assert.deepEqual(prefs, [{ category: "開発・プログラミング", enabled: true }]);
});

test("setCategoryPrefs: 既存設定を削除してから一括登録する(batch使用)", async () => {
  const { db, calls } = fakeDb([]);
  await setCategoryPrefs(db, "user-1", [{ category: "クラウド・インフラ", enabled: true }]);

  assert.ok(calls.some((c) => /DELETE FROM user_category_prefs/.test(c.sql)));
  assert.ok(calls.some((c) => c.sql === "BATCH"));
});

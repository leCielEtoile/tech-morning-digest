import assert from "node:assert/strict";
import { test } from "node:test";
import { getCategoryPrefs, setCategoryPrefs } from "./preferences.js";

const PREF_COLUMNS = ["user_id", "category", "enabled"];

function fakeDb(rows: Record<string, unknown>[]): {
  db: D1Database;
  calls: { method: string; sql: string; params: unknown[] }[];
} {
  const calls: { method: string; sql: string; params: unknown[] }[] = [];
  const rawRows = rows.map((row) => PREF_COLUMNS.map((col) => row[col]));
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
    async batch(statements: unknown[]) {
      calls.push({ method: "batch", sql: "BATCH", params: [statements.length] });
      return statements.map(() => ({ success: true }) as unknown as D1Result);
    },
  } as unknown as D1Database;
  return { db, calls };
}

test("getCategoryPrefs: 保存済みの設定を返す", async () => {
  const { db } = fakeDb([{ user_id: "user-1", category: "開発・プログラミング", enabled: 1 }]);
  const prefs = await getCategoryPrefs(db, "user-1");
  assert.deepEqual(prefs, [{ category: "開発・プログラミング", enabled: true }]);
});

test("setCategoryPrefs: 既存設定を削除してから一括登録する(batch使用)", async () => {
  const { db, calls } = fakeDb([]);
  await setCategoryPrefs(db, "user-1", [{ category: "クラウド・インフラ", enabled: true }]);

  assert.ok(calls.some((c) => c.method === "batch"));
});

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
  function makeStatement(sql: string) {
    let params: unknown[] = [];
    const stmt = {
      sql,
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
  }
  const db = {
    prepare(sql: string) {
      return makeStatement(sql);
    },
    // orm.batch()はDrizzle内部で各クエリをprepare()した上でclient.batch()に渡すため、
    // ここに届く時点でstatementはすでにprepare(sql).bind(...)を経由済み(sqlプロパティを
    // 持つ)。これを使い、「batchが呼ばれたか」だけでなく「中身にDELETEとINSERTの両方が
    // 含まれるか」を検証できるようにする。
    async batch(statements: { sql: string }[]) {
      for (const statement of statements) {
        calls.push({ method: "batch-item", sql: statement.sql, params: [] });
      }
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

test("setCategoryPrefs: 既存設定を削除してから一括登録する(batch使用、DELETE→INSERTの順)", async () => {
  const { db, calls } = fakeDb([]);
  await setCategoryPrefs(db, "user-1", [{ category: "クラウド・インフラ", enabled: true }]);

  const batchItems = calls.filter((c) => c.method === "batch-item");
  assert.equal(batchItems.length, 2, "DELETEとINSERTの2文がbatchに渡されていること");
  assert.match(batchItems[0]?.sql ?? "", /delete/i);
  assert.match(batchItems[1]?.sql ?? "", /insert/i);
});

test("setCategoryPrefs: 空配列の場合はDELETEのみ実行しINSERT(batch)は呼ばない", async () => {
  const { db, calls } = fakeDb([]);
  await setCategoryPrefs(db, "user-1", []);

  assert.equal(calls.filter((c) => c.method === "batch-item").length, 0);
  const deleteCall = calls.find((c) => c.method === "run" && /delete/i.test(c.sql));
  assert.ok(deleteCall, "空配列でも既存設定のDELETEは実行されること");
});

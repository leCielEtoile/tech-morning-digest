import assert from "node:assert/strict";
import { test } from "node:test";
import { handleGetPreferences, handlePutPreferences } from "./preferences-handlers.js";

const PREF_COLUMNS = ["user_id", "category", "enabled"];

/**
 * Drizzleは単純なselect()を、D1の.raw()(位置ベース配列を返す生API)経由で実行する。
 * SQL文言で対象テーブル("sessions"か"user_category_prefs"か)を判定して、対応する
 * 結果を位置配列で返す。
 */
function fakeDb(
  options: {
    session?: { id: string; user_id: string; expires_at: string };
    prefRows?: Record<string, unknown>[];
  } = {},
): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async raw() {
          if (/from "sessions"/i.test(sql)) {
            return options.session ? [[options.session.id, options.session.user_id, options.session.expires_at]] : [];
          }
          if (/from "user_category_prefs"/i.test(sql)) {
            return (options.prefRows ?? []).map((row) => PREF_COLUMNS.map((col) => row[col]));
          }
          return [];
        },
        async run() {
          return { success: true } as unknown as D1Result;
        },
      };
    },
    async batch(statements: unknown[]) {
      return statements.map(() => ({ success: true }) as unknown as D1Result);
    },
  } as unknown as D1Database;
}

test("handleGetPreferences: 未ログイン(Cookieなし)は401", async () => {
  const request = new Request("http://localhost/api/preferences");
  const response = await handleGetPreferences(request, fakeDb());
  assert.equal(response.status, 401);
});

test("handleGetPreferences: ログイン済みは保存済み設定を200で返す", async () => {
  const future = new Date(Date.now() + 10_000).toISOString();
  const db = fakeDb({
    session: { id: "sess-1", user_id: "user-1", expires_at: future },
    prefRows: [{ user_id: "user-1", category: "開発・プログラミング", enabled: 1 }],
  });
  const request = new Request("http://localhost/api/preferences", { headers: { Cookie: "session_id=sess-1" } });
  const response = await handleGetPreferences(request, db);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { prefs: { category: string; enabled: boolean }[] };
  assert.deepEqual(body.prefs, [{ category: "開発・プログラミング", enabled: true }]);
});

test("handlePutPreferences: 未ログイン(Cookieなし)は401", async () => {
  const request = new Request("http://localhost/api/preferences", {
    method: "PUT",
    body: JSON.stringify([{ category: "開発・プログラミング", enabled: true }]),
  });
  const response = await handlePutPreferences(request, fakeDb());
  assert.equal(response.status, 401);
});

test("handlePutPreferences: ログイン済みで不正なbody(配列でない)は400", async () => {
  const future = new Date(Date.now() + 10_000).toISOString();
  const db = fakeDb({ session: { id: "sess-1", user_id: "user-1", expires_at: future } });
  const request = new Request("http://localhost/api/preferences", {
    method: "PUT",
    headers: { Cookie: "session_id=sess-1", "content-type": "application/json" },
    body: JSON.stringify({ not: "an array" }),
  });
  const response = await handlePutPreferences(request, db);
  assert.equal(response.status, 400);
});

test("handlePutPreferences: ホワイトリスト外のcategoryは400", async () => {
  const future = new Date(Date.now() + 10_000).toISOString();
  const db = fakeDb({ session: { id: "sess-1", user_id: "user-1", expires_at: future } });
  const request = new Request("http://localhost/api/preferences", {
    method: "PUT",
    headers: { Cookie: "session_id=sess-1", "content-type": "application/json" },
    body: JSON.stringify([{ category: "存在しないカテゴリ", enabled: true }]),
  });
  const response = await handlePutPreferences(request, db);
  assert.equal(response.status, 400);
});

test("handlePutPreferences: ログイン済み・有効なbodyは200", async () => {
  const future = new Date(Date.now() + 10_000).toISOString();
  const db = fakeDb({ session: { id: "sess-1", user_id: "user-1", expires_at: future } });
  const request = new Request("http://localhost/api/preferences", {
    method: "PUT",
    headers: { Cookie: "session_id=sess-1", "content-type": "application/json" },
    body: JSON.stringify([{ category: "開発・プログラミング", enabled: true }]),
  });
  const response = await handlePutPreferences(request, db);
  assert.equal(response.status, 200);
});

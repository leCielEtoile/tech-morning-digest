import assert from "node:assert/strict";
import { test } from "node:test";
import { createSession, deleteSession, getSession } from "./sessions.js";

/**
 * D1のprepare().bind()チェーンを最小限だけ模したフェイク。Drizzleは単純なselect()を
 * `.raw()`(列を位置ベースの配列で返すD1の生API)経由で実行するため、`rows`を
 * `columns`の順で位置配列に変換したものを`.raw()`の戻り値として用意する。
 * `.first()`/`.all()`/`.run()`もDrizzleの他のクエリ形態(insert/delete等)向けに実装する。
 * 生成されるSQL文言はDrizzle固有のものになるため、アサーションはbindされた
 * パラメータ値と戻り値ベースで行う(SQL文字列は見ない)。
 */
function fakeDb(
  rows: Record<string, unknown>[],
  columns: string[],
): {
  db: D1Database;
  calls: { method: string; sql: string; params: unknown[] }[];
} {
  const calls: { method: string; sql: string; params: unknown[] }[] = [];
  const rawRows = rows.map((row) => columns.map((col) => row[col]));
  const db = {
    prepare(sql: string) {
      let params: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          params = args;
          return stmt;
        },
        async first<T>() {
          calls.push({ method: "first", sql, params });
          return (rows[0] ?? null) as T | null;
        },
        async all<T>() {
          calls.push({ method: "all", sql, params });
          return { results: rows } as unknown as { results: T[] };
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

const SESSION_COLUMNS = ["id", "user_id", "expires_at"];

test("createSession: INSERTを実行しSessionを返す", async () => {
  const { db, calls } = fakeDb([], SESSION_COLUMNS);
  const session = await createSession(db, "user-1");

  assert.equal(session.userId, "user-1");
  assert.ok(session.id.length > 0);
  assert.ok(new Date(session.expiresAt).getTime() > Date.now());
  const insertCall = calls.find((c) => c.method === "run" && c.params.includes(session.id) && c.params.includes("user-1"));
  assert.ok(insertCall, "セッションIDとuserIdを含むINSERT呼び出しが記録されていること");
});

test("getSession: 有効なセッションを返す", async () => {
  const future = new Date(Date.now() + 10_000).toISOString();
  const { db } = fakeDb([{ id: "sess-1", user_id: "user-1", expires_at: future }], SESSION_COLUMNS);

  const session = await getSession(db, "sess-1");

  assert.deepEqual(session, { id: "sess-1", userId: "user-1", expiresAt: future });
});

test("getSession: 期限切れセッションはnullを返す", async () => {
  const past = new Date(Date.now() - 10_000).toISOString();
  const { db } = fakeDb([{ id: "sess-1", user_id: "user-1", expires_at: past }], SESSION_COLUMNS);

  assert.equal(await getSession(db, "sess-1"), null);
});

test("getSession: 存在しないセッションはnullを返す", async () => {
  const { db } = fakeDb([], SESSION_COLUMNS);
  assert.equal(await getSession(db, "missing"), null);
});

test("deleteSession: DELETEを実行する", async () => {
  const { db, calls } = fakeDb([], SESSION_COLUMNS);
  await deleteSession(db, "sess-1");

  const deleteCall = calls.find((c) => c.method === "run" && c.params.includes("sess-1"));
  assert.ok(deleteCall, "sessionIdを含むDELETE呼び出しが記録されていること");
});

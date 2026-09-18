import assert from "node:assert/strict";
import { test } from "node:test";
import { createSession, deleteSession, getSession } from "./sessions.js";

/** D1のprepare().bind().first()/.run()チェーンを最小限だけ模したフェイク */
function fakeDb(rows: Record<string, unknown>[]): {
  db: D1Database;
  calls: { sql: string; params: unknown[] }[];
} {
  const calls: { sql: string; params: unknown[] }[] = [];
  let rowIndex = 0;
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
          const row = rows[rowIndex];
          rowIndex += 1;
          return (row ?? null) as T | null;
        },
        async run() {
          calls.push({ sql, params });
          return { success: true } as unknown as D1Result;
        },
      };
    },
  } as unknown as D1Database;
  return { db, calls };
}

test("createSession: INSERTを実行しSessionを返す", async () => {
  const { db, calls } = fakeDb([]);
  const session = await createSession(db, "user-1");

  assert.equal(session.userId, "user-1");
  assert.ok(session.id.length > 0);
  assert.ok(new Date(session.expiresAt).getTime() > Date.now());
  assert.match(calls[0]?.sql ?? "", /INSERT INTO sessions/);
  assert.deepEqual(calls[0]?.params, [session.id, "user-1", session.expiresAt]);
});

test("getSession: 有効なセッションを返す", async () => {
  const future = new Date(Date.now() + 10_000).toISOString();
  const { db } = fakeDb([{ id: "sess-1", user_id: "user-1", expires_at: future }]);

  const session = await getSession(db, "sess-1");

  assert.deepEqual(session, { id: "sess-1", userId: "user-1", expiresAt: future });
});

test("getSession: 期限切れセッションはnullを返す", async () => {
  const past = new Date(Date.now() - 10_000).toISOString();
  const { db } = fakeDb([{ id: "sess-1", user_id: "user-1", expires_at: past }]);

  assert.equal(await getSession(db, "sess-1"), null);
});

test("getSession: 存在しないセッションはnullを返す", async () => {
  const { db } = fakeDb([]);
  assert.equal(await getSession(db, "missing"), null);
});

test("deleteSession: DELETEを実行する", async () => {
  const { db, calls } = fakeDb([]);
  await deleteSession(db, "sess-1");

  assert.match(calls[0]?.sql ?? "", /DELETE FROM sessions/);
  assert.deepEqual(calls[0]?.params, ["sess-1"]);
});

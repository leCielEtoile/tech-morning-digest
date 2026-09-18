import assert from "node:assert/strict";
import { test } from "node:test";
import { getReadArticleHashes, markArticleRead } from "./read-state.js";

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
  } as unknown as D1Database;
  return { db, calls };
}

test("getReadArticleHashes: 既読hashの配列を返す", async () => {
  const { db } = fakeDb([{ article_guid_hash: "hash-1" }, { article_guid_hash: "hash-2" }]);
  const hashes = await getReadArticleHashes(db, "user-1");
  assert.deepEqual(hashes, ["hash-1", "hash-2"]);
});

test("markArticleRead: INSERT OR IGNOREで冪等に登録する", async () => {
  const { db, calls } = fakeDb([]);
  await markArticleRead(db, "user-1", "hash-1");
  assert.match(calls[0]?.sql ?? "", /INSERT OR IGNORE INTO user_read_state/);
  assert.deepEqual(calls[0]?.params.slice(0, 2), ["user-1", "hash-1"]);
});

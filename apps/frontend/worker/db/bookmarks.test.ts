import assert from "node:assert/strict";
import { test } from "node:test";
import { addBookmark, BookmarkLimitReachedError, deleteBookmark, listBookmarks } from "./bookmarks.js";

function fakeDb(options: { rows?: Record<string, unknown>[]; bookmarkCount?: number } = {}): {
  db: D1Database;
  calls: { sql: string; params: unknown[] }[];
} {
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
          return { results: (options.rows ?? []) as T[] };
        },
        async first<T>() {
          calls.push({ sql, params });
          return { count: options.bookmarkCount ?? 0 } as T;
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

test("listBookmarks: 保存日時の降順で返す(SQLにORDER BYを含む)", async () => {
  const { db, calls } = fakeDb({
    rows: [{ id: "b1", article_link: "https://example.com/a", article_title: "A", saved_at: "2026-09-17T00:00:00.000Z" }],
  });
  const bookmarks = await listBookmarks(db, "user-1");

  assert.deepEqual(bookmarks, [
    { id: "b1", articleLink: "https://example.com/a", articleTitle: "A", savedAt: "2026-09-17T00:00:00.000Z" },
  ]);
  assert.match(calls[0]?.sql ?? "", /ORDER BY saved_at DESC/);
});

test("addBookmark: INSERTしてBookmarkを返す", async () => {
  const { db } = fakeDb();
  const bookmark = await addBookmark(db, "user-1", "https://example.com/a", "記事A");
  assert.equal(bookmark.articleLink, "https://example.com/a");
  assert.equal(bookmark.articleTitle, "記事A");
  assert.ok(bookmark.id.length > 0);
});

test("addBookmark: 上限(10件)に達していればBookmarkLimitReachedErrorを投げる", async () => {
  const { db } = fakeDb({ bookmarkCount: 10 });
  await assert.rejects(() => addBookmark(db, "user-1", "https://example.com/a", "A"), BookmarkLimitReachedError);
});

test("deleteBookmark: user_idとidの両方をWHERE条件にする(他人のブックマークを消せないように)", async () => {
  const { db, calls } = fakeDb();
  await deleteBookmark(db, "user-1", "b1");
  assert.match(calls[0]?.sql ?? "", /WHERE id = \? AND user_id = \?/);
  assert.deepEqual(calls[0]?.params, ["b1", "user-1"]);
});

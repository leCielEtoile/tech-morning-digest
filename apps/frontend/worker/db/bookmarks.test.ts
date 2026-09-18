import assert from "node:assert/strict";
import { test } from "node:test";
import { addBookmark, BookmarkLimitReachedError, deleteBookmark, listBookmarks } from "./bookmarks.js";

const BOOKMARK_COLUMNS = ["id", "user_id", "article_link", "article_title", "saved_at"];

/**
 * Drizzleの単純なselect()・count()集計select()はいずれもD1の.raw()(位置ベース配列)を
 * 経由する。SQL文言に"count("が含まれるかどうかで、集計クエリか一覧クエリかを判定する。
 */
function fakeDb(options: { rows?: Record<string, unknown>[]; bookmarkCount?: number } = {}): {
  db: D1Database;
  calls: { method: string; sql: string; params: unknown[] }[];
} {
  const calls: { method: string; sql: string; params: unknown[] }[] = [];
  const rawRows = (options.rows ?? []).map((row) => BOOKMARK_COLUMNS.map((col) => row[col]));
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
          if (/count\(/i.test(sql)) {
            return [[options.bookmarkCount ?? 0]] as unknown as T[];
          }
          // fixtureはsaved_at昇順で渡す想定。生成SQLに"desc"が含まれていれば(orderBy(desc(...))が
          // 効いている証拠として)反転して返す。これによりlistBookmarksが実際に降順を要求している
          // ことをテストで検証できる(SQL文言の完全一致は見ない)。
          const isDescending = /desc/i.test(sql);
          return (isDescending ? [...rawRows].reverse() : rawRows) as unknown as T[];
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

test("listBookmarks: 保存日時の降順で返す(クエリがdesc指定を要求していること)", async () => {
  // fixtureはsaved_at昇順(b1が古い→b2が新しい)で渡す。listBookmarksがorderBy(desc(...))を
  // 実際に要求していれば、fakeDbのraw()がdesc検出で反転し、戻り値はb2, b1の順になる。
  const { db } = fakeDb({
    rows: [
      { id: "b1", user_id: "user-1", article_link: "https://example.com/a", article_title: "A", saved_at: "2026-09-16T00:00:00.000Z" },
      { id: "b2", user_id: "user-1", article_link: "https://example.com/b", article_title: "B", saved_at: "2026-09-17T00:00:00.000Z" },
    ],
  });
  const result = await listBookmarks(db, "user-1");

  assert.deepEqual(result, [
    { id: "b2", articleLink: "https://example.com/b", articleTitle: "B", savedAt: "2026-09-17T00:00:00.000Z" },
    { id: "b1", articleLink: "https://example.com/a", articleTitle: "A", savedAt: "2026-09-16T00:00:00.000Z" },
  ]);
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

test("deleteBookmark: user_idとidの両方を条件にする(他人のブックマークを消せないように)", async () => {
  const { db, calls } = fakeDb();
  await deleteBookmark(db, "user-1", "b1");
  const deleteCall = calls.find((c) => c.method === "run" && c.params.includes("b1") && c.params.includes("user-1"));
  assert.ok(deleteCall, "bookmarkIdとuserIdを含むDELETE呼び出しが記録されていること");
});

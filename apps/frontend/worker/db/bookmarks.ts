import { drizzle } from "drizzle-orm/d1";
import { and, count, desc, eq } from "drizzle-orm";
import { bookmarks } from "./schema.js";

export interface Bookmark {
  id: string;
  articleLink: string;
  articleTitle: string;
  savedAt: string;
}

/**
 * 無料プランの上限。有料プラン(roadmap: 300件想定)はsubscriptionsテーブルが
 * 存在する別計画側で、プラン別の値に差し替える分岐を追加すること。
 */
export const MAX_BOOKMARKS_PER_USER = 10;

export class BookmarkLimitReachedError extends Error {
  constructor() {
    super(`ブックマークは${MAX_BOOKMARKS_PER_USER}件までです`);
  }
}

export async function listBookmarks(db: D1Database, userId: string): Promise<Bookmark[]> {
  const orm = drizzle(db);
  const rows = await orm
    .select()
    .from(bookmarks)
    .where(eq(bookmarks.userId, userId))
    .orderBy(desc(bookmarks.savedAt));
  return rows.map((row) => ({
    id: row.id,
    articleLink: row.articleLink,
    articleTitle: row.articleTitle,
    savedAt: row.savedAt,
  }));
}

export async function addBookmark(
  db: D1Database,
  userId: string,
  articleLink: string,
  articleTitle: string,
): Promise<Bookmark> {
  const orm = drizzle(db);
  const [countRow] = await orm.select({ value: count() }).from(bookmarks).where(eq(bookmarks.userId, userId));
  const currentCount = countRow?.value ?? 0;
  if (currentCount >= MAX_BOOKMARKS_PER_USER) {
    throw new BookmarkLimitReachedError();
  }

  const bookmark: Bookmark = {
    id: crypto.randomUUID(),
    articleLink,
    articleTitle,
    savedAt: new Date().toISOString(),
  };
  await orm.insert(bookmarks).values({
    id: bookmark.id,
    userId,
    articleLink: bookmark.articleLink,
    articleTitle: bookmark.articleTitle,
    savedAt: bookmark.savedAt,
  });
  return bookmark;
}

/** user_idも条件に含めることで、他人のブックマークIDを指定しても削除できないようにする。 */
export async function deleteBookmark(db: D1Database, userId: string, bookmarkId: string): Promise<void> {
  const orm = drizzle(db);
  await orm.delete(bookmarks).where(and(eq(bookmarks.id, bookmarkId), eq(bookmarks.userId, userId)));
}

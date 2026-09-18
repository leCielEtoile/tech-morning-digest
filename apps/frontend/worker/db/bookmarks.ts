export interface Bookmark {
  id: string;
  articleLink: string;
  articleTitle: string;
  savedAt: string;
}

interface BookmarkRow {
  id: string;
  article_link: string;
  article_title: string;
  saved_at: string;
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

function toBookmark(row: BookmarkRow): Bookmark {
  return { id: row.id, articleLink: row.article_link, articleTitle: row.article_title, savedAt: row.saved_at };
}

export async function listBookmarks(db: D1Database, userId: string): Promise<Bookmark[]> {
  const { results } = await db
    .prepare("SELECT id, article_link, article_title, saved_at FROM bookmarks WHERE user_id = ? ORDER BY saved_at DESC")
    .bind(userId)
    .all<BookmarkRow>();
  return results.map(toBookmark);
}

export async function addBookmark(
  db: D1Database,
  userId: string,
  articleLink: string,
  articleTitle: string,
): Promise<Bookmark> {
  const { count } = (await db
    .prepare("SELECT COUNT(*) as count FROM bookmarks WHERE user_id = ?")
    .bind(userId)
    .first<{ count: number }>()) ?? { count: 0 };
  if (count >= MAX_BOOKMARKS_PER_USER) {
    throw new BookmarkLimitReachedError();
  }

  const bookmark: Bookmark = {
    id: crypto.randomUUID(),
    articleLink,
    articleTitle,
    savedAt: new Date().toISOString(),
  };
  await db
    .prepare("INSERT INTO bookmarks (id, user_id, article_link, article_title, saved_at) VALUES (?, ?, ?, ?, ?)")
    .bind(bookmark.id, userId, bookmark.articleLink, bookmark.articleTitle, bookmark.savedAt)
    .run();
  return bookmark;
}

/** user_idも条件に含めることで、他人のブックマークIDを指定しても削除できないようにする。 */
export async function deleteBookmark(db: D1Database, userId: string, bookmarkId: string): Promise<void> {
  await db.prepare("DELETE FROM bookmarks WHERE id = ? AND user_id = ?").bind(bookmarkId, userId).run();
}

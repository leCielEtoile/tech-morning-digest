import { requireSession } from "./router.js";
import { readJsonBody } from "./parse-json.js";
import { addBookmark, BookmarkLimitReachedError, deleteBookmark, listBookmarks } from "../db/bookmarks.js";

// URL・タイトルの長さ上限。D1行の無制限な肥大化を防ぐための実用値(厳密な仕様値ではない)。
const MAX_ARTICLE_LINK_LENGTH = 2048;
const MAX_ARTICLE_TITLE_LENGTH = 500;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isAddBookmarkBody(value: unknown): value is { articleLink: string; articleTitle: string } {
  if (typeof value !== "object" || value === null) return false;
  const articleLink = (value as Record<string, unknown>)["articleLink"];
  const articleTitle = (value as Record<string, unknown>)["articleTitle"];
  return (
    typeof articleLink === "string" &&
    typeof articleTitle === "string" &&
    articleLink.length <= MAX_ARTICLE_LINK_LENGTH &&
    articleTitle.length <= MAX_ARTICLE_TITLE_LENGTH &&
    isHttpUrl(articleLink)
  );
}

export async function handleListBookmarks(request: Request, db: D1Database): Promise<Response> {
  const session = await requireSession(request, db);
  if (!session) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  const bookmarks = await listBookmarks(db, session.userId);
  return new Response(JSON.stringify({ bookmarks }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export async function handleAddBookmark(request: Request, db: D1Database): Promise<Response> {
  const session = await requireSession(request, db);
  if (!session) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  const body: unknown = await readJsonBody(request);
  if (!isAddBookmarkBody(body)) {
    return new Response(JSON.stringify({ error: "invalid_body" }), { status: 400 });
  }
  try {
    const bookmark = await addBookmark(db, session.userId, body.articleLink, body.articleTitle);
    return new Response(JSON.stringify({ bookmark }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    if (error instanceof BookmarkLimitReachedError) {
      return new Response(JSON.stringify({ error: "bookmark_limit_reached" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    }
    throw error;
  }
}

export async function handleDeleteBookmark(request: Request, db: D1Database, bookmarkId: string): Promise<Response> {
  const session = await requireSession(request, db);
  if (!session) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  await deleteBookmark(db, session.userId, bookmarkId);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
}

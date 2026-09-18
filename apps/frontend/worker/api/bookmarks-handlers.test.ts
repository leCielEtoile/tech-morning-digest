import assert from "node:assert/strict";
import { test } from "node:test";
import { handleAddBookmark, handleDeleteBookmark, handleListBookmarks } from "./bookmarks-handlers.js";

function fakeDb(
  options: { session?: { id: string; user_id: string; expires_at: string }; bookmarkCount?: number } = {},
): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async all() {
          return { results: [] };
        },
        async first() {
          if (/FROM sessions/.test(sql)) return options.session ?? null;
          if (/COUNT/.test(sql)) return { count: options.bookmarkCount ?? 0 };
          return null;
        },
        async run() {
          return { success: true } as unknown as D1Result;
        },
      };
    },
  } as unknown as D1Database;
}

test("handleListBookmarks: 未ログインは401", async () => {
  const response = await handleListBookmarks(new Request("http://localhost/api/bookmarks"), fakeDb());
  assert.equal(response.status, 401);
});

test("handleAddBookmark: 未ログインは401", async () => {
  const request = new Request("http://localhost/api/bookmarks", {
    method: "POST",
    body: JSON.stringify({ articleLink: "https://example.com/a", articleTitle: "A" }),
  });
  const response = await handleAddBookmark(request, fakeDb());
  assert.equal(response.status, 401);
});

test("handleAddBookmark: 上限(10件)到達時は409", async () => {
  const future = new Date(Date.now() + 10_000).toISOString();
  const db = fakeDb({ session: { id: "sess-1", user_id: "user-1", expires_at: future }, bookmarkCount: 10 });
  const request = new Request("http://localhost/api/bookmarks", {
    method: "POST",
    headers: { Cookie: "session_id=sess-1", "content-type": "application/json" },
    body: JSON.stringify({ articleLink: "https://example.com/a", articleTitle: "A" }),
  });
  const response = await handleAddBookmark(request, db);
  assert.equal(response.status, 409);
});

test("handleAddBookmark: 不正なJSONボディは400(500にならない)", async () => {
  const future = new Date(Date.now() + 10_000).toISOString();
  const db = fakeDb({ session: { id: "sess-1", user_id: "user-1", expires_at: future } });
  const request = new Request("http://localhost/api/bookmarks", {
    method: "POST",
    headers: { Cookie: "session_id=sess-1", "content-type": "application/json" },
    body: "{not valid json",
  });
  const response = await handleAddBookmark(request, db);
  assert.equal(response.status, 400);
});

test("handleAddBookmark: javascript:スキームのarticleLinkは400", async () => {
  const future = new Date(Date.now() + 10_000).toISOString();
  const db = fakeDb({ session: { id: "sess-1", user_id: "user-1", expires_at: future } });
  const request = new Request("http://localhost/api/bookmarks", {
    method: "POST",
    headers: { Cookie: "session_id=sess-1", "content-type": "application/json" },
    body: JSON.stringify({ articleLink: "javascript:alert(1)", articleTitle: "A" }),
  });
  const response = await handleAddBookmark(request, db);
  assert.equal(response.status, 400);
});

test("handleDeleteBookmark: 未ログインは401", async () => {
  const request = new Request("http://localhost/api/bookmarks/b1", { method: "DELETE" });
  const response = await handleDeleteBookmark(request, fakeDb(), "b1");
  assert.equal(response.status, 401);
});

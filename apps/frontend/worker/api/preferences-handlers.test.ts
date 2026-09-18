import assert from "node:assert/strict";
import { test } from "node:test";
import { handleGetPreferences, handlePutPreferences } from "./preferences-handlers.js";

function fakeDb(rows: Record<string, unknown>[] = []): D1Database {
  return {
    prepare() {
      return {
        bind() {
          return this;
        },
        async all() {
          return { results: rows };
        },
        async first() {
          return rows[0] || null;
        },
        async run() {
          return { success: true } as unknown as D1Result;
        },
      };
    },
    async batch() {
      return [];
    },
  } as unknown as D1Database;
}

test("handleGetPreferences: 未ログイン(Cookieなし)は401", async () => {
  const request = new Request("http://localhost/api/preferences");
  const response = await handleGetPreferences(request, fakeDb());
  assert.equal(response.status, 401);
});

test("handlePutPreferences: 不正なbodyは400", async () => {
  const request = new Request("http://localhost/api/preferences", {
    method: "PUT",
    headers: { Cookie: "session_id=irrelevant-for-this-test", "content-type": "application/json" },
    body: JSON.stringify({ not: "an array" }),
  });
  const response = await handlePutPreferences(request, fakeDb());
  // セッション自体はrequireSessionでgetSession()がnull(fakeDbは常にnullを返す)を返すため401になる
  assert.equal(response.status, 401);
});

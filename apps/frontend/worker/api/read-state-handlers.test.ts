import assert from "node:assert/strict";
import { test } from "node:test";
import { handleGetReadState, handleMarkRead } from "./read-state-handlers.js";

function fakeDb(): D1Database {
  return {
    prepare() {
      return {
        bind() {
          return this;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return { success: true } as unknown as D1Result;
        },
      };
    },
  } as unknown as D1Database;
}

test("handleGetReadState: 未ログインは401", async () => {
  const response = await handleGetReadState(new Request("http://localhost/api/read-state"), fakeDb());
  assert.equal(response.status, 401);
});

test("handleMarkRead: 未ログインは401", async () => {
  const request = new Request("http://localhost/api/read-state", {
    method: "POST",
    body: JSON.stringify({ articleGuidHash: "hash-1" }),
  });
  const response = await handleMarkRead(request, fakeDb());
  assert.equal(response.status, 401);
});

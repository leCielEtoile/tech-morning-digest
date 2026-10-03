import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_CATEGORIES, CATEGORY_ORDER_BY_GENRE, FEEDS, GENRE_ORDER } from "./feeds.js";

test("全ジャンルがカテゴリを持ち、カテゴリ名はジャンルをまたいで重複しない", () => {
  for (const genre of GENRE_ORDER) {
    assert.ok(CATEGORY_ORDER_BY_GENRE[genre].length > 0, `${genre}にカテゴリがない`);
  }
  assert.equal(new Set(ALL_CATEGORIES).size, ALL_CATEGORIES.length);
});

test("論文ジャンルのフィードはarXivのnewのみ・大きなmaxItemsを持つ", () => {
  const arxiv = FEEDS.find((feed) => feed.genre === "論文");
  assert.ok(arxiv, "論文ジャンルのフィードが定義されていない");
  assert.equal(arxiv.arxivNewOnly, true);
  assert.ok((arxiv.maxItems ?? 0) >= 500);
});

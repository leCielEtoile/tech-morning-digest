import assert from "node:assert/strict";
import { test } from "node:test";
import { isDigestPayload } from "./digests-loader.js";

test("isDigestPayload: 正しい形のペイロードはtrueを返す", () => {
  const payload = {
    date: "2026-09-13",
    generatedAt: "2026-09-13T23:35:00.000Z",
    hasNewArticles: true,
    threeLines: ["1行目", "2行目", "3行目"],
    categories: [
      {
        category: "開発・プログラミング",
        picks: [
          { title: "記事A", link: "https://example.com/a", feedName: "TestFeed", reason: "重要", summary: "要約" },
        ],
        others: [{ title: "記事B", link: "https://example.com/b", feedName: "TestFeed", gist: "あらすじ" }],
      },
    ],
  };

  assert.equal(isDigestPayload(payload), true);
});

test("isDigestPayload: picksにsummaryがないとfalseを返す", () => {
  const payload = {
    date: "2026-09-13",
    generatedAt: "2026-09-13T23:35:00.000Z",
    hasNewArticles: true,
    threeLines: [],
    categories: [
      {
        category: "開発・プログラミング",
        picks: [{ title: "記事A", link: "https://example.com/a", feedName: "TestFeed", reason: "重要" }],
        others: [],
      },
    ],
  };

  assert.equal(isDigestPayload(payload), false);
});

test("isDigestPayload: 旧スキーマ(categories[].articles形式)はfalseを返す", () => {
  const payload = {
    date: "2026-09-13",
    generatedAt: "2026-09-13T23:35:00.000Z",
    hasNewArticles: true,
    threeLines: ["1", "2", "3"],
    picks: [{ title: "記事A", link: "https://example.com/a", feedName: "TestFeed", reason: "重要" }],
    categories: [
      {
        category: "開発・プログラミング",
        articles: [{ title: "記事B", link: "https://example.com/b", feedName: "TestFeed", gist: "あらすじ" }],
      },
    ],
  };

  assert.equal(isDigestPayload(payload), false);
});

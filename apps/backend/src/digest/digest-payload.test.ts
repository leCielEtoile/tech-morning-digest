import assert from "node:assert/strict";
import { test } from "node:test";
import type { Article } from "../types.js";
import { buildDigestPayload } from "./digest-payload.js";

const sampleArticle: Article = {
  title: "サンプル記事",
  link: "https://example.com/a",
  guid: "https://example.com/a",
  feedName: "TestFeed",
  summary: "概要",
  pubDate: null,
};

test("buildDigestPayload: digestがある場合はhasNewArticles: trueで構築される", () => {
  const now = new Date("2026-08-02T23:35:00.000Z");
  const payload = buildDigestPayload({
    dateLabel: "2026-08-02",
    now,
    digest: {
      threeLines: ["1行目", "2行目", "3行目"],
      picks: [{ article: sampleArticle, reason: "重要だから" }],
      categories: [
        { category: "開発・プログラミング", articles: [{ article: sampleArticle, gist: "一行あらすじ" }] },
      ],
    },
  });

  assert.deepEqual(payload, {
    date: "2026-08-02",
    generatedAt: "2026-08-02T23:35:00.000Z",
    hasNewArticles: true,
    threeLines: ["1行目", "2行目", "3行目"],
    picks: [{ title: "サンプル記事", link: "https://example.com/a", feedName: "TestFeed", reason: "重要だから" }],
    categories: [
      {
        category: "開発・プログラミング",
        articles: [
          { title: "サンプル記事", link: "https://example.com/a", feedName: "TestFeed", gist: "一行あらすじ" },
        ],
      },
    ],
  });
});

test("buildDigestPayload: digestがnullの場合はhasNewArticles: falseかつ全フィールドが空になる", () => {
  const now = new Date("2026-08-02T23:35:00.000Z");
  const payload = buildDigestPayload({ dateLabel: "2026-08-02", now, digest: null });

  assert.equal(payload.hasNewArticles, false);
  assert.deepEqual(payload.threeLines, []);
  assert.deepEqual(payload.picks, []);
  assert.deepEqual(payload.categories, []);
});

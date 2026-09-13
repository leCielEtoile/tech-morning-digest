import assert from "node:assert/strict";
import { test } from "node:test";
import type { Article } from "../types.js";
import { buildDigestResult } from "./gemini-client.js";

function makeArticle(title: string): Article {
  return {
    title,
    link: `https://example.com/${title}`,
    guid: `https://example.com/${title}`,
    feedName: "TestFeed",
    summary: "概要",
    pubDate: null,
  };
}

test("buildDigestResult: categoryPicksに該当する記事はpicksに入り、othersからは除外される", () => {
  const articles = [makeArticle("A"), makeArticle("B")];
  const idToArticle = new Map<number, Article>(articles.map((article, id) => [id, article]));

  const result = buildDigestResult(
    {
      threeLines: ["1行目", "2行目", "3行目"],
      categoryPicks: [{ articleId: 0, category: "開発・プログラミング", reason: "重要だから", summary: "要約文。" }],
      categorizedArticles: [
        { articleId: 0, category: "開発・プログラミング", gist: "記事Aのあらすじ" },
        { articleId: 1, category: "開発・プログラミング", gist: "記事Bのあらすじ" },
      ],
    },
    idToArticle,
  );

  assert.deepEqual(result, {
    threeLines: ["1行目", "2行目", "3行目"],
    categories: [
      {
        category: "開発・プログラミング",
        picks: [{ article: articles[0], reason: "重要だから", summary: "要約文。" }],
        others: [{ article: articles[1], gist: "記事Bのあらすじ" }],
      },
    ],
  });
});

test("buildDigestResult: 存在しないarticleIdはpicks/othersどちらもスキップされる", () => {
  const idToArticle = new Map<number, Article>();

  const result = buildDigestResult(
    {
      threeLines: [],
      categoryPicks: [{ articleId: 99, category: "開発・プログラミング", reason: "理由", summary: "要約" }],
      categorizedArticles: [{ articleId: 99, category: "開発・プログラミング", gist: "あらすじ" }],
    },
    idToArticle,
  );

  assert.deepEqual(result.categories, []);
});

test("buildDigestResult: categoryPicksのcategoryがcategorizedArticlesと食い違っても二重掲載しない", () => {
  const articles = [makeArticle("A")];
  const idToArticle = new Map<number, Article>(articles.map((article, id) => [id, article]));

  const result = buildDigestResult(
    {
      threeLines: [],
      categoryPicks: [{ articleId: 0, category: "クラウド・インフラ", reason: "理由", summary: "要約" }],
      categorizedArticles: [{ articleId: 0, category: "開発・プログラミング", gist: "あらすじ" }],
    },
    idToArticle,
  );

  assert.deepEqual(result, {
    threeLines: [],
    categories: [
      {
        category: "クラウド・インフラ",
        picks: [{ article: articles[0], reason: "理由", summary: "要約" }],
        others: [],
      },
    ],
  });
});

test("buildDigestResult: picks・othersがともに空のカテゴリは結果から除外される", () => {
  const idToArticle = new Map<number, Article>();

  const result = buildDigestResult({ threeLines: [], categoryPicks: [], categorizedArticles: [] }, idToArticle);

  assert.deepEqual(result.categories, []);
});

test("buildDigestResult: 同一articleIdが複数のcategoryPicksに現れても最初の1件だけがpicksに入る", () => {
  const articles = [makeArticle("A")];
  const idToArticle = new Map<number, Article>(articles.map((article, id) => [id, article]));

  const result = buildDigestResult(
    {
      threeLines: [],
      categoryPicks: [
        { articleId: 0, category: "クラウド・インフラ", reason: "理由1", summary: "要約1" },
        { articleId: 0, category: "開発・プログラミング", reason: "理由2", summary: "要約2" },
      ],
      categorizedArticles: [{ articleId: 0, category: "クラウド・インフラ", gist: "あらすじ" }],
    },
    idToArticle,
  );

  assert.deepEqual(result, {
    threeLines: [],
    categories: [
      {
        category: "クラウド・インフラ",
        picks: [{ article: articles[0], reason: "理由1", summary: "要約1" }],
        others: [],
      },
    ],
  });
});

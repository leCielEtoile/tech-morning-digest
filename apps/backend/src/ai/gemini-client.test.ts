import assert from "node:assert/strict";
import { test } from "node:test";
import type { Article } from "../types.js";
import { buildDigestResult, generateDigestData } from "./gemini-client.js";

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

function geminiResponse(body: unknown): Response {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }] }),
    { status: 200 },
  );
}

test("generateDigestData: 分類→カテゴリ別→3行の順に呼び、失敗カテゴリは未処理として返す", async () => {
  const articles = [makeArticle("A"), makeArticle("B"), makeArticle("C")];
  const original = globalThis.fetch;
  const prompts: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const prompt = JSON.parse(String(init?.body)).contents[0].parts[0].text as string;
    prompts.push(prompt);
    if (prompt.startsWith("以下は記事のid・タイトル一覧")) {
      return geminiResponse({
        classifications: [
          { articleId: 0, category: "開発・プログラミング" },
          { articleId: 1, category: "開発・プログラミング" },
          { articleId: 2, category: "クラウド・インフラ" },
        ],
      });
    }
    if (prompt.includes("カテゴリ「クラウド・インフラ」")) return new Response("", { status: 400 });
    if (prompt.includes("カテゴリ「開発・プログラミング」")) {
      return geminiResponse({
        picks: [{ articleId: 0, reason: "理由", summary: "要約" }],
        gists: [{ articleId: 0, gist: "Aのあらすじ" }, { articleId: 1, gist: "Bのあらすじ" }],
      });
    }
    return geminiResponse({ threeLines: ["1", "2", "3"] });
  }) as typeof fetch;

  try {
    const { digest, processedArticles } = await generateDigestData(articles, "key", { requestIntervalMs: 0 });
    assert.deepEqual(digest.threeLines, ["1", "2", "3"]);
    assert.equal(digest.categories.length, 1);
    assert.deepEqual(processedArticles, [articles[0], articles[1]]);
    assert.ok(!prompts[0]?.includes("https://example.com"), "分類プロンプトにURLを含めない");
  } finally {
    globalThis.fetch = original;
  }
});

test("generateDigestData: 全カテゴリ失敗なら例外を投げる", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const prompt = JSON.parse(String(init?.body)).contents[0].parts[0].text as string;
    if (prompt.startsWith("以下は記事のid・タイトル一覧")) {
      return geminiResponse({ classifications: [{ articleId: 0, category: "開発・プログラミング" }] });
    }
    return new Response("", { status: 400 });
  }) as typeof fetch;
  try {
    await assert.rejects(generateDigestData([makeArticle("A")], "key", { requestIntervalMs: 0 }));
  } finally {
    globalThis.fetch = original;
  }
});

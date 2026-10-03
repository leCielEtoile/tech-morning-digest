import assert from "node:assert/strict";
import { test } from "node:test";
import type { Article } from "../types.js";
import { buildDigestResult, generateDigestData, resolveModels } from "./gemini-client.js";

function makeArticle(title: string, genre: Article["genre"] = "テック"): Article {
  return {
    title,
    link: `https://example.com/${title}`,
    guid: `https://example.com/${title}`,
    feedName: "TestFeed",
    genre,
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
        genre: "テック",
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
        genre: "テック",
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
        genre: "テック",
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

test("buildDigestResult: テック→論文の順に並び、論文カテゴリはgenre=論文になる", () => {
  const articles = [makeArticle("P", "論文"), makeArticle("T")];
  const idToArticle = new Map<number, Article>(articles.map((article, id) => [id, article]));

  const result = buildDigestResult(
    {
      threeLines: [],
      categoryPicks: [],
      categorizedArticles: [
        { articleId: 0, category: "自然言語処理", gist: "論文のあらすじ" },
        { articleId: 1, category: "開発・プログラミング", gist: "記事のあらすじ" },
      ],
    },
    idToArticle,
  );

  assert.deepEqual(
    result.categories.map((c) => [c.genre, c.category]),
    [
      ["テック", "開発・プログラミング"],
      ["論文", "自然言語処理"],
    ],
  );
});

test("generateDigestData: 論文ジャンルは論文カテゴリで分類・生成し、テックと独立に処理する", async () => {
  const articles = [makeArticle("T1"), makeArticle("P1", "論文")];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const prompt = JSON.parse(String(init?.body)).contents[0].parts[0].text as string;
    if (prompt.startsWith("以下は記事のid・タイトル一覧")) {
      return prompt.includes("自然言語処理")
        ? geminiResponse({ classifications: [{ articleId: 1, category: "自然言語処理" }] })
        : geminiResponse({ classifications: [{ articleId: 0, category: "開発・プログラミング" }] });
    }
    if (prompt.includes("カテゴリ「自然言語処理」")) {
      return geminiResponse({ picks: [], gists: [{ articleId: 1, gist: "論文のあらすじ" }] });
    }
    if (prompt.includes("カテゴリ「開発・プログラミング」")) {
      return geminiResponse({ picks: [], gists: [{ articleId: 0, gist: "記事のあらすじ" }] });
    }
    return geminiResponse({ threeLines: ["1", "2", "3"] });
  }) as typeof fetch;

  try {
    const { digest, processedArticles } = await generateDigestData(articles, "key", { requestIntervalMs: 0 });
    assert.deepEqual(
      digest.categories.map((c) => c.genre),
      ["テック", "論文"],
    );
    assert.equal(processedArticles.length, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test("generateDigestData: 論文の分類が失敗してもテックは掲載し、論文は未処理で返す", async () => {
  const articles = [makeArticle("T1"), makeArticle("P1", "論文")];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const prompt = JSON.parse(String(init?.body)).contents[0].parts[0].text as string;
    if (prompt.startsWith("以下は記事のid・タイトル一覧")) {
      return prompt.includes("自然言語処理")
        ? new Response("", { status: 400 })
        : geminiResponse({ classifications: [{ articleId: 0, category: "開発・プログラミング" }] });
    }
    if (prompt.includes("カテゴリ「開発・プログラミング」")) {
      return geminiResponse({ picks: [], gists: [{ articleId: 0, gist: "記事のあらすじ" }] });
    }
    return geminiResponse({ threeLines: ["1", "2", "3"] });
  }) as typeof fetch;

  try {
    const { digest, processedArticles } = await generateDigestData(articles, "key", { requestIntervalMs: 0 });
    assert.deepEqual(
      digest.categories.map((c) => c.genre),
      ["テック"],
    );
    assert.deepEqual(processedArticles, [articles[0]]);
  } finally {
    globalThis.fetch = original;
  }
});

test("resolveModels: 環境変数で上書きでき、フォールバックは重複を除いて後ろに並ぶ", () => {
  const defaults = resolveModels({});
  assert.deepEqual(defaults.classify, ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]);
  assert.deepEqual(defaults.generate, ["gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]);

  const custom = resolveModels({
    GEMINI_MODEL: "gemini-3-flash-preview",
    GEMINI_CLASSIFY_MODEL: "x-lite",
    GEMINI_FALLBACK_MODELS: "gemini-3-flash-preview, y",
  });
  assert.deepEqual(custom.generate, ["gemini-3-flash-preview", "y"]);
  assert.deepEqual(custom.classify, ["x-lite", "gemini-3-flash-preview", "y"]);
});

test("generateDigestData: 日次枠超過(429 PerDay)と404は即座に次のモデルへフォールバックする", async () => {
  const articles = [makeArticle("A")];
  const original = globalThis.fetch;
  const calledModels: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const model = /models\/([^:]+):/.exec(String(url))?.[1] ?? "";
    calledModels.push(model);
    const prompt = JSON.parse(String(init?.body)).contents[0].parts[0].text as string;
    if (model === "m1") {
      return new Response(
        JSON.stringify({ error: { details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } }),
        { status: 429 },
      );
    }
    if (model === "m2") return new Response("", { status: 404 });
    if (prompt.startsWith("以下は記事のid・タイトル一覧")) {
      return geminiResponse({ classifications: [{ articleId: 0, category: "開発・プログラミング" }] });
    }
    if (prompt.includes("カテゴリ「開発・プログラミング」")) {
      return geminiResponse({ picks: [], gists: [{ articleId: 0, gist: "あらすじ" }] });
    }
    return geminiResponse({ threeLines: ["1", "2", "3"] });
  }) as typeof fetch;

  try {
    const models = { classify: ["m1", "m2", "m3"], generate: ["m1", "m2", "m3"] };
    const { processedArticles } = await generateDigestData(articles, "key", { requestIntervalMs: 0, models });
    assert.deepEqual(processedArticles, [articles[0]]);
    assert.deepEqual(calledModels.slice(0, 3), ["m1", "m2", "m3"]);
  } finally {
    globalThis.fetch = original;
  }
});

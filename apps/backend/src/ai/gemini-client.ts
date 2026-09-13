import { CATEGORY_ORDER, type Category } from "../config/feeds.js";
import type { Article } from "../types.js";
import { assertOk, withRetry } from "../utils/retry.js";

// 2026-08-05時点の最新世代モデル(context7経由でai.google.devの現行ドキュメントを確認済み)。
// Free Tierでinput/outputが無料であることを確認済みだが、無料枠の正確なRPM/RPD/TPMは
// 実装・運用時にai.google.devの最新レート制限ページで再確認すること(spec.md 7章・13章)。
const GEMINI_MODEL = process.env["GEMINI_MODEL"] ?? "gemini-3.6-flash";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// spec.md 8章: Gemini API呼び出しは最大3回、初回2秒→上限16秒。429時はRetry-Afterヘッダーを優先
const GEMINI_RETRY_OPTIONS = {
  maxRetries: 3,
  baseDelayMs: 2000,
  maxDelayMs: 16000,
  respectRetryAfter: true,
};

/** Geminiへ渡す記事データ。linkはGeminiに書かせない(こちらのArticleデータから復元するため不要)。 */
interface PromptArticle {
  id: number;
  title: string;
  feedName: string;
  summary: string;
}

/**
 * spec.md 5章のプロンプトテンプレートに従い、新着記事一覧からGemini向けプロンプトを構築する。
 * URLはGeminiに一切書かせない設計(2026-08-05変更): カテゴリ別セクションはこちらのコードが
 * 既に持っているデータ(タイトル・リンク・出典)をそのまま使うため、Geminiには生成・選定に
 * 必要な最小限のデータ(id・タイトル・出典・概要)のみを渡し、記事本体の再送信をさせない。
 * これにより出力トークンを大幅に削減し、URLの書き間違い/言い換えリスクも排除する。
 */
export function buildPrompt(articles: Article[]): string {
  const promptArticles: PromptArticle[] = articles.map((article, id) => ({
    id,
    title: article.title,
    feedName: article.feedName,
    summary: article.summary,
  }));

  return `以下は本日取得した新着記事の一覧です(id・タイトル・フィード名・概要)。

# タスク
1. 全体を俯瞰した「今日の3行」を3行で作成してください
2. 全ての記事について、最も適切なカテゴリを1つ選んでください(articleIdごとにcategoryを指定。下記カテゴリ一覧から選ぶこと。記事の実際の内容で判断し、出典元の傾向だけで機械的に決めないこと)。あわせて、記事ごとに内容を一行(30〜50文字程度)で要約したあらすじも添えてください
3. カテゴリごとに特に重要と思われる記事を1〜3件選び(articleIdとcategoryで指定。該当記事がなければ0件でも構いません)、それぞれ選定理由を1文と、内容の要約を3〜6文程度で添えてください

# カテゴリ一覧
${CATEGORY_ORDER.join(" / ")}

# 記事データ
${JSON.stringify(promptArticles, null, 2)}`;
}

interface RawCategoryPick {
  articleId: number;
  category: string;
  reason: string;
  summary: string;
}

interface RawCategorizedArticle {
  articleId: number;
  category: string;
  gist: string;
}

interface RawGeminiDigest {
  threeLines: string[];
  categoryPicks: RawCategoryPick[];
  categorizedArticles: RawCategorizedArticle[];
}

function isRawGeminiDigest(value: unknown): value is RawGeminiDigest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record["threeLines"]) &&
    record["threeLines"].every((line) => typeof line === "string") &&
    Array.isArray(record["categoryPicks"]) &&
    record["categoryPicks"].every(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as Record<string, unknown>)["articleId"] === "number" &&
        typeof (p as Record<string, unknown>)["category"] === "string" &&
        typeof (p as Record<string, unknown>)["reason"] === "string" &&
        typeof (p as Record<string, unknown>)["summary"] === "string",
    ) &&
    Array.isArray(record["categorizedArticles"]) &&
    record["categorizedArticles"].every(
      (c) =>
        typeof c === "object" &&
        c !== null &&
        typeof (c as Record<string, unknown>)["articleId"] === "number" &&
        typeof (c as Record<string, unknown>)["category"] === "string" &&
        typeof (c as Record<string, unknown>)["gist"] === "string",
    )
  );
}

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    threeLines: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "全体の潮流を俯瞰した3行の要約。必ず3件。",
    },
    categoryPicks: {
      type: "ARRAY",
      description: "カテゴリごとに特に重要な記事1〜3件(該当記事がなければ0件)。",
      items: {
        type: "OBJECT",
        properties: {
          articleId: { type: "INTEGER" },
          category: { type: "STRING", enum: CATEGORY_ORDER },
          reason: { type: "STRING", description: "選定理由を1文で。" },
          summary: { type: "STRING", description: "記事内容の要約。3〜6文程度。" },
        },
        required: ["articleId", "category", "reason", "summary"],
      },
    },
    categorizedArticles: {
      type: "ARRAY",
      description: "入力された記事全件について、それぞれ最も適切なカテゴリと一行あらすじを割り当てる。",
      items: {
        type: "OBJECT",
        properties: {
          articleId: { type: "INTEGER" },
          category: { type: "STRING", enum: CATEGORY_ORDER },
          gist: { type: "STRING", description: "記事の内容を一行(30〜50文字程度)で要約したあらすじ。" },
        },
        required: ["articleId", "category", "gist"],
      },
    },
  },
  required: ["threeLines", "categoryPicks", "categorizedArticles"],
};

export interface DigestCategoryPick {
  article: Article;
  reason: string;
  summary: string;
}

export interface DigestCategoryArticle {
  article: Article;
  gist: string;
}

export interface DigestCategory {
  category: Category;
  picks: DigestCategoryPick[];
  others: DigestCategoryArticle[];
}

export interface GeminiDigestResult {
  threeLines: string[];
  categories: DigestCategory[];
}

/**
 * Geminiの生レスポンスと記事マップから、カテゴリごとのpicks/othersに整形する。
 * ネットワーク呼び出しを含まない純粋関数として切り出し、単体テスト可能にしている。
 */
export function buildDigestResult(raw: RawGeminiDigest, idToArticle: Map<number, Article>): GeminiDigestResult {
  const picksByCategory = new Map<Category, DigestCategoryPick[]>();
  // pickされた記事は、categorizedArticles側のcategoryと食い違っていてもothersに二重掲載しない
  // よう、カテゴリを問わずグローバルに除外する(Geminiの出力矛盾に対する防御)。
  const pickedArticleIds = new Set<number>();
  for (const pick of raw.categoryPicks) {
    const article = idToArticle.get(pick.articleId);
    if (!article) continue; // 存在しないarticleIdを指した場合はスキップ(壊れたダイジェストより一部欠けたダイジェストの方がまし)
    if (!CATEGORY_ORDER.includes(pick.category as Category)) continue; // enumで縛っていても念のため防御
    const category = pick.category as Category;
    const list = picksByCategory.get(category) ?? [];
    list.push({ article, reason: pick.reason, summary: pick.summary });
    picksByCategory.set(category, list);
    pickedArticleIds.add(pick.articleId);
  }

  const othersByCategory = new Map<Category, DigestCategoryArticle[]>();
  for (const entry of raw.categorizedArticles) {
    if (pickedArticleIds.has(entry.articleId)) continue;
    const article = idToArticle.get(entry.articleId);
    if (!article) continue;
    if (!CATEGORY_ORDER.includes(entry.category as Category)) continue;
    const category = entry.category as Category;
    const list = othersByCategory.get(category) ?? [];
    list.push({ article, gist: entry.gist });
    othersByCategory.set(category, list);
  }

  const categories: DigestCategory[] = CATEGORY_ORDER.map((category) => ({
    category,
    picks: picksByCategory.get(category) ?? [],
    others: othersByCategory.get(category) ?? [],
  })).filter((c) => c.picks.length > 0 || c.others.length > 0);

  return { threeLines: raw.threeLines, categories };
}

/**
 * Gemini APIを呼び出し、構造化されたダイジェストデータを返す。
 * 全リトライ失敗時は例外をthrowする。呼び出し元(index.ts)はこれを捕捉し、
 * 「前日ページ維持・state未更新」のフローに分岐させること(spec.md 7章)。
 */
export async function generateDigestData(articles: Article[], apiKey: string): Promise<GeminiDigestResult> {
  const idToArticle = new Map<number, Article>(articles.map((article, id) => [id, article]));
  const prompt = buildPrompt(articles);

  const raw = await withRetry(async () => {
    const response = await fetch(GEMINI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
    });
    const validated = assertOk(response);
    const data = (await validated.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error("Gemini APIのレスポンスにテキストが含まれていません");
    }

    const parsed: unknown = JSON.parse(text);
    if (!isRawGeminiDigest(parsed)) {
      throw new Error("Gemini APIのレスポンスが期待するスキーマと一致しません");
    }
    return parsed;
  }, GEMINI_RETRY_OPTIONS);

  return buildDigestResult(raw, idToArticle);
}

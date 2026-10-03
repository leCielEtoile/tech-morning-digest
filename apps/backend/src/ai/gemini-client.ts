import {
  ALL_CATEGORIES,
  CATEGORY_ORDER_BY_GENRE,
  GENRE_ORDER,
  type Category,
  type Genre,
} from "../config/feeds.js";
import type { Article } from "../types.js";
import { assertOk, isTransientError, RetryableFetchError, withRetry } from "../utils/retry.js";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// 無料枠のレート制限はモデルごとに独立している(2026-10-03にAI Studioで確認)ため、
// 枠の別なモデルをフォールバックに並べて429/503・日次枠超過に備える。
// 分類は件数が多く判断が単純なので Flash Lite、要約系は Flash を第一候補にする。
// モデルIDは提供終了に備えて環境変数で差し替え可能にする。
const DEFAULT_GENERATE_MODEL = "gemini-3.6-flash";
const DEFAULT_CLASSIFY_MODEL = "gemini-2.5-flash-lite";
// gemini-3-flash-preview は、無料枠を AI Studio で確認済み(2026-10-03)の「Gemini 3 Flash」のプレビュー版ID。
const DEFAULT_FALLBACK_MODELS = "gemini-3-flash-preview,gemini-2.5-flash";

export interface GeminiModels {
  classify: string[];
  generate: string[];
}

export function resolveModels(env: NodeJS.ProcessEnv = process.env): GeminiModels {
  const fallbacks = (env["GEMINI_FALLBACK_MODELS"] ?? DEFAULT_FALLBACK_MODELS)
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const chain = (primary: string): string[] => [...new Set([primary, ...fallbacks])];
  return {
    classify: chain(env["GEMINI_CLASSIFY_MODEL"] ?? DEFAULT_CLASSIFY_MODEL),
    generate: chain(env["GEMINI_MODEL"] ?? DEFAULT_GENERATE_MODEL),
  };
}

// spec.md 8章: Gemini API呼び出しは最大3回、初回2秒→上限16秒。429時はRetry-Afterヘッダーを優先
const GEMINI_RETRY_OPTIONS = {
  maxRetries: 3,
  baseDelayMs: 2000,
  maxDelayMs: 16000,
  respectRetryAfter: true,
};

/** 分類リクエスト1回あたりの記事数。巨大プロンプトによる429/503を避けるため分割する */
export const CLASSIFY_CHUNK_SIZE = 100;
/** カテゴリ別リクエストに渡す概要の最大文字数。論文はアブストラクトが長いため多めに取る */
const MAX_SUMMARY_CHARS: Record<Genre, number> = { テック: 300, 論文: 600 };
/**
 * 連続するGemini呼び出しの間隔。無料枠は5 RPM(2026-10-03にAI Studioで確認)のため、
 * 応答時間を含めても超えないよう12秒超を空ける。
 */
const DEFAULT_REQUEST_INTERVAL_MS = 13000;

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

interface RawClassification {
  classifications: { articleId: number; category: string }[];
}

interface RawCategoryDetail {
  picks: { articleId: number; reason: string; summary: string }[];
  gists: { articleId: number; gist: string }[];
}

interface RawThreeLines {
  threeLines: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isArrayOf<T>(value: unknown, guard: (item: Record<string, unknown>) => boolean): value is T[] {
  return Array.isArray(value) && value.every((item) => isRecord(item) && guard(item));
}

const isNum = (v: unknown): v is number => typeof v === "number";
const isStr = (v: unknown): v is string => typeof v === "string";

function isRawClassification(value: unknown): value is RawClassification {
  return (
    isRecord(value) &&
    isArrayOf(value["classifications"], (c) => isNum(c["articleId"]) && isStr(c["category"]))
  );
}

function isRawCategoryDetail(value: unknown): value is RawCategoryDetail {
  return (
    isRecord(value) &&
    isArrayOf(value["picks"], (p) => isNum(p["articleId"]) && isStr(p["reason"]) && isStr(p["summary"])) &&
    isArrayOf(value["gists"], (g) => isNum(g["articleId"]) && isStr(g["gist"]))
  );
}

function isRawThreeLines(value: unknown): value is RawThreeLines {
  return isRecord(value) && Array.isArray(value["threeLines"]) && value["threeLines"].every(isStr);
}

function classifySchema(categories: Category[]) {
  return {
    type: "OBJECT",
    properties: {
      classifications: {
        type: "ARRAY",
        description: "入力された記事全件について、最も適切なカテゴリを1つ割り当てる。",
        items: {
          type: "OBJECT",
          properties: {
            articleId: { type: "INTEGER" },
            category: { type: "STRING", enum: categories },
          },
          required: ["articleId", "category"],
        },
      },
    },
    required: ["classifications"],
  };
}

const CATEGORY_DETAIL_SCHEMA = {
  type: "OBJECT",
  properties: {
    picks: {
      type: "ARRAY",
      description: "特に重要な記事1〜3件(該当記事がなければ0件)。",
      items: {
        type: "OBJECT",
        properties: {
          articleId: { type: "INTEGER" },
          reason: { type: "STRING", description: "選定理由を1文で。" },
          summary: { type: "STRING", description: "記事内容の要約。3〜6文程度。" },
        },
        required: ["articleId", "reason", "summary"],
      },
    },
    gists: {
      type: "ARRAY",
      description: "入力された記事全件の一行あらすじ。",
      items: {
        type: "OBJECT",
        properties: {
          articleId: { type: "INTEGER" },
          gist: { type: "STRING", description: "記事の内容を一行(30〜50文字程度)で要約したあらすじ。" },
        },
        required: ["articleId", "gist"],
      },
    },
  },
  required: ["picks", "gists"],
};

const THREE_LINES_SCHEMA = {
  type: "OBJECT",
  properties: {
    threeLines: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "全体の潮流を俯瞰した3行の要約。必ず3件。",
    },
  },
  required: ["threeLines"],
};

/**
 * 分類用プロンプト。URL・概要は渡さず(id・タイトルのみ)入力トークンを最小化する。
 * リンクはこちらがidから復元するためGeminiに扱わせない。
 */
export function buildClassifyPrompt(entries: { id: number; title: string }[], categories: Category[]): string {
  return `以下は記事のid・タイトル一覧です。全ての記事について、最も適切なカテゴリを1つ選んでください(articleIdごとにcategoryを指定)。記事の実際の内容で判断し、出典元の傾向だけで機械的に決めないこと。

# カテゴリ一覧
${categories.join(" / ")}

# 記事データ
${JSON.stringify(entries)}`;
}

interface CategoryPromptArticle {
  id: number;
  title: string;
  feedName: string;
  summary: string;
}

/** カテゴリ別プロンプト。1カテゴリ分の記事だけを渡し、picksと全件のあらすじを生成させる */
export function buildCategoryPrompt(category: Category, articles: CategoryPromptArticle[], genre: Genre): string {
  if (genre === "論文") {
    return `以下は本日公開された新着論文のうち、カテゴリ「${category}」に分類された論文の一覧です(id・タイトル・フィード名・概要=アブストラクト)。

# タスク(日本語で出力してください)
1. 特に重要と思われる論文を1〜3件選び(articleIdで指定。該当がなければ0件でも構いません)、それぞれ選定理由を1文と、「何を達成した研究か・手法・結果」を軸にした要約を3〜6文程度で添えてください
2. 全ての論文について、何を達成した研究かを一行(30〜50文字程度)で要約したあらすじを添えてください(articleIdごとにgistを指定)

# 論文データ
${JSON.stringify(articles, null, 2)}`;
  }

  return `以下は本日取得した新着記事のうち、カテゴリ「${category}」に分類された記事の一覧です(id・タイトル・フィード名・概要)。

# タスク
1. 特に重要と思われる記事を1〜3件選び(articleIdで指定。該当記事がなければ0件でも構いません)、それぞれ選定理由を1文と、内容の要約を3〜6文程度で添えてください
2. 全ての記事について、内容を一行(30〜50文字程度)で要約したあらすじを添えてください(articleIdごとにgistを指定)

# 記事データ
${JSON.stringify(articles, null, 2)}`;
}

/** 今日の3行用プロンプト。各カテゴリで選ばれた記事のタイトルと選定理由だけを渡す */
export function buildThreeLinesPrompt(highlights: { category: Category; title: string; reason: string }[]): string {
  return `以下は本日のカテゴリ別の注目記事です。全体を俯瞰した「今日の3行」を3行で作成してください。

# 注目記事
${JSON.stringify(highlights, null, 2)}`;
}

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
  genre: Genre;
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
    if (pickedArticleIds.has(pick.articleId)) continue; // 同一articleIdが複数カテゴリのpicksに二重掲載されるのを防ぐ
    const article = idToArticle.get(pick.articleId);
    if (!article) continue; // 存在しないarticleIdを指した場合はスキップ(壊れたダイジェストより一部欠けたダイジェストの方がまし)
    if (!ALL_CATEGORIES.includes(pick.category as Category)) continue; // enumで縛っていても念のため防御
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
    if (!ALL_CATEGORIES.includes(entry.category as Category)) continue;
    const category = entry.category as Category;
    const list = othersByCategory.get(category) ?? [];
    list.push({ article, gist: entry.gist });
    othersByCategory.set(category, list);
  }

  const categories: DigestCategory[] = GENRE_ORDER.flatMap((genre) =>
    CATEGORY_ORDER_BY_GENRE[genre].map((category) => ({
      genre,
      category,
      picks: picksByCategory.get(category) ?? [],
      others: othersByCategory.get(category) ?? [],
    })),
  ).filter((c) => c.picks.length > 0 || c.others.length > 0);

  return { threeLines: raw.threeLines, categories };
}

const MAX_PICKS_PER_CATEGORY = 3;

export interface GenerateDigestOptions {
  /** 連続するGemini呼び出しの間隔(ms)。テストでは0を指定する */
  requestIntervalMs?: number;
  /** 用途別のモデル優先リスト。省略時は環境変数・既定値から解決する */
  models?: GeminiModels;
}

export interface GenerateDigestOutcome {
  digest: GeminiDigestResult;
  /** ダイジェストに実際に掲載した記事。呼び出し元はこれだけを既読化する(失敗カテゴリ分は翌日に持ち越す) */
  processedArticles: Article[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 日次枠の超過はリトライしても回復しないため、リトライ対象外のエラーとして区別する */
class DailyQuotaError extends Error {
  constructor(model: string) {
    super(`Gemini日次枠超過: ${model}`);
    this.name = "DailyQuotaError";
  }
}

/** 同じモデルでの再試行を使い切った一時エラー・日次枠超過・存在しないモデル(404)は次のモデルへ回す */
function shouldFallback(error: unknown): boolean {
  return (
    error instanceof RetryableFetchError ||
    error instanceof DailyQuotaError ||
    (error instanceof Error && error.message.startsWith("HTTP 404"))
  );
}

async function callModel<T>(
  apiKey: string,
  model: string,
  prompt: string,
  schema: unknown,
  guard: (value: unknown) => value is T,
): Promise<T> {
  return withRetry(
    async () => {
      const response = await fetch(`${GEMINI_API_BASE}/${model}:generateContent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: schema,
          },
        }),
      });
      if (!response.ok) {
        // 429はRPM/TPM/RPDのどれに当たったかがbodyのQuotaFailure(quotaId)にしか出ないため残す
        const body = await response.clone().text();
        console.warn(`[digest] Gemini APIエラー(${model}) HTTP ${response.status}: ${body.slice(0, 500)}`);
        if (response.status === 429 && body.includes("PerDay")) throw new DailyQuotaError(model);
      }
      const validated = assertOk(response);
      const data = (await validated.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new Error("Gemini APIのレスポンスにテキストが含まれていません");
      }

      const parsed: unknown = JSON.parse(text);
      if (!guard(parsed)) {
        throw new Error("Gemini APIのレスポンスが期待するスキーマと一致しません");
      }
      return parsed;
    },
    { ...GEMINI_RETRY_OPTIONS, isRetryable: isTransientError },
  );
}

async function callGemini<T>(
  apiKey: string,
  models: string[],
  prompt: string,
  schema: unknown,
  guard: (value: unknown) => value is T,
): Promise<T> {
  let lastError: unknown;
  for (const model of models) {
    try {
      return await callModel(apiKey, model, prompt, schema, guard);
    } catch (error) {
      if (!shouldFallback(error)) throw error;
      lastError = error;
      console.warn(`[digest] モデル ${model} が失敗。次のモデルへフォールバックします`);
    }
  }
  throw lastError;
}

/** タイトルのみで1チャンク分(1リクエスト)を分類する。範囲外のid・カテゴリは無視する */
export async function classifyEntries(
  apiKey: string,
  models: string[],
  entries: { id: number; title: string }[],
  categories: Category[],
): Promise<Map<number, Category>> {
  const result = await callGemini(
    apiKey,
    models,
    buildClassifyPrompt(entries, categories),
    classifySchema(categories),
    isRawClassification,
  );
  const validIds = new Set(entries.map((entry) => entry.id));
  const categoryById = new Map<number, Category>();
  for (const { articleId, category } of result.classifications) {
    if (validIds.has(articleId) && categories.includes(category as Category)) {
      categoryById.set(articleId, category as Category);
    }
  }
  return categoryById;
}

/**
 * ジャンルごとに3段階でダイジェストを生成する(巨大な単一リクエストによる429/503を避けるため)。
 *   1. タイトルのみをCLASSIFY_CHUNK_SIZE件ずつ送ってカテゴリ分類(ジャンル単位。失敗したジャンルは未処理で返す)
 *   2. カテゴリごとに picks+あらすじを生成(失敗カテゴリはスキップし、その記事は未処理として返す)
 *   3. 全ジャンルのpicksから今日の3行を生成(失敗時は例外)
 * 全ジャンル・全カテゴリが失敗した場合や3行の失敗は例外。呼び出し元(index.ts)はこれを捕捉し、
 * 「前日ページ維持・state未更新」のフローに分岐させること(spec.md 7章)。
 */
export async function generateDigestData(
  articles: Article[],
  apiKey: string,
  options: GenerateDigestOptions = {},
): Promise<GenerateDigestOutcome> {
  const intervalMs = options.requestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS;
  const models = options.models ?? resolveModels();
  const idToArticle = new Map<number, Article>(articles.map((article, id) => [id, article]));
  let isFirstCall = true;
  const paced = async <T>(call: () => Promise<T>): Promise<T> => {
    if (!isFirstCall) await sleep(intervalMs);
    isFirstCall = false;
    return call();
  };

  const raw: RawGeminiDigest = { threeLines: [], categoryPicks: [], categorizedArticles: [] };

  for (const genre of GENRE_ORDER) {
    const categories = CATEGORY_ORDER_BY_GENRE[genre];
    const entries = articles.flatMap((article, id) => (article.genre === genre ? [{ id, title: article.title }] : []));
    if (entries.length === 0) continue;

    const categoryById = new Map<number, Category>();
    try {
      for (let i = 0; i < entries.length; i += CLASSIFY_CHUNK_SIZE) {
        const chunk = entries.slice(i, i + CLASSIFY_CHUNK_SIZE);
        const classified = await paced(() => classifyEntries(apiKey, models.classify, chunk, categories));
        for (const [id, category] of classified) categoryById.set(id, category);
      }
    } catch (error) {
      console.warn(`[digest] ジャンル「${genre}」の分類に失敗。今回は掲載せず翌日に持ち越します。`, error);
      continue;
    }

    for (const category of categories) {
      const ids = [...categoryById].filter(([, c]) => c === category).map(([id]) => id);
      if (ids.length === 0) continue;
      const promptArticles: CategoryPromptArticle[] = ids.map((id) => {
        const article = idToArticle.get(id) as Article;
        return {
          id,
          title: article.title,
          feedName: article.feedName,
          summary: article.summary.slice(0, MAX_SUMMARY_CHARS[genre]),
        };
      });
      try {
        const detail = await paced(() =>
          callGemini(
            apiKey,
            models.generate,
            buildCategoryPrompt(category, promptArticles, genre),
            CATEGORY_DETAIL_SCHEMA,
            isRawCategoryDetail,
          ),
        );
        const idSet = new Set(ids);
        for (const pick of detail.picks.filter((p) => idSet.has(p.articleId)).slice(0, MAX_PICKS_PER_CATEGORY)) {
          raw.categoryPicks.push({ ...pick, category });
        }
        for (const g of detail.gists.filter((g) => idSet.has(g.articleId))) {
          raw.categorizedArticles.push({ ...g, category });
        }
      } catch (error) {
        console.warn(`[digest] カテゴリ「${category}」の生成に失敗。今回は掲載せず翌日に持ち越します。`, error);
      }
    }
  }

  if (raw.categorizedArticles.length === 0) {
    throw new Error("全カテゴリのダイジェスト生成に失敗しました");
  }

  const highlights = raw.categoryPicks.flatMap((p) => {
    const article = idToArticle.get(p.articleId);
    return article ? [{ category: p.category as Category, title: article.title, reason: p.reason }] : [];
  });
  const gistTitles = raw.categorizedArticles.slice(0, 10).flatMap((g) => {
    const article = idToArticle.get(g.articleId);
    return article ? [{ category: g.category as Category, title: article.title, reason: g.gist }] : [];
  });
  const threeLinesInput = highlights.length > 0 ? highlights : gistTitles;
  const threeLines = await paced(() =>
    callGemini(
      apiKey,
      models.generate,
      buildThreeLinesPrompt(threeLinesInput),
      THREE_LINES_SCHEMA,
      isRawThreeLines,
    ),
  );
  raw.threeLines = threeLines.threeLines;

  const digest = buildDigestResult(raw, idToArticle);
  const processedArticles = digest.categories.flatMap((c) => [
    ...c.picks.map((p) => p.article),
    ...c.others.map((o) => o.article),
  ]);
  return { digest, processedArticles };
}

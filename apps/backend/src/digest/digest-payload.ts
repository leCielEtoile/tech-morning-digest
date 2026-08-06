import type { Category } from "../config/feeds.js";
import type { GeminiDigestResult } from "../ai/gemini-client.js";

export interface DigestArticleRef {
  title: string;
  link: string;
  feedName: string;
}

export interface DigestPickPayload extends DigestArticleRef {
  reason: string;
}

export interface DigestCategoryArticlePayload extends DigestArticleRef {
  gist: string;
}

export interface DigestCategoryPayload {
  category: Category;
  articles: DigestCategoryArticlePayload[];
}

/**
 * R2に保存するダイジェストの構造化データ。HTML化・レイアウトはフロントエンド(Astro、ビルド時)側の責務。
 * `hasNewArticles: false` の場合、フロントエンド側で「本日は新着なし」相当の表示を行う想定。
 * 2026-08-05変更: GeminiにMarkdownを生成させるのをやめ、Geminiの構造化出力(threeLines/picks/categorizedArticles)
 * をそのままシリアライズする形に変更した。カテゴリ別セクションの記事一覧のうちタイトル・リンク・出典は
 * Geminiの出力ではなく、こちらのコードが元々持っているArticleデータをそのまま使う(URLの書き間違いを防ぐため)。
 * gist(一行あらすじ)のみGeminiが記事のsummaryから生成したテキストをそのまま使う(2026-08-06追加)。
 */
export interface DigestPayload {
  /** JST日付(YYYY-MM-DD)。R2オブジェクトキー `{date}.json` と一致する */
  date: string;
  /** 生成時刻(ISO8601、UTC) */
  generatedAt: string;
  hasNewArticles: boolean;
  threeLines: string[];
  picks: DigestPickPayload[];
  categories: DigestCategoryPayload[];
}

function toArticleRef(article: { title: string; link: string; feedName: string }): DigestArticleRef {
  return { title: article.title, link: article.link, feedName: article.feedName };
}

export function buildDigestPayload(params: {
  dateLabel: string;
  now: Date;
  digest: GeminiDigestResult | null;
}): DigestPayload {
  const { digest } = params;
  return {
    date: params.dateLabel,
    generatedAt: params.now.toISOString(),
    hasNewArticles: digest !== null,
    threeLines: digest?.threeLines ?? [],
    picks: digest?.picks.map((pick) => ({ ...toArticleRef(pick.article), reason: pick.reason })) ?? [],
    categories:
      digest?.categories.map((c) => ({
        category: c.category,
        articles: c.articles.map((a) => ({ ...toArticleRef(a.article), gist: a.gist })),
      })) ?? [],
  };
}

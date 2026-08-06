import { MAX_ITEMS_PER_FEED, type FeedDefinition } from "../config/feeds.js";
import type { Article } from "../types.js";
import { assertOk, withRetry } from "../utils/retry.js";
import { parseFeedXml } from "./feed-parser.js";

// spec.md 8章: 各RSSフィード取得は最大3回、初回1秒→上限8秒の指数バックオフ
const FETCH_RETRY_OPTIONS = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 8000,
};

export interface FeedFetchResult {
  feed: FeedDefinition;
  articles: Article[];
  error: Error | null;
}

async function fetchFeedXml(feed: FeedDefinition): Promise<string> {
  return withRetry(async () => {
    const response = await fetch(feed.url, {
      headers: { "User-Agent": "TechMorningDigest/1.0" },
    });
    const validated = assertOk(response);
    return validated.text();
  }, FETCH_RETRY_OPTIONS);
}

/**
 * 1フィードを取得・パースする。失敗しても例外を投げず、errorを含む結果を返す。
 * 1フィードの失敗が全体の処理を止めないようにするため(spec.md 8章)。
 */
export async function fetchFeed(feed: FeedDefinition): Promise<FeedFetchResult> {
  try {
    const xml = await fetchFeedXml(feed);
    const articles = await parseFeedXml(xml, feed);
    return { feed, articles: articles.slice(0, MAX_ITEMS_PER_FEED), error: null };
  } catch (error) {
    return {
      feed,
      articles: [],
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * 全フィードを程よい並行数で取得する(対象サイトへの配慮として同時接続数を制限。spec.md 11章)。
 */
export async function fetchAllFeeds(
  feeds: FeedDefinition[],
  concurrency = 5,
): Promise<FeedFetchResult[]> {
  const results: FeedFetchResult[] = new Array(feeds.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= feeds.length) return;
      results[index] = await fetchFeed(feeds[index]!);
    }
  }

  const workerCount = Math.min(concurrency, feeds.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

import { CATEGORY_ORDER_BY_GENRE, FEEDS } from "../src/config/feeds.js";
import { classifyEntries } from "../src/ai/gemini-client.js";
import { fetchAllFeeds } from "../src/fetch/feed-fetcher.js";

// 使い方: GEMINI_API_KEY を設定して `pnpm --filter @rss-summary/backend exec tsx scripts/compare-classify.ts`
// テック記事の先頭100件のタイトルを2モデルで分類し、一致率と不一致を表示する(各モデル1リクエストを消費)。
const SAMPLE_SIZE = 100;
const BASELINE_MODEL = "gemini-3.5-flash";
const CANDIDATE_MODEL = "gemini-3.5-flash-lite";

async function main(): Promise<void> {
  const apiKey = process.env["GEMINI_API_KEY"];
  if (!apiKey) throw new Error("GEMINI_API_KEY が設定されていません");

  const results = await fetchAllFeeds(FEEDS.filter((feed) => (feed.genre ?? "テック") === "テック"));
  const articles = results.flatMap((result) => result.articles).slice(0, SAMPLE_SIZE);
  const entries = articles.map((article, id) => ({ id, title: article.title }));
  const categories = CATEGORY_ORDER_BY_GENRE["テック"];

  const baseline = await classifyEntries(apiKey, [BASELINE_MODEL], entries, categories);
  const candidate = await classifyEntries(apiKey, [CANDIDATE_MODEL], entries, categories);

  let agree = 0;
  for (const entry of entries) {
    const a = baseline.get(entry.id);
    const b = candidate.get(entry.id);
    if (a === b) {
      agree += 1;
    } else {
      console.log(`不一致: ${entry.title}\n  ${BASELINE_MODEL}: ${a ?? "(未分類)"}\n  ${CANDIDATE_MODEL}: ${b ?? "(未分類)"}`);
    }
  }
  console.log(`一致率: ${agree}/${entries.length} (${Math.round((agree / entries.length) * 100)}%)`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

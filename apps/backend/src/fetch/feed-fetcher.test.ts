import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_ITEMS_PER_FEED, type FeedDefinition } from "../config/feeds.js";
import { fetchFeed } from "./feed-fetcher.js";

function itemsXml(count: number): string {
  const items = Array.from(
    { length: count },
    (_, i) => `<item><title>T${i}</title><link>https://example.com/${i}</link><guid>g${i}</guid></item>`,
  ).join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`;
}

async function withFeedXml<T>(xml: string, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(xml, { status: 200 })) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test("fetchFeed: maxItems未指定は既定上限、指定時はその値で切る", async () => {
  const xml = itemsXml(MAX_ITEMS_PER_FEED + 10);
  const base: FeedDefinition = { name: "F", url: "https://example.com/feed", format: "rss2.0" };

  const defaultResult = await withFeedXml(xml, () => fetchFeed(base));
  assert.equal(defaultResult.articles.length, MAX_ITEMS_PER_FEED);

  const largeResult = await withFeedXml(xml, () => fetchFeed({ ...base, maxItems: 1000 }));
  assert.equal(largeResult.articles.length, MAX_ITEMS_PER_FEED + 10);
});

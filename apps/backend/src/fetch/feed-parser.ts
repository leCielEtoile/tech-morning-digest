import Parser from "rss-parser";
import type { FeedDefinition } from "../config/feeds.js";
import type { Article } from "../types.js";

// AtomフィードのidフィールドはPRの型定義に含まれていないため、カスタムフィールドとして追加する
type CustomItem = { id?: string };

const parser = new Parser<Record<string, never>, CustomItem>();

function extractGuid(item: { guid?: string; id?: string; link?: string }): string | null {
  return item.guid ?? item.id ?? item.link ?? null;
}

function extractSummary(item: { contentSnippet?: string; summary?: string; content?: string }): string {
  const raw = item.contentSnippet ?? item.summary ?? item.content ?? "";
  return raw.trim();
}

const ARXIV_ANNOUNCE_TYPE = /Announce Type:\s*(\S+)/;
const ARXIV_PREFIX = /^arXiv:\S+\s+Announce Type:\s*\S+\s*Abstract:\s*/;

/**
 * RSS1.0(RDF)/RSS2.0/Atomいずれの形式のXML文字列も rss-parser で共通に正規化してArticle[]を返す。
 * (spec.md 2章調査ログで、rss-parserが3フォーマットとも実データで問題なく扱えることを確認済み)
 */
export async function parseFeedXml(xml: string, feed: FeedDefinition): Promise<Article[]> {
  const parsed = await parser.parseString(xml);
  const articles: Article[] = [];

  for (const item of parsed.items) {
    if (!item.title || !item.link) continue; // タイトル・リンクのないアイテムは記事として扱えないためスキップ

    const guid = extractGuid(item);
    if (!guid) continue; // GUID・リンクどちらも取得できない場合は既読管理ができないためスキップ

    const summary = extractSummary(item);
    if (feed.arxivNewOnly) {
      // 形式変更でtypeが読めない場合は全件落とすより残す方を選ぶ(fail-open)
      const announceType = ARXIV_ANNOUNCE_TYPE.exec(summary)?.[1] ?? null;
      if (announceType !== null && announceType !== "new") continue;
    }

    articles.push({
      title: item.title.trim(),
      link: item.link,
      guid,
      feedName: feed.name,
      genre: feed.genre ?? "テック",
      summary: feed.arxivNewOnly ? summary.replace(ARXIV_PREFIX, "") : summary,
      pubDate: item.isoDate ?? null,
    });
  }

  return articles;
}

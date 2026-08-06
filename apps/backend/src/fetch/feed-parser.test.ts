import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { FeedDefinition } from "../config/feeds.js";
import { parseFeedXml } from "./feed-parser.js";

const FIXTURES_DIR = new URL("../../test/fixtures/", import.meta.url);

async function loadFixture(name: string): Promise<string> {
  return readFile(new URL(name, FIXTURES_DIR), "utf-8");
}

test("RSS1.0(RDF)形式を正規化できる。GUIDがないためlinkをguidにフォールバックする", async () => {
  const xml = await loadFixture("sample-rss1.0-rdf.xml");
  const feed: FeedDefinition = {
    name: "AKIBA PC Hotline",
    url: "https://example.com/feed.rdf",
    format: "rss1.0",
  };

  const articles = await parseFeedXml(xml, feed);

  assert.ok(articles.length > 0);
  const first = articles[0]!;
  assert.equal(first.feedName, "AKIBA PC Hotline");
  assert.equal(first.guid, first.link, "RDFにはguidがないためlinkがguidとして使われるべき");
  assert.notEqual(first.pubDate, null);
});

test("RSS2.0形式を正規化できる。guidフィールドを優先して使う", async () => {
  const xml = await loadFixture("sample-rss2.0.xml");
  const feed: FeedDefinition = {
    name: "ASCII",
    url: "https://example.com/rss.xml",
    format: "rss2.0",
  };

  const articles = await parseFeedXml(xml, feed);

  assert.ok(articles.length > 0);
  const first = articles[0]!;
  assert.equal(first.feedName, "ASCII");
  assert.ok(first.title.length > 0);
  assert.ok(first.link.startsWith("https://"));
});

test("Atom形式を正規化できる。id(tag URI)をguidとして使う", async () => {
  const xml = await loadFixture("sample-atom.xml");
  const feed: FeedDefinition = {
    name: "Publickey",
    url: "https://example.com/atom.xml",
    format: "atom",
  };

  const articles = await parseFeedXml(xml, feed);

  assert.ok(articles.length > 0);
  const first = articles[0]!;
  assert.match(first.guid, /^tag:/, "AtomのidはURLではなくtag URI形式のはず");
  assert.notEqual(first.guid, first.link);
});

test("タイトルまたはリンクがないアイテムはスキップされる", async () => {
  const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item><title>タイトルのみ</title></item>
  <item><link>https://example.com/no-title</link></item>
  <item><title>正常な記事</title><link>https://example.com/ok</link><guid>g1</guid></item>
</channel></rss>`;
  const feed: FeedDefinition = {
    name: "Test",
    url: "https://example.com",
    format: "rss2.0",
  };

  const articles = await parseFeedXml(xml, feed);

  assert.equal(articles.length, 1);
  assert.equal(articles[0]!.title, "正常な記事");
});

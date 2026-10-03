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

const ARXIV_FEED: FeedDefinition = {
  name: "arXiv",
  url: "https://rss.arxiv.org/rss/cs.AI",
  format: "rss2.0",
  genre: "論文",
  arxivNewOnly: true,
};

function arxivItem(id: string, type: string): string {
  return `<item><title>Paper ${id}</title><link>https://arxiv.org/abs/${id}</link><guid isPermaLink="false">oai:arXiv.org:${id}</guid>
<description>arXiv:${id} Announce Type: ${type}
Abstract: We study ${id}.</description><pubDate>Mon, 06 Oct 2026 00:00:00 -0400</pubDate></item>`;
}

test("arXivフィード: Announce Type: new のみを残し、接頭辞を除いたアブストラクトをsummaryにする", async () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
${arxivItem("2610.00001v1", "new")}
${arxivItem("2610.00002v1", "cross")}
${arxivItem("2610.00003v2", "replace")}
${arxivItem("2610.00004v1", "replace-cross")}
</channel></rss>`;

  const articles = await parseFeedXml(xml, ARXIV_FEED);

  assert.equal(articles.length, 1);
  assert.equal(articles[0]!.genre, "論文");
  assert.equal(articles[0]!.summary, "We study 2610.00001v1.");
});

test("arXivフィード: Announce Typeが読み取れない形式変更時は取りこぼし防止のため残す", async () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
<item><title>No type</title><link>https://arxiv.org/abs/x</link><guid>x</guid><description>Plain abstract.</description></item>
</channel></rss>`;

  const articles = await parseFeedXml(xml, ARXIV_FEED);

  assert.equal(articles.length, 1);
  assert.equal(articles[0]!.summary, "Plain abstract.");
});

test("genre未指定のフィードは「テック」になる", async () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
<item><title>T</title><link>https://example.com/t</link><guid>t</guid></item>
</channel></rss>`;
  const feed: FeedDefinition = { name: "Test", url: "https://example.com", format: "rss2.0" };

  const articles = await parseFeedXml(xml, feed);

  assert.equal(articles[0]!.genre, "テック");
});

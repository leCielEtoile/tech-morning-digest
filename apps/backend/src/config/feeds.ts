export type Genre = "テック" | "論文";

export type TechCategory =
  | "クラウド・インフラ"
  | "開発・プログラミング"
  | "ガジェット・ハードウェア"
  | "総合IT・テックニュース"
  | "カルチャー・海外トレンド"
  | "個人ブログ・コラム";

export type PaperCategory = "AI・機械学習" | "自然言語処理" | "コンピュータビジョン" | "その他";

export type Category = TechCategory | PaperCategory;

export type FeedFormat = "rss1.0" | "rss2.0" | "atom";

export interface FeedDefinition {
  name: string;
  url: string;
  format: FeedFormat;
  /** 省略時は「テック」 */
  genre?: Genre;
  /** 省略時は MAX_ITEMS_PER_FEED */
  maxItems?: number;
  /** arXivフィード用。descriptionの `Announce Type: new` の論文だけを残す(replace/crossは既出論文の再掲のため除外) */
  arxivNewOnly?: boolean;
}

// spec.md 3章を反映。URLは2026-08-02に実アクセスで確認済み。
// カテゴリは記事ごとにGeminiが内容から判定するため、フィード単位の静的マッピングは持たない(spec.md 4章)。
export const FEEDS: FeedDefinition[] = [
  { name: "AKIBA PC Hotline", url: "https://akiba-pc.watch.impress.co.jp/data/rss/1.0/ah/feed.rdf", format: "rss1.0" },
  { name: "ASCII", url: "https://ascii.jp/rss.xml", format: "rss2.0" },
  { name: "窓の杜", url: "https://forest.watch.impress.co.jp/data/rss/1.0/wf/feed.rdf", format: "rss1.0" },
  { name: "Google Cloud リリースノート", url: "https://cloud.google.com/feeds/gcp-release-notes.xml", format: "atom" },
  {
    name: "Google Cloud 日本語ブログ",
    url: "https://cloudblog.withgoogle.com/ja/products/gcp/rss/",
    format: "rss2.0",
  },
  { name: "AmazonWebServicesブログ", url: "https://aws.amazon.com/jp/blogs/news/feed/", format: "rss2.0" },
  { name: "DevelopersIO", url: "https://dev.classmethod.jp/feed/", format: "rss2.0" },
  { name: "GIGAZINE", url: "https://gigazine.net/news/rss_2.0/", format: "rss2.0" },
  { name: "ITmedia News", url: "https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml", format: "rss2.0" },
  { name: "InfoQ", url: "https://www.infoq.com/jp/feed/", format: "rss2.0" },
  { name: "PC Watch", url: "https://pc.watch.impress.co.jp/data/rss/1.0/pcw/feed.rdf", format: "rss1.0" },
  { name: "Publickey", url: "https://www.publickey1.jp/atom.xml", format: "atom" },
  { name: "Qiita", url: "https://qiita.com/popular-items/feed", format: "atom" },
  { name: "WIRED Japan", url: "https://wired.jp/feed/rss", format: "rss2.0" },
  { name: "Zenn", url: "https://zenn.dev/feed", format: "rss2.0" },
  { name: "gihyo", url: "https://gihyo.jp/feed/rss2", format: "rss2.0" },
  { name: "はてなブログ(横断)", url: "https://b.hatena.ne.jp/hotentry/it.rss", format: "rss1.0" },
  {
    name: "arXiv (cs.AI/CL/CV/LG)",
    url: "https://rss.arxiv.org/rss/cs.AI+cs.CL+cs.CV+cs.LG",
    format: "rss2.0",
    genre: "論文",
    maxItems: 1000,
    arxivNewOnly: true,
  },
];

// ジャンルとカテゴリの表示順。Geminiの分類結果をこの順序でグルーピングする。
export const GENRE_ORDER: Genre[] = ["テック", "論文"];

export const CATEGORY_ORDER_BY_GENRE: Record<Genre, Category[]> = {
  テック: [
    "クラウド・インフラ",
    "開発・プログラミング",
    "ガジェット・ハードウェア",
    "総合IT・テックニュース",
    "カルチャー・海外トレンド",
    "個人ブログ・コラム",
  ],
  論文: ["AI・機械学習", "自然言語処理", "コンピュータビジョン", "その他"],
};

export const ALL_CATEGORIES: Category[] = GENRE_ORDER.flatMap((genre) => CATEGORY_ORDER_BY_GENRE[genre]);

// 1フィードあたりの取得件数上限(spec.md 6章のフェイルセーフ設計)
export const MAX_ITEMS_PER_FEED = 50;

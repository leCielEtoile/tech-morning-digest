import type { Genre } from "./config/feeds.js";

export interface Article {
  title: string;
  link: string;
  /** フィードのGUID(RDFにはGUIDがないためlinkをフォールバックとして使う。spec.md 6章) */
  guid: string;
  feedName: string;
  genre: Genre;
  summary: string;
  /** ISO8601形式。取得できなければnull */
  pubDate: string | null;
}

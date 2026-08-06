export interface Article {
  title: string;
  link: string;
  /** フィードのGUID(RDFにはGUIDがないためlinkをフォールバックとして使う。spec.md 6章) */
  guid: string;
  feedName: string;
  summary: string;
  /** ISO8601形式。取得できなければnull */
  pubDate: string | null;
}

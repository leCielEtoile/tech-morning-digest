/**
 * UTC時刻からJST(UTC+9固定、日本にDSTは存在しない。spec.md 9章)の日付文字列(YYYY-MM-DD)を得る。
 * apps/backend(生成日のファイル名決定)・apps/frontend(アーカイブの日付範囲計算)の両方から使う共通処理。
 */
export function toJstDateString(date: Date): string {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const year = jst.getUTCFullYear();
  const month = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const day = String(jst.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

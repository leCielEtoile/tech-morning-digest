/**
 * R2から取得した当日分ダイジェストJSONが「当日生成されたもの」かを判定する。
 * オブジェクトキーは `{date}.json` で当日日付のはずだが、ペイロード内の `date` も突き合わせる。
 * 取得失敗(null)・パース不能・日付不一致はすべて「古い(=生成が走っていない)」とみなす。
 */
export function isDigestFresh(rawJson: string | null, todayJst: string): boolean {
  if (rawJson === null) {
    return false;
  }
  try {
    const parsed = JSON.parse(rawJson) as { date?: unknown };
    return parsed.date === todayJst;
  } catch {
    return false;
  }
}

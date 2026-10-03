import { createHash } from "node:crypto";
import { getR2Text, putR2Text, type R2Config } from "../publish/r2-client.js";

/** guidHash -> 最終既読日時(ISO8601)。spec.md 6章のデータ形式 */
export type ReadState = Record<string, string>;

/** 既読stateを保存するR2オブジェクトキー。ダイジェストJSONと同じバケット。 */
export const STATE_OBJECT_KEY = "state/read-guids.json";
export const PRUNE_AFTER_DAYS = 14; // spec.md 6章(90日→14日に短縮済み)

export function computeGuidHash(feedName: string, guid: string): string {
  return createHash("sha256").update(`${feedName}::${guid}`).digest("hex");
}

/**
 * R2から既読stateを読み込む。オブジェクトが存在しなければ空stateを返す
 * (初回実行・移行前などは正常系)。
 */
export async function loadReadState(r2: R2Config): Promise<ReadState> {
  const content = await getR2Text(r2, STATE_OBJECT_KEY);
  if (content === null) {
    return {};
  }
  const parsed: unknown = JSON.parse(content);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${STATE_OBJECT_KEY} の形式が不正です`);
  }
  return parsed as ReadState;
}

/** 記録から PRUNE_AFTER_DAYS 日以上経過したエントリを取り除く(spec.md 6章) */
export function pruneReadState(state: ReadState, now = new Date()): ReadState {
  const cutoffMs = now.getTime() - PRUNE_AFTER_DAYS * 24 * 60 * 60 * 1000;
  const pruned: ReadState = {};
  for (const [hash, readAt] of Object.entries(state)) {
    const readAtMs = Date.parse(readAt);
    if (!Number.isNaN(readAtMs) && readAtMs >= cutoffMs) {
      pruned[hash] = readAt;
    }
  }
  return pruned;
}

/** 既読状態に存在しない記事(=新着)のみを返す */
export function filterNewArticles<T extends { feedName: string; guid: string }>(
  articles: T[],
  state: ReadState,
): T[] {
  return articles.filter((article) => !(computeGuidHash(article.feedName, article.guid) in state));
}

/** 前回実行の取りこぼし防止用の余裕。GUID重複排除があるため広げても二重掲載にはならない */
export const PUBLISH_WINDOW_MARGIN_MS = 6 * 60 * 60 * 1000;

/** 既読stateの最新の既読日時=前回成功実行時刻(ms)。有効なエントリがなければnull */
export function lastRunAtMs(state: ReadState): number | null {
  let latest: number | null = null;
  for (const readAt of Object.values(state)) {
    const ms = Date.parse(readAt);
    if (!Number.isNaN(ms) && (latest === null || ms > latest)) latest = ms;
  }
  return latest;
}

/**
 * 前回成功実行時刻(−余裕)より後に公開された記事のみを返す。pubDateが取得できない記事は
 * 除外せず残す。stateが空(初回など)の場合は絞り込まない。
 */
export function filterPublishedSinceLastRun<T extends { pubDate: string | null }>(
  articles: T[],
  state: ReadState,
): T[] {
  const lastMs = lastRunAtMs(state);
  if (lastMs === null) return articles;
  const thresholdMs = lastMs - PUBLISH_WINDOW_MARGIN_MS;
  return articles.filter((article) => {
    if (article.pubDate === null) return true;
    const ms = Date.parse(article.pubDate);
    return Number.isNaN(ms) || ms > thresholdMs;
  });
}

/** 指定した記事群を既読化した新しいReadStateを返す(引数のstateは変更しない) */
export function markAsRead<T extends { feedName: string; guid: string }>(
  state: ReadState,
  articles: T[],
  now = new Date(),
): ReadState {
  const nowIso = now.toISOString();
  const updated: ReadState = { ...state };
  for (const article of articles) {
    updated[computeGuidHash(article.feedName, article.guid)] = nowIso;
  }
  return updated;
}

/**
 * 更新後の既読stateをR2へ書き込む。
 *
 * 呼び出しタイミングの制約(実装上の必須事項):
 * この書き込みはGemini生成+ダイジェストのR2書き込みが両方成功した後にのみ実行すること。
 * 失敗時に既読化してしまうと、その記事が二度と新着として扱われなくなるため。
 *
 * 差分の有無に関わらず毎回PUTする。毎日書き換わることでR2の30日ライフサイクル削除を回避する。
 */
export async function saveReadState(r2: R2Config, state: ReadState): Promise<void> {
  await putR2Text(
    r2,
    STATE_OBJECT_KEY,
    `${JSON.stringify(state, null, 2)}\n`,
    "application/json; charset=utf-8",
  );
}

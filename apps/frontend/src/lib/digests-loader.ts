import type { Loader } from "astro/loaders";
import { recentJstDates } from "./digest-dates.js";
import { getR2Object, readR2ConfigFromEnv, type R2Config } from "./r2-client.js";

/** アーカイブとして表示する日数。R2側は30日保持しているが、表示は直近2週間に絞る(要件定義参照) */
export const ARCHIVE_DAYS = 14;

/** apps/backend/src/digest/digest-payload.ts の DigestPayload と一致させること */
export interface DigestArticleRef {
  title: string;
  link: string;
  feedName: string;
}

export interface DigestPayload {
  date: string;
  generatedAt: string;
  hasNewArticles: boolean;
  threeLines: string[];
  picks: (DigestArticleRef & { reason: string })[];
  categories: { category: string; articles: (DigestArticleRef & { gist: string })[] }[];
}

interface MinimalLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
}

function isArticleRef(value: unknown): value is DigestArticleRef {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["title"] === "string" &&
    typeof record["link"] === "string" &&
    typeof record["feedName"] === "string"
  );
}

function isDigestPayload(value: unknown): value is DigestPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["date"] === "string" &&
    typeof record["generatedAt"] === "string" &&
    typeof record["hasNewArticles"] === "boolean" &&
    Array.isArray(record["threeLines"]) &&
    record["threeLines"].every((line) => typeof line === "string") &&
    Array.isArray(record["picks"]) &&
    record["picks"].every((p) => isArticleRef(p) && typeof (p as unknown as Record<string, unknown>)["reason"] === "string") &&
    Array.isArray(record["categories"]) &&
    record["categories"].every(
      (c) =>
        typeof c === "object" &&
        c !== null &&
        typeof (c as Record<string, unknown>)["category"] === "string" &&
        Array.isArray((c as Record<string, unknown>)["articles"]) &&
        ((c as Record<string, unknown>)["articles"] as unknown[]).every(
          (a) => isArticleRef(a) && typeof (a as unknown as Record<string, unknown>)["gist"] === "string",
        ),
    )
  );
}

/**
 * 1日分のダイジェストJSONを取得・検証する。取得失敗(404含む)・JSON不正・スキーマ不一致は
 * 例外を投げず null を返す。1日分の異常が他の日やビルド全体に波及しないようにするため
 * (getR2Object自体は404以外のエラーで例外を投げる実装のため、ここで確実に吸収する)。
 */
async function loadOneDay(
  config: R2Config,
  date: string,
  logger: MinimalLogger,
): Promise<{ date: string; payload: DigestPayload } | null> {
  const key = `${date}.json`;

  let raw: string | null;
  try {
    raw = await getR2Object(config, key);
  } catch (error) {
    logger.warn(`スキップ: ${key} の取得に失敗しました(${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
  if (raw === null) {
    logger.info(`スキップ: ${key} が見つかりません(未実行日の可能性)`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    logger.warn(`スキップ: ${key} のJSONが不正です(${error instanceof Error ? error.message : String(error)})`);
    return null;
  }

  if (!isDigestPayload(parsed) || parsed.date !== date) {
    logger.warn(`スキップ: ${key} の形式が不正です`);
    return null;
  }

  return { date, payload: parsed };
}

/**
 * R2から直近ARCHIVE_DAYS日分のダイジェストJSONをビルド時に取得し、コンテンツコレクションとして公開するローダー。
 * 各日の取得・パース・検証は独立して失敗できる設計とし、1日分の異常(未実行・JSON破損・一時的なR2エラー等)が
 * ビルド全体を失敗させないようにする。取得はPromise.allで並行実行し、直近14日分の往復遅延の合計ではなく
 * 最も遅い1件分の遅延で済むようにする。
 */
export function digestsLoader(): Loader {
  return {
    name: "r2-digests-loader",
    load: async ({ store, parseData, logger }) => {
      const config = readR2ConfigFromEnv();
      store.clear();

      const dates = recentJstDates(ARCHIVE_DAYS);
      const results = await Promise.all(dates.map((date) => loadOneDay(config, date, logger)));

      for (const result of results) {
        if (result === null) continue;
        const { date, payload } = result;
        const data = await parseData({ id: date, data: payload as unknown as Record<string, unknown> });
        store.set({ id: date, data });
      }
    },
  } satisfies Loader;
}

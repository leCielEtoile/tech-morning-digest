import { requireSession } from "./router.js";
import { readJsonBody } from "./parse-json.js";
import { getCategoryPrefs, setCategoryPrefs, type CategoryPref } from "../db/preferences.js";

/**
 * apps/backend/src/config/feeds.tsのCategory型と同じ値。フロントWorkerはビルド時実行の
 * backendパッケージに依存しない構成のため、ここでは値を複製する(feeds.ts変更時は
 * こちらも更新すること)。
 */
const VALID_CATEGORIES = new Set([
  "クラウド・インフラ",
  "開発・プログラミング",
  "ガジェット・ハードウェア",
  "総合IT・テックニュース",
  "カルチャー・海外トレンド",
  "個人ブログ・コラム",
]);

function isCategoryPrefArray(value: unknown): value is CategoryPref[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as Record<string, unknown>)["category"] === "string" &&
        VALID_CATEGORIES.has((item as Record<string, unknown>)["category"] as string) &&
        typeof (item as Record<string, unknown>)["enabled"] === "boolean",
    )
  );
}

export async function handleGetPreferences(request: Request, db: D1Database): Promise<Response> {
  const session = await requireSession(request, db);
  if (!session) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }
  const prefs = await getCategoryPrefs(db, session.userId);
  return new Response(JSON.stringify({ prefs }), { status: 200, headers: { "content-type": "application/json" } });
}

export async function handlePutPreferences(request: Request, db: D1Database): Promise<Response> {
  const session = await requireSession(request, db);
  if (!session) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }
  const body: unknown = await readJsonBody(request);
  if (!isCategoryPrefArray(body)) {
    return new Response(JSON.stringify({ error: "invalid_body" }), { status: 400 });
  }
  await setCategoryPrefs(db, session.userId, body);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
}

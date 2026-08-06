import { generateDigestData } from "./ai/gemini-client.js";
import { FEEDS } from "./config/feeds.js";
import { buildDigestPayload } from "./digest/digest-payload.js";
import { fetchAllFeeds } from "./fetch/feed-fetcher.js";
import { triggerDeployHook } from "./publish/deploy-hook.js";
import { uploadDigestJson, type R2Config } from "./publish/r2-client.js";
import {
  commitReadState,
  filterNewArticles,
  loadReadState,
  markAsRead,
  pruneReadState,
} from "./state/read-state.js";
import type { Article } from "./types.js";
import { toJstDateString } from "@rss-summary/shared";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`環境変数 ${name} が設定されていません`);
  }
  return value;
}

interface Config {
  geminiApiKey: string;
  r2: R2Config;
  deployHookUrl: string;
}

function loadConfig(): Config {
  return {
    geminiApiKey: requireEnv("GEMINI_API_KEY"),
    r2: {
      accountId: requireEnv("CLOUDFLARE_ACCOUNT_ID"),
      accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
      bucketName: requireEnv("R2_BUCKET_NAME"),
    },
    deployHookUrl: requireEnv("DEPLOY_HOOK_URL"),
  };
}

// 全体のデッドラインはGitHub Actionsワークフロー側のtimeout-minutesで管理する(spec.md 8章補足)。
// 個々の処理は各モジュールで最大リトライ・上限遅延が設定済みのため、全体の壁時間は自然に頭打ちになる。
async function main(): Promise<void> {
  const config = loadConfig();
  const now = new Date();
  const dateLabel = toJstDateString(now);
  const objectKey = `${dateLabel}.json`;

  console.log(`[digest] 開始: ${now.toISOString()} (JST日付: ${dateLabel})`);

  console.log("[digest] stateブランチから既読状態を読み込み中...");
  const state = await loadReadState();

  console.log(`[digest] ${FEEDS.length}フィードを取得中...`);
  const feedResults = await fetchAllFeeds(FEEDS);

  const allArticles: Article[] = [];
  let failedFeedCount = 0;
  for (const result of feedResults) {
    if (result.error) {
      failedFeedCount += 1;
      console.warn(`[digest] フィード取得失敗(スキップ): ${result.feed.name}: ${result.error.message}`);
    } else {
      allArticles.push(...result.articles);
    }
  }
  if (failedFeedCount === FEEDS.length) {
    console.warn("[digest] 全フィードの取得に失敗しました。新着0件として処理を続行します");
  }
  console.log(`[digest] 取得記事数(全フィード合計): ${allArticles.length}`);

  const newArticles = filterNewArticles(allArticles, state);
  console.log(`[digest] 新着記事数: ${newArticles.length}`);

  if (newArticles.length === 0) {
    console.log("[digest] 新着0件。hasNewArticles: falseのペイロードを書き込みます(spec.md 6章)");
    const payload = buildDigestPayload({ dateLabel, now, digest: null });
    await uploadDigestJson(config.r2, objectKey, JSON.stringify(payload));
    // R2書き込みが成功した時点でデータは確定しているため、Deploy Hookより先に既読化を行う。
    // 既読化する新着GUIDはないが、プルーニングは実施する(差分がなければcommitReadState内でno-op)
    await commitReadState(pruneReadState(state, now));
    console.log("[digest] Deploy Hookを呼び出し中...");
    await triggerDeployHook(config.deployHookUrl);
    console.log("[digest] 完了(新着なし)");
    return;
  }

  console.log("[digest] Gemini APIでダイジェストを生成中...");
  let digest: Awaited<ReturnType<typeof generateDigestData>>;
  try {
    digest = await generateDigestData(newArticles, config.geminiApiKey);
  } catch (error) {
    // Gemini生成が全リトライ失敗した場合、前日ページを維持し既読化もしない(spec.md 7章)。
    // 新着記事は翌日以降も新着として再評価される。GitHub Actionsの失敗通知に任せる(spec.md 9章)。
    console.error("[digest] Gemini API呼び出しが全リトライ失敗。前日ページを維持します。", error);
    process.exitCode = 1;
    return;
  }

  console.log("[digest] R2へアップロード中...");
  const payload = buildDigestPayload({ dateLabel, now, digest });
  await uploadDigestJson(config.r2, objectKey, JSON.stringify(payload));

  // R2書き込みが成功した時点でその日の記事内容は確定しているため、既読化はDeploy Hookより先に行う。
  // こうしておくと、Deploy Hook呼び出しが失敗しても(内容自体は既にR2にあるため)翌日以降に
  // 同じ記事群を再度Geminiへ渡してしまう無駄打ちを避けられる(実運用検証で発見した設計上の考慮点)。
  console.log("[digest] 既読状態を更新中...");
  const updatedState = pruneReadState(markAsRead(state, newArticles, now), now);
  await commitReadState(updatedState);

  console.log("[digest] Deploy Hookを呼び出し中...");
  await triggerDeployHook(config.deployHookUrl);

  console.log(`[digest] 完了。新着${newArticles.length}件を掲載しました`);
}

export { main };

// このファイルが直接実行された場合のみmain()を起動する(テストからimportした際に自動実行されないように)
const isDirectlyExecuted = process.argv[1] === new URL(import.meta.url).pathname;
if (isDirectlyExecuted) {
  main().catch((error: unknown) => {
    console.error("[digest] 予期しないエラーで終了します", error);
    process.exitCode = 1;
  });
}

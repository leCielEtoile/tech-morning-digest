import { AwsClient } from "aws4fetch";
import { toJstDateString } from "@rss-summary/shared";
import { isDigestFresh } from "./digest-fresh.js";
import { postWithRetry } from "./retry.js";

/** Worker ランタイムに注入する変数・シークレット。ダッシュボードの Variables and Secrets で設定する。 */
interface Env {
  DEPLOY_HOOK_URL: string;
  ALERT_WEBHOOK_URL: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET_NAME: string;
}

const BUILD_CRON = "30 23 * * *";
const WATCHDOG_CRON = "0 2 * * *";

/** R2から当日分ダイジェストJSONを署名付きGETで取得する。404はnull。 */
async function fetchDigestJson(env: Env, key: string): Promise<string | null> {
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  });
  const url = `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${key}`;
  const response = await client.fetch(url, { method: "GET" });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`R2 GET ${key} 失敗: HTTP ${response.status}`);
  }
  return response.text();
}

/** Discord(content)・Slack(text)どちらのIncoming Webhookでも読めるよう両キーを送る。ベストエフォート。 */
async function sendAlert(env: Env, message: string): Promise<void> {
  await fetch(env.ALERT_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: message, text: message }),
  });
}

async function runWatchdog(env: Env): Promise<void> {
  const todayJst = toJstDateString(new Date());
  const raw = await fetchDigestJson(env, `${todayJst}.json`);
  if (isDigestFresh(raw, todayJst)) {
    return;
  }
  await sendAlert(
    env,
    `[tech-morning-digest] ${todayJst} のダイジェストがR2に見つかりません。生成ビルドが失敗した可能性があります。`,
  );
}

export default {
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (controller.cron === BUILD_CRON) {
      await postWithRetry(env.DEPLOY_HOOK_URL);
      return;
    }
    if (controller.cron === WATCHDOG_CRON) {
      await runWatchdog(env);
    }
  },
} satisfies ExportedHandler<Env>;

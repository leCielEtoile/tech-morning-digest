import { assertOk, withRetry } from "../utils/retry.js";

// spec.md 8章: Deploy Hook呼び出しは最大3回、初回1秒→上限8秒
const DEPLOY_HOOK_RETRY_OPTIONS = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 8000,
};

/**
 * Cloudflare Pages(またはWorkers Builds)のDeploy Hookを呼び出し、静的サイトのリビルドをトリガーする。
 * 認証ヘッダーは不要(URL自体が認証情報として機能する。spec.md 10章)。
 */
export async function triggerDeployHook(deployHookUrl: string): Promise<void> {
  await withRetry(async () => {
    const response = await fetch(deployHookUrl, { method: "POST" });
    assertOk(response);
  }, DEPLOY_HOOK_RETRY_OPTIONS);
}

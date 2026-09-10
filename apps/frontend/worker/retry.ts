/**
 * URLへPOSTし、429/5xx とネットワーク例外のみ指数バックオフでリトライする。
 * それ以外の非2xxは恒久的失敗として即 throw。全試行が失敗したら最後のエラーを throw。
 */
export async function postWithRetry(url: string, attempts = 3): Promise<void> {
  let lastError: unknown = new Error(`POST ${url} が実行されませんでした`);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let retryable = true;
    try {
      const response = await fetch(url, { method: "POST" });
      if (response.ok) return;
      lastError = new Error(`POST ${url}: HTTP ${response.status}`);
      retryable = response.status === 429 || response.status >= 500;
    } catch (error) {
      lastError = error;
    }
    if (!retryable) throw lastError;
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
  throw lastError;
}

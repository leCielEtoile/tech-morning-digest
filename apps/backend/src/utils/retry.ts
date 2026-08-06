// spec.md 8章「リトライ機構」の指数バックオフ+ジッター実装。
// RSSフィード取得・Gemini API呼び出し・R2書き込み・Deploy Hook呼び出しの全てから利用する共通ユーティリティ。

export class RetryableFetchError extends Error {
  constructor(
    message: string,
    public readonly response: Response,
  ) {
    super(message);
    this.name = "RetryableFetchError";
  }
}

/** 429(レート制限)・5xx(サーバーエラー)は一時的エラーとしてリトライ対象とする */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Responseがエラーステータスの場合、リトライ可否に応じて例外を投げる。
 * リトライ対象(429/5xx)は RetryableFetchError、それ以外(4xxの多く)は通常の Error として区別する。
 */
export function assertOk(response: Response): Response {
  if (response.ok) return response;
  const message = `HTTP ${response.status} ${response.statusText}`;
  if (isRetryableStatus(response.status)) {
    throw new RetryableFetchError(message, response);
  }
  throw new Error(`${message}(リトライ対象外)`);
}

/** RetryableFetchError、またはfetchのネットワークレベル例外(TypeError)を一時的エラーとみなす */
export function isTransientError(error: unknown): boolean {
  return error instanceof RetryableFetchError || error instanceof TypeError;
}

export interface RetryOptions {
  /** 最大試行回数(初回を含む合計回数) */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** 429時、ResponseのRetry-Afterヘッダーがあれば優先的に待機時間として使う */
  respectRetryAfter?: boolean;
  /** このエラーでリトライすべきか判定する。省略時は isTransientError を使用 */
  isRetryable?: (error: unknown) => boolean;
  /** リトライ発生時のログ出力用フック(観測性のため) */
  onRetry?: (attempt: number, error: unknown, waitMs: number) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeBackoffMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = baseDelayMs * 2 ** attempt;
  const jitter = Math.random() * baseDelayMs;
  return Math.min(exponential + jitter, maxDelayMs);
}

function extractRetryAfterMs(error: unknown): number | null {
  if (!(error instanceof RetryableFetchError)) return null;
  const header = error.response.headers.get("retry-after");
  if (header === null) return null;

  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return seconds * 1000;

  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());

  return null;
}

/**
 * fnを実行し、失敗時は指数バックオフ+ジッターでリトライする。
 * maxRetries回試行してもすべて失敗した場合は、最後のエラーをそのままthrowする。
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const {
    maxRetries,
    baseDelayMs,
    maxDelayMs,
    respectRetryAfter = false,
    isRetryable = isTransientError,
    onRetry,
  } = options;

  let failureCount = 0;

  while (true) {
    try {
      return await fn();
    } catch (error) {
      failureCount += 1;
      if (failureCount >= maxRetries || !isRetryable(error)) {
        throw error;
      }

      const retryAfterMs = respectRetryAfter ? extractRetryAfterMs(error) : null;
      const waitMs =
        retryAfterMs !== null
          ? Math.min(retryAfterMs, maxDelayMs)
          : computeBackoffMs(failureCount - 1, baseDelayMs, maxDelayMs);
      onRetry?.(failureCount, error, waitMs);
      await sleep(waitMs);
    }
  }
}

import { AwsClient } from "aws4fetch";
import { assertOk, withRetry } from "../utils/retry.js";

// spec.md 8章: R2アクセスは最大3回、初回1秒→上限8秒
const R2_RETRY_OPTIONS = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 8000,
};

export interface R2Config {
  accountId: string;
  /** R2用APIトークン(通常のCloudflare APIトークンとは別種。r2/api/tokens/ で発行するAccess Key ID) */
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
}

function objectUrl(config: R2Config, key: string): string {
  return `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucketName}/${key}`;
}

function r2Client(config: R2Config): AwsClient {
  return new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  });
}

/**
 * R2から指定キーのテキストを取得する。存在しない(404)場合は null。
 * 5xx/429 はリトライし、その他の非2xxは例外を投げる。
 */
export async function getR2Text(config: R2Config, key: string): Promise<string | null> {
  const client = r2Client(config);
  const url = objectUrl(config, key);
  return withRetry(async () => {
    const response = await client.fetch(url, { method: "GET" });
    if (response.status === 404) {
      return null;
    }
    assertOk(response);
    return response.text();
  }, R2_RETRY_OPTIONS);
}

/** R2へテキストをPUTする(spec.md 10章)。5xx/429 はリトライする。 */
export async function putR2Text(
  config: R2Config,
  key: string,
  body: string,
  contentType: string,
): Promise<void> {
  const client = r2Client(config);
  const url = objectUrl(config, key);
  await withRetry(async () => {
    const response = await client.fetch(url, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body,
    });
    assertOk(response);
  }, R2_RETRY_OPTIONS);
}

/**
 * R2へダイジェストのJSONペイロードをアップロードする(spec.md 10章)。
 * HTML変換はフロントエンド(Astro、ビルド時)側の責務のため、バックエンドは構造化データのみを書き込む。
 */
export async function uploadDigestJson(config: R2Config, key: string, json: string): Promise<void> {
  await putR2Text(config, key, json, "application/json; charset=utf-8");
}

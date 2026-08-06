import { AwsClient } from "aws4fetch";
import { assertOk, withRetry } from "../utils/retry.js";

// spec.md 8章: R2書き込みは最大3回、初回1秒→上限8秒
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

/**
 * R2へダイジェストのJSONペイロードをS3互換API経由でアップロードする(spec.md 10章)。
 * HTML変換はフロントエンド(Astro、ビルド時)側の責務のため、バックエンドは構造化データのみを書き込む。
 * エンドポイント形式・認証情報の仕様はCloudflare公式ドキュメントで確認済み(2026-08-02、r2/api/tokens/, r2/api/s3/api/)。
 */
export async function uploadDigestJson(config: R2Config, key: string, json: string): Promise<void> {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  });
  const url = `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucketName}/${key}`;

  await withRetry(async () => {
    const response = await client.fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: json,
    });
    assertOk(response);
  }, R2_RETRY_OPTIONS);
}

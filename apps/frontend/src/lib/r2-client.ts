import { AwsClient } from "aws4fetch";

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
}

export function readR2ConfigFromEnv(): R2Config {
  const accountId = process.env["CLOUDFLARE_ACCOUNT_ID"];
  const accessKeyId = process.env["R2_ACCESS_KEY_ID"];
  const secretAccessKey = process.env["R2_SECRET_ACCESS_KEY"];
  const bucketName = process.env["R2_BUCKET_NAME"];

  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName) {
    throw new Error(
      "R2アクセスに必要な環境変数(CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME)が設定されていません",
    );
  }

  return { accountId, accessKeyId, secretAccessKey, bucketName };
}

/**
 * R2から指定キーのオブジェクトを取得する。存在しない場合はnullを返す(spec.mdのGUIDフェイルセーフと同様、
 * ワークフロー未実行日をエラーではなく「データなし」として扱うため)。
 */
export async function getR2Object(config: R2Config, key: string): Promise<string | null> {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  });
  const url = `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucketName}/${key}`;

  const response = await client.fetch(url, { method: "GET" });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`R2からの取得に失敗しました(${key}): HTTP ${response.status} ${response.statusText}`);
  }
  return response.text();
}

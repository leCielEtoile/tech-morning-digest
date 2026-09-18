interface ReadStateRow {
  article_guid_hash: string;
}

export async function getReadArticleHashes(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT article_guid_hash FROM user_read_state WHERE user_id = ?")
    .bind(userId)
    .all<ReadStateRow>();
  return results.map((row) => row.article_guid_hash);
}

/**
 * 既読登録する。同じ記事を複数回既読にしてもエラーにならないよう`INSERT OR IGNORE`を使う
 * (user_id, article_guid_hashの複合主キーにより、既存行があれば単に無視される)。
 */
export async function markArticleRead(db: D1Database, userId: string, articleGuidHash: string): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO user_read_state (user_id, article_guid_hash, read_at) VALUES (?, ?, ?)")
    .bind(userId, articleGuidHash, new Date().toISOString())
    .run();
}

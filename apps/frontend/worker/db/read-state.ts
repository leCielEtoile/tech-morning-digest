import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { userReadState } from "./schema.js";

export async function getReadArticleHashes(db: D1Database, userId: string): Promise<string[]> {
  const orm = drizzle(db);
  const rows = await orm
    .select({ articleGuidHash: userReadState.articleGuidHash })
    .from(userReadState)
    .where(eq(userReadState.userId, userId));
  return rows.map((row) => row.articleGuidHash);
}

/**
 * 既読登録する。同じ記事を複数回既読にしてもエラーにならないよう`onConflictDoNothing`を使う
 * ((user_id, article_guid_hash)の複合主キーにより、既存行があれば単に無視される)。
 */
export async function markArticleRead(db: D1Database, userId: string, articleGuidHash: string): Promise<void> {
  const orm = drizzle(db);
  await orm
    .insert(userReadState)
    .values({ userId, articleGuidHash, readAt: new Date().toISOString() })
    .onConflictDoNothing();
}

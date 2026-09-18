export interface User {
  id: string;
  googleSub: string;
}

interface UserRow {
  id: string;
  google_sub: string;
}

async function selectUserByGoogleSub(db: D1Database, googleSub: string): Promise<User | null> {
  const row = await db
    .prepare("SELECT id, google_sub FROM users WHERE google_sub = ?")
    .bind(googleSub)
    .first<UserRow>();
  return row ? { id: row.id, googleSub: row.google_sub } : null;
}

/**
 * google_subに対応するユーザーを取得する。存在しなければ新規作成する。
 * email/display_nameは一切保存しない(データ最小化方針、docs/roadmap/account-personalization.md参照)。
 *
 * INSERT失敗時は再取得を試みる。同一google_subでの同時コールバック(二重タブ等)が
 * 起きた場合、両リクエストが「未存在」と判定してINSERTし、google_subのUNIQUE制約に
 * 一方が違反しうるため。その場合は既に他方が作成したユーザーが存在するはずなので、
 * 再取得して返す(それでも見つからなければ元のエラーを投げる)。
 */
export async function findOrCreateUserByGoogleSub(db: D1Database, googleSub: string): Promise<User> {
  const existing = await selectUserByGoogleSub(db, googleSub);
  if (existing) {
    return existing;
  }

  const id = crypto.randomUUID();
  try {
    await db
      .prepare("INSERT INTO users (id, google_sub, created_at) VALUES (?, ?, ?)")
      .bind(id, googleSub, new Date().toISOString())
      .run();
    return { id, googleSub };
  } catch (error) {
    const retried = await selectUserByGoogleSub(db, googleSub);
    if (retried) {
      return retried;
    }
    throw error;
  }
}

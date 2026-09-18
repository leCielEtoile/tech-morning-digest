import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { sessions } from "./schema.js";

export interface Session {
  id: string;
  userId: string;
  expiresAt: string;
}

export const SESSION_COOKIE_NAME = "session_id";
export const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 30;

/** 新しいセッションを作成しD1へ保存する。有効期限は作成時刻から SESSION_DURATION_MS 後。 */
export async function createSession(db: D1Database, userId: string): Promise<Session> {
  const orm = drizzle(db);
  const session: Session = {
    id: crypto.randomUUID(),
    userId,
    expiresAt: new Date(Date.now() + SESSION_DURATION_MS).toISOString(),
  };
  await orm.insert(sessions).values({ id: session.id, userId: session.userId, expiresAt: session.expiresAt });
  return session;
}

/**
 * セッションを取得する。期限切れ・存在しない場合はnullを返す(呼び出し元はどちらも
 * 「未ログイン扱い」として同じ処理をすればよいため、区別しない設計)。
 */
export async function getSession(db: D1Database, sessionId: string): Promise<Session | null> {
  const orm = drizzle(db);
  const rows = await orm.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expiresAt).getTime() <= Date.now()) return null;
  return { id: row.id, userId: row.userId, expiresAt: row.expiresAt };
}

/** ログアウト時にセッションを削除する。存在しないIDを渡してもエラーにしない。 */
export async function deleteSession(db: D1Database, sessionId: string): Promise<void> {
  const orm = drizzle(db);
  await orm.delete(sessions).where(eq(sessions.id, sessionId));
}

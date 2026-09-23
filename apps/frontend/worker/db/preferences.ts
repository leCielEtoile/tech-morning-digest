import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { userCategoryPrefs } from "./schema.js";

export interface CategoryPref {
  category: string;
  enabled: boolean;
}

export async function getCategoryPrefs(db: D1Database, userId: string): Promise<CategoryPref[]> {
  const orm = drizzle(db);
  const rows = await orm.select().from(userCategoryPrefs).where(eq(userCategoryPrefs.userId, userId));
  return rows.map((row) => ({ category: row.category, enabled: row.enabled === 1 }));
}

/** 既存の設定を全削除してから渡された内容で置き換える(単純さを優先し、差分更新はしない)。 */
export async function setCategoryPrefs(db: D1Database, userId: string, prefs: CategoryPref[]): Promise<void> {
  const orm = drizzle(db);
  const deleteStatement = orm.delete(userCategoryPrefs).where(eq(userCategoryPrefs.userId, userId));
  if (prefs.length === 0) {
    await deleteStatement;
    return;
  }
  const insertStatement = orm
    .insert(userCategoryPrefs)
    .values(prefs.map((pref) => ({ userId, category: pref.category, enabled: pref.enabled ? 1 : 0 })));
  await orm.batch([deleteStatement, insertStatement]);
}

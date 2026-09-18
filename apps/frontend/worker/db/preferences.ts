export interface CategoryPref {
  category: string;
  enabled: boolean;
}

interface CategoryPrefRow {
  category: string;
  enabled: number;
}

export async function getCategoryPrefs(db: D1Database, userId: string): Promise<CategoryPref[]> {
  const { results } = await db
    .prepare("SELECT category, enabled FROM user_category_prefs WHERE user_id = ?")
    .bind(userId)
    .all<CategoryPrefRow>();
  return results.map((row) => ({ category: row.category, enabled: row.enabled === 1 }));
}

/** 既存の設定を全削除してから渡された内容で置き換える(単純さを優先し、差分更新はしない)。 */
export async function setCategoryPrefs(db: D1Database, userId: string, prefs: CategoryPref[]): Promise<void> {
  await db.prepare("DELETE FROM user_category_prefs WHERE user_id = ?").bind(userId).run();
  if (prefs.length === 0) return;
  const statements = prefs.map((pref) =>
    db
      .prepare("INSERT INTO user_category_prefs (user_id, category, enabled) VALUES (?, ?, ?)")
      .bind(userId, pref.category, pref.enabled ? 1 : 0),
  );
  await db.batch(statements);
}

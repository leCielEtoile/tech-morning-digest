import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  googleSub: text("google_sub").notNull().unique(),
  createdAt: text("created_at").notNull(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [index("idx_sessions_user_id").on(table.userId)],
);

export const userCategoryPrefs = sqliteTable(
  "user_category_prefs",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    category: text("category").notNull(),
    enabled: integer("enabled").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.category] })],
);

export const bookmarks = sqliteTable(
  "bookmarks",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    articleLink: text("article_link").notNull(),
    articleTitle: text("article_title").notNull(),
    savedAt: text("saved_at").notNull(),
  },
  (table) => [index("idx_bookmarks_user_id").on(table.userId)],
);

export const userReadState = sqliteTable(
  "user_read_state",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    articleGuidHash: text("article_guid_hash").notNull(),
    readAt: text("read_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.articleGuidHash] })],
);

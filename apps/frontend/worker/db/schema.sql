CREATE TABLE users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);

CREATE TABLE user_category_prefs (
  user_id TEXT NOT NULL REFERENCES users(id),
  category TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  PRIMARY KEY (user_id, category)
);

CREATE TABLE bookmarks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  article_link TEXT NOT NULL,
  article_title TEXT NOT NULL,
  saved_at TEXT NOT NULL
);
CREATE INDEX idx_bookmarks_user_id ON bookmarks(user_id);

CREATE TABLE user_read_state (
  user_id TEXT NOT NULL REFERENCES users(id),
  article_guid_hash TEXT NOT NULL,
  read_at TEXT NOT NULL,
  PRIMARY KEY (user_id, article_guid_hash)
);

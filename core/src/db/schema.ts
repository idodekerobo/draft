export const HISTORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS file_versions (
  id                TEXT PRIMARY KEY,
  file_path         TEXT NOT NULL,
  content           TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  source            TEXT NOT NULL,
  author            TEXT,
  session_id        TEXT,
  published_at      TEXT,
  changes_entry_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_file_versions_path_created ON file_versions(file_path, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_versions_unpublished ON file_versions(file_path, published_at);

CREATE TABLE IF NOT EXISTS automated_rewrite_snapshots (
  id              TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  file_path       TEXT NOT NULL,
  before_content  TEXT NOT NULL,
  after_content   TEXT NOT NULL,
  source          TEXT NOT NULL,
  summary         TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE(source_event_id, file_path)
);
`;

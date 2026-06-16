export const ACTIVITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id                  TEXT PRIMARY KEY,
  profile             TEXT NOT NULL,
  source              TEXT NOT NULL,
  session_id          TEXT,
  cwd                 TEXT,
  started_at          TEXT NOT NULL,
  ended_at            TEXT,
  status              TEXT NOT NULL,
  duration_ms         INTEGER,
  proposals_generated INTEGER DEFAULT 0,
  skip_reason         TEXT,
  error_msg           TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_profile_started ON runs(profile, started_at DESC);
`;

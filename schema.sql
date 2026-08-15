CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  filecode TEXT NOT NULL UNIQUE,
  source_url TEXT NOT NULL,
  title TEXT,
  created_at INTEGER NOT NULL,
  last_resolved_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_links_filecode
ON links(filecode);

CREATE INDEX IF NOT EXISTS idx_links_created_at
ON links(created_at);

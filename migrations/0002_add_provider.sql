PRAGMA defer_foreign_keys = ON;

CREATE TABLE links_new (
  id TEXT PRIMARY KEY NOT NULL,

  provider TEXT NOT NULL
    CHECK (provider IN ('vidara', 'streamtape')),

  filecode TEXT NOT NULL,
  source_url TEXT NOT NULL,

  title TEXT,
  created_at INTEGER NOT NULL,
  last_resolved_at INTEGER,

  UNIQUE (provider, filecode)
);

INSERT INTO links_new (
  id,
  provider,
  filecode,
  source_url,
  title,
  created_at,
  last_resolved_at
)
SELECT
  id,
  'vidara',
  filecode,
  source_url,
  title,
  created_at,
  last_resolved_at
FROM links;

DROP TABLE links;

ALTER TABLE links_new RENAME TO links;

CREATE INDEX IF NOT EXISTS idx_links_provider_filecode
ON links(provider, filecode);

CREATE INDEX IF NOT EXISTS idx_links_created_at
ON links(created_at);

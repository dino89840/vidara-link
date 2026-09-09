CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY NOT NULL,

  provider TEXT NOT NULL
    CHECK (
      provider IN (
        'vidara',
        'streamtape',
        'turbovids',
        'loadvid'
      )
    ),

  filecode TEXT NOT NULL,
  source_url TEXT NOT NULL,

  title TEXT,
  created_at INTEGER NOT NULL,
  last_resolved_at INTEGER,

  UNIQUE (provider, filecode)
);

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_links_provider_filecode
ON links(provider, filecode);

CREATE INDEX IF NOT EXISTS
  idx_links_created_at
ON links(created_at);

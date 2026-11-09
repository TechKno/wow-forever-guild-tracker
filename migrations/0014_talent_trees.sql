CREATE TABLE talent_cache(
  cache_key TEXT PRIMARY KEY,
  data TEXT,
  observed_at TEXT,
  attempted_at TEXT,
  next_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT
);

CREATE TABLE roster_imports(
  generation TEXT PRIMARY KEY,
  observed_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK(duration_ms>=0),
  member_count INTEGER NOT NULL CHECK(member_count>=0),
  joined INTEGER NOT NULL CHECK(joined>=0),
  departed INTEGER NOT NULL CHECK(departed>=0),
  level_changes INTEGER NOT NULL CHECK(level_changes>=0),
  rank_changes INTEGER NOT NULL CHECK(rank_changes>=0),
  baseline INTEGER NOT NULL CHECK(baseline IN (0,1))
);
CREATE INDEX roster_imports_completed ON roster_imports(completed_at DESC);

-- A returned roster departure overrides older individual-profile membership
-- evidence until a later validated roster includes this identity again.
CREATE TABLE membership_departures(
  character_id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  observed_at TEXT NOT NULL
);

CREATE TABLE character_refresh(
  character_id INTEGER PRIMARY KEY,
  next_at INTEGER NOT NULL DEFAULT 0,
  last_attempt TEXT,
  last_result TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  last_detail_login INTEGER,
  details_level INTEGER
);
CREATE INDEX character_refresh_due ON character_refresh(next_at,character_id);
INSERT INTO character_refresh(character_id)
  SELECT character_id FROM membership WHERE generation=(SELECT published FROM sync WHERE id=1);
-- Preserve the published roster and all observations. Retire the old serial cycle.
UPDATE sync SET phase='roster',cursor=0,next_at=0,errors=0 WHERE id=1;

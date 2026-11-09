CREATE TABLE character_role_preferences (
  character_id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  tank INTEGER NOT NULL DEFAULT 0 CHECK(tank IN (0,1)),
  healer INTEGER NOT NULL DEFAULT 0 CHECK(healer IN (0,1)),
  damage INTEGER NOT NULL DEFAULT 0 CHECK(damage IN (0,1)),
  primary_role TEXT CHECK(primary_role IN ('Tank','Healer','Damage')),
  updated_at TEXT NOT NULL,
  CHECK(CASE WHEN tank+healer+damage=0 THEN primary_role IS NULL ELSE
    primary_role IS NOT NULL AND ((primary_role='Tank' AND tank=1) OR
    (primary_role='Healer' AND healer=1) OR
    (primary_role='Damage' AND damage=1)) END)
);
CREATE INDEX character_role_preferences_user ON character_role_preferences(user_id);

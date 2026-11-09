CREATE TABLE discord_profiles(
  guild_id TEXT NOT NULL,
  discord_id TEXT NOT NULL,
  nickname TEXT,
  global_name TEXT,
  username TEXT,
  observed_at TEXT,
  attempted_at TEXT,
  next_at INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  PRIMARY KEY(guild_id,discord_id)
);
CREATE INDEX discord_profiles_due ON discord_profiles(guild_id,next_at);

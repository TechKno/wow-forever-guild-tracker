ALTER TABLE requests ADD COLUMN recipient_name TEXT;
CREATE TABLE discord_craft_posts(
  request_id TEXT PRIMARY KEY REFERENCES requests(id),
  guild_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT UNIQUE,
  recipient_name TEXT NOT NULL,
  posted_at TEXT,
  create_attempted_at TEXT,
  reactions_initialized INTEGER NOT NULL DEFAULT 0,
  last_hash TEXT,
  next_poll_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  publish_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX discord_craft_due ON discord_craft_posts(next_poll_at,lease_until);

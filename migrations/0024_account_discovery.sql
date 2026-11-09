CREATE TABLE account_character_ownership(
  character_id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  checked_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX account_character_ownership_user ON account_character_ownership(user_id);
CREATE INDEX account_character_ownership_expiry ON account_character_ownership(expires_at);
ALTER TABLE account_refresh ADD COLUMN requested_revision TEXT;
ALTER TABLE account_refresh ADD COLUMN checked_revision TEXT;

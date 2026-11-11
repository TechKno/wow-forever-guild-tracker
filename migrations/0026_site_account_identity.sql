CREATE TABLE site_battlenet_identities (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT UNIQUE,
  recovery_pending INTEGER NOT NULL DEFAULT 0
);

INSERT INTO site_battlenet_identities(user_id,recovery_pending)
SELECT a.user_id,1 FROM account_refresh a
WHERE a.encrypted_credential IS NOT NULL AND a.expires_at>unixepoch()
  AND EXISTS(SELECT 1 FROM sessions s WHERE s.user_id=a.user_id AND s.expires>unixepoch());

CREATE TABLE site_sign_in_history (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  signed_in_at INTEGER NOT NULL
);
CREATE INDEX site_sign_in_history_account ON site_sign_in_history(user_id,signed_in_at DESC);
CREATE INDEX site_sign_in_history_time ON site_sign_in_history(signed_in_at);

INSERT INTO site_sign_in_history(user_id,signed_in_at)
SELECT user_id,signed_in_at FROM site_last_sign_in WHERE signed_in_at>=unixepoch()-90*86400;

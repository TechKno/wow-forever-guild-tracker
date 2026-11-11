ALTER TABLE site_battlenet_identities ADD COLUMN battle_tag TEXT;

INSERT INTO site_battlenet_identities(user_id,recovery_pending)
SELECT a.user_id,1 FROM account_refresh a
WHERE a.encrypted_credential IS NOT NULL AND a.expires_at>unixepoch()
  AND EXISTS(SELECT 1 FROM sessions s WHERE s.user_id=a.user_id AND s.expires>unixepoch())
ON CONFLICT(user_id) DO UPDATE SET recovery_pending=1
WHERE site_battlenet_identities.battle_tag IS NULL;

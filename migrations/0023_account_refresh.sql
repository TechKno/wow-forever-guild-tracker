CREATE TABLE account_refresh(
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  encrypted_credential TEXT,
  expires_at INTEGER NOT NULL,
  next_at INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  checked_at TEXT,
  last_error TEXT,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX account_refresh_due ON account_refresh(next_at,lease_until);

-- This row lives only inside the successful ownership-update transaction.
-- Reject a result from a replaced token, a logged-out session, an expired lease,
-- or an account whose main/alt choices changed while the provider was queried.
CREATE TABLE account_refresh_guards(
  lease_token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  encrypted_credential TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  subject_hash TEXT NOT NULL,
  user_updated_at TEXT NOT NULL,
  ownership_checked INTEGER NOT NULL,
  requested_revision TEXT NOT NULL
);
CREATE TRIGGER account_refresh_guard_current BEFORE INSERT ON account_refresh_guards
BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM account_refresh a JOIN users u ON u.id=a.user_id
    WHERE a.user_id=NEW.user_id AND a.encrypted_credential=NEW.encrypted_credential
      AND a.lease_token=NEW.lease_token AND a.lease_until>unixepoch()
      AND a.expires_at=NEW.expires_at AND a.expires_at>unixepoch()
      AND a.requested_revision=NEW.requested_revision
      AND u.subject_hash=NEW.subject_hash AND u.updated_at=NEW.user_updated_at
      AND u.ownership_checked=NEW.ownership_checked AND u.ownership_status='verified'
      AND EXISTS(SELECT 1 FROM sessions s WHERE s.user_id=u.id AND s.expires>unixepoch())
  ) THEN RAISE(ABORT,'Account refresh is no longer current') END;
END;

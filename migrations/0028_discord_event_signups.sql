ALTER TABLE discord_events ADD COLUMN signup_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE discord_events ADD COLUMN synced_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE discord_events ADD COLUMN signup_retry_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE discord_events ADD COLUMN signup_lease_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE discord_events ADD COLUMN signup_sync_error TEXT;

CREATE TRIGGER discord_event_signup_insert AFTER INSERT ON event_signups
BEGIN
  UPDATE discord_events SET signup_revision=signup_revision+1 WHERE event_id=NEW.event_id;
END;

CREATE TRIGGER discord_event_signup_update AFTER UPDATE OF character_id,role ON event_signups
WHEN OLD.character_id<>NEW.character_id OR OLD.role<>NEW.role
BEGIN
  UPDATE discord_events SET signup_revision=signup_revision+1 WHERE event_id=NEW.event_id;
END;

CREATE TRIGGER discord_event_signup_delete AFTER DELETE ON event_signups
BEGIN
  UPDATE discord_events SET signup_revision=signup_revision+1 WHERE event_id=OLD.event_id;
END;

CREATE TRIGGER discord_event_announcement_insert AFTER INSERT ON discord_event_posts
BEGIN
  UPDATE discord_events SET signup_revision=signup_revision+1 WHERE event_id=NEW.event_id;
END;

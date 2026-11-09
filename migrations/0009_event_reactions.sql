ALTER TABLE events ADD COLUMN role_limits_json TEXT;
ALTER TABLE event_signups ADD COLUMN source TEXT NOT NULL DEFAULT 'web';
CREATE TABLE discord_event_posts(event_id TEXT PRIMARY KEY REFERENCES events(id),channel_id TEXT NOT NULL,message_id TEXT NOT NULL UNIQUE,reactions_initialized INTEGER NOT NULL DEFAULT 0,last_hash TEXT,next_poll_at INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,last_error TEXT);
CREATE TABLE discord_event_reactions(event_id TEXT NOT NULL REFERENCES events(id),discord_id TEXT NOT NULL,signature TEXT NOT NULL,user_id TEXT,handled INTEGER NOT NULL DEFAULT 0,result TEXT NOT NULL,display_name TEXT NOT NULL,first_seen INTEGER NOT NULL,last_seen INTEGER NOT NULL,PRIMARY KEY(event_id,discord_id));

CREATE TABLE api_cache(key TEXT PRIMARY KEY,data TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE discord_links(user_id TEXT PRIMARY KEY REFERENCES users(id),discord_id TEXT NOT NULL UNIQUE,requester_dm INTEGER NOT NULL DEFAULT 0,crafter_dm INTEGER NOT NULL DEFAULT 0,linked_at TEXT NOT NULL);
CREATE TABLE discord_states(state_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),session_hash TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE discord_outbox(id TEXT PRIMARY KEY,kind TEXT NOT NULL,reference_id TEXT NOT NULL,user_id TEXT,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,last_error TEXT,created_at TEXT NOT NULL);
CREATE INDEX discord_pending ON discord_outbox(status,next_at);
CREATE TABLE discord_events(event_id TEXT PRIMARY KEY REFERENCES events(id),discord_id TEXT NOT NULL UNIQUE);
ALTER TABLE events ADD COLUMN duration_minutes INTEGER NOT NULL DEFAULT 120;

CREATE TABLE admin_discord_mappings(character_id INTEGER PRIMARY KEY,discord_id TEXT NOT NULL,participant_user_id TEXT NOT NULL REFERENCES users(id),preferred INTEGER NOT NULL DEFAULT 0,crafter_dm INTEGER NOT NULL DEFAULT 0,mapped_by TEXT NOT NULL REFERENCES users(id),updated_at TEXT NOT NULL);
CREATE INDEX admin_discord_user ON admin_discord_mappings(discord_id);
CREATE TABLE discord_crafter_optouts(discord_id TEXT PRIMARY KEY,created_at TEXT NOT NULL);
CREATE TABLE admin_mapping_audit(id TEXT PRIMARY KEY,admin_id TEXT NOT NULL,character_id INTEGER NOT NULL,discord_id TEXT NOT NULL,action TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE UNIQUE INDEX event_character_once ON event_signups(event_id,character_id);

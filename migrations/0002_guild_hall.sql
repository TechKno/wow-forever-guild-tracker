CREATE TABLE users(id TEXT PRIMARY KEY, subject_hash TEXT NOT NULL UNIQUE, main_character_id INTEGER,
  ownership_status TEXT NOT NULL DEFAULT 'unavailable', ownership_checked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE character_links(character_id INTEGER PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), verified_at TEXT NOT NULL);
CREATE INDEX character_links_user ON character_links(user_id);
CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE INDEX sessions_expiry ON sessions(expires);
CREATE TABLE oauth_states(state_hash TEXT PRIMARY KEY, binding_hash TEXT NOT NULL, verifier TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE character_profiles(character_id INTEGER PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL DEFAULT '', biography TEXT NOT NULL DEFAULT '', looking_for TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
CREATE TABLE requests(id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('craft','learn')), owner_id TEXT NOT NULL REFERENCES users(id),
  character_id INTEGER NOT NULL, recipe_id INTEGER, item_name TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1,
  materials TEXT NOT NULL DEFAULT 'discuss', notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open',
  crafter_id TEXT REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX requests_kind ON requests(kind,status,created_at);
CREATE TABLE events(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), character_id INTEGER NOT NULL,
  title TEXT NOT NULL, kind TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
  starts_at TEXT NOT NULL, capacity INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL);
CREATE INDEX events_start ON events(starts_at);
CREATE TABLE event_signups(event_id TEXT NOT NULL REFERENCES events(id), user_id TEXT NOT NULL REFERENCES users(id),
  character_id INTEGER NOT NULL, role TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, PRIMARY KEY(event_id,user_id));
CREATE TABLE snapshots(character_id INTEGER NOT NULL, observed_at TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(character_id,observed_at));
CREATE INDEX snapshots_time ON snapshots(observed_at);
CREATE TABLE activity(id TEXT PRIMARY KEY, character_id INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '', observed_at TEXT NOT NULL);
CREATE INDEX activity_time ON activity(observed_at);
INSERT OR IGNORE INTO snapshots(character_id,observed_at,data)
SELECT id,updated,json_object('level',json_extract(data,'$.profile.level'),'professions',json(COALESCE(json_extract(data,'$.professions'),'[]')))
FROM characters WHERE json_extract(data,'$.profile_status')='verified';

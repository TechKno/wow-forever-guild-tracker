CREATE TABLE state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE sync(id INTEGER PRIMARY KEY CHECK(id=1), phase TEXT NOT NULL DEFAULT 'roster', cursor INTEGER NOT NULL DEFAULT 0,
  generation TEXT, published TEXT, next_at INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'waiting', message TEXT NOT NULL DEFAULT 'Waiting for Battle.net credentials',
  updated TEXT, roster_at TEXT, completed_at TEXT, total INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0);
INSERT INTO sync(id) VALUES(1);
CREATE TABLE membership(generation TEXT NOT NULL, slug TEXT NOT NULL, character_id INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(generation,slug));
CREATE INDEX membership_character ON membership(character_id);
CREATE TABLE characters(id INTEGER PRIMARY KEY, data TEXT NOT NULL, updated TEXT NOT NULL);
CREATE TABLE evidence(path TEXT PRIMARY KEY, namespace TEXT NOT NULL, attempted TEXT NOT NULL, succeeded TEXT, status TEXT NOT NULL, detail TEXT NOT NULL);

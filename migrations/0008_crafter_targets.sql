ALTER TABLE requests ADD COLUMN recipient_mode TEXT NOT NULL DEFAULT 'legacy';
CREATE TABLE request_targets(request_id TEXT NOT NULL REFERENCES requests(id),character_id INTEGER NOT NULL,PRIMARY KEY(request_id,character_id));

CREATE TABLE recipe_details(id INTEGER PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL);
ALTER TABLE requests ADD COLUMN materials_json TEXT;

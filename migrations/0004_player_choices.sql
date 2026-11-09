ALTER TABLE character_links ADD COLUMN show_as_alt INTEGER NOT NULL DEFAULT 1 CHECK(show_as_alt IN (0,1));

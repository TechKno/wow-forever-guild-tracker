CREATE TABLE gallery_photos(
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES users(id),
  author_name TEXT NOT NULL,
  title TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 1600),
  height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 1600),
  image BLOB NOT NULL,
  thumbnail BLOB NOT NULL,
  byte_size INTEGER NOT NULL CHECK(byte_size BETWEEN 1 AND 810000),
  removed_at TEXT
);
CREATE INDEX gallery_photos_visible ON gallery_photos(removed_at,created_at DESC,id DESC);
CREATE INDEX gallery_photos_author ON gallery_photos(author_id,created_at DESC,id DESC);

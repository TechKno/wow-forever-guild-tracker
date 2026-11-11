CREATE TABLE site_last_sign_in(
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  signed_in_at INTEGER NOT NULL,
  recovered INTEGER NOT NULL DEFAULT 0
);

-- Existing sessions were issued with a fixed, non-renewing 24-hour lifetime.
INSERT INTO site_last_sign_in(user_id,signed_in_at,recovered)
SELECT s.user_id,MAX(s.expires)-86400,1
FROM sessions s JOIN users u ON u.id=s.user_id
WHERE u.ownership_status<>'admin_mapped'
  AND s.expires<=unixepoch()+86460
  AND s.expires-86400>=unixepoch(u.created_at)
GROUP BY s.user_id;

CREATE TABLE site_daily_traffic(
  day TEXT PRIMARY KEY,
  welcome_views INTEGER NOT NULL DEFAULT 0,
  guild_views INTEGER NOT NULL DEFAULT 0,
  sign_ins INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO state(key,value)
VALUES('site_analytics_started_at',json_quote(strftime('%Y-%m-%dT%H:%M:%fZ','now')));

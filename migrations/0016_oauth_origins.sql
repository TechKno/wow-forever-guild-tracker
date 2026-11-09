-- In-flight states created before this migration belong to the original workers.dev site.
-- New states pin the exact approved origin that initiated the authorization flow.
ALTER TABLE oauth_states ADD COLUMN origin TEXT;
ALTER TABLE discord_states ADD COLUMN origin TEXT;

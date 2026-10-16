-- Up Migration

-- Keyword search matches any substring, the way an editor's find does, not
-- only whole full-text tokens: "LSM6DSV" must find "LSM6DSV16X". ILIKE over
-- 50 MB of note bodies scans for over a second; a trigram GIN index brings
-- it to milliseconds for any query of three characters or more.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS vault_files_body_trgm_idx
  ON vault_files USING gin (body gin_trgm_ops);
CREATE INDEX IF NOT EXISTS vault_files_title_trgm_idx
  ON vault_files USING gin (coalesce(title, name) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS discord_messages_content_trgm_idx
  ON discord_messages USING gin (content gin_trgm_ops);

-- Down Migration

DROP INDEX IF EXISTS discord_messages_content_trgm_idx;
DROP INDEX IF EXISTS vault_files_title_trgm_idx;
DROP INDEX IF EXISTS vault_files_body_trgm_idx;

-- Up Migration
-- Nullable metadata only. Historical raw bodies are never rewritten by a migration.
ALTER TABLE archive_messages ADD COLUMN IF NOT EXISTS file_observation jsonb;
COMMENT ON COLUMN archive_messages.file_observation IS
  'Validated body-free file observation metadata; ownership unknown. Legacy reported captures are observations, never verified transitions.';
COMMENT ON COLUMN archive_messages.change_evidence IS
  'Legacy reported capture metadata, retained for compatibility. Does not establish transition ownership.';
CREATE INDEX IF NOT EXISTS archive_messages_file_observation_idx ON archive_messages(session_id, seq, id)
WHERE file_observation IS NOT NULL;

-- Down Migration
DROP INDEX IF EXISTS archive_messages_file_observation_idx;
ALTER TABLE archive_messages DROP COLUMN IF EXISTS file_observation;

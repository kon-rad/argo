-- Up Migration
ALTER TABLE collection_attempts ADD COLUMN backlog_unit text CHECK (backlog_unit IN ('bytes','records'));
ALTER TABLE collection_streams ADD COLUMN backlog_unit text CHECK (backlog_unit IN ('bytes','records'));
ALTER TABLE usage_import_quarantine ADD COLUMN origin_path text;
CREATE INDEX usage_import_quarantine_path ON usage_import_quarantine(host,origin_path);
CREATE SEQUENCE collection_attempt_sequence;
-- Down Migration
ALTER TABLE usage_import_quarantine DROP COLUMN origin_path;
DROP SEQUENCE collection_attempt_sequence;
ALTER TABLE collection_streams DROP COLUMN backlog_unit;
ALTER TABLE collection_attempts DROP COLUMN backlog_unit;

-- Up Migration

-- Derived fields can be rebuilt without altering source identity or token rows.
ALTER TABLE archive_messages ADD COLUMN result_parser_version integer;

-- Down Migration
-- Forward only.

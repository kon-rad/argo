-- Up Migration

-- The data addon (docs/data.md). The engine ships no use-case tables: a vault
-- creates its own in schema "data" through its own SQL files, applied by
-- `secondbrain data migrate` and recorded here. Connector runs reuse sources
-- (kind 'data-connector') and ingest_runs.

CREATE SCHEMA IF NOT EXISTS data;

CREATE TABLE data_migrations (
  name        text        PRIMARY KEY,   -- the vault file name, e.g. 0001_instagram.sql
  checksum    text        NOT NULL,      -- sha256 of the file when applied; an edit afterwards is refused
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- Agents read the vault's tables through sb_org, like the rest of the app.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sb_org') THEN
    GRANT USAGE ON SCHEMA data TO sb_org;
    ALTER DEFAULT PRIVILEGES IN SCHEMA data GRANT SELECT ON TABLES TO sb_org;
  END IF;
END $$;

-- Down Migration

DROP TABLE data_migrations;
DROP SCHEMA data CASCADE;

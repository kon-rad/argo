-- Up Migration

-- Agent archive (Projects/secondbrain-app/agent-archive-spec.md). B2 holds the
-- raw originals; these tables are the searchable copy and can be rebuilt from it.

-- Manifest of every source file seen: drives incremental upload and ingest.
CREATE TABLE archive_files (
  id             bigserial PRIMARY KEY,
  source         text NOT NULL,
  host           text NOT NULL CHECK (host IN ('mac', 'droplet')),
  local_path     text NOT NULL,
  size_bytes     bigint NOT NULL,
  mtime_ms       bigint NOT NULL,
  sha256         text NOT NULL,
  fingerprint    text,
  b2_path        text,
  staged_at      timestamptz,
  uploaded_at    timestamptz,
  uploaded_size  bigint,
  ingested_bytes bigint NOT NULL DEFAULT 0,
  ingested_lines int NOT NULL DEFAULT 0,
  ingested_at    timestamptz,
  UNIQUE (source, host, local_path)
);

CREATE TABLE archive_sessions (
  id                 bigserial PRIMARY KEY,
  source             text NOT NULL,
  host               text NOT NULL CHECK (host IN ('mac', 'droplet')),
  external_id        text NOT NULL,
  parent_external_id text,
  project            text,
  title              text,
  model              text,
  started_at         timestamptz,
  ended_at           timestamptz,
  message_count      int NOT NULL DEFAULT 0,
  input_tokens       bigint,
  output_tokens      bigint,
  cost_usd           real,
  meta               jsonb NOT NULL DEFAULT '{}',
  b2_path            text,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, host, external_id)
);
CREATE INDEX archive_sessions_started_idx ON archive_sessions (started_at);

CREATE TABLE archive_messages (
  id                 bigserial PRIMARY KEY,
  session_id         bigint NOT NULL REFERENCES archive_sessions (id) ON DELETE CASCADE,
  seq                int NOT NULL,
  external_id        text NOT NULL,
  parent_external_id text,
  role               text NOT NULL,
  kind               text NOT NULL,
  ts                 timestamptz,
  content_text       text,
  raw                jsonb NOT NULL,
  raw_sha            text NOT NULL,
  is_sidechain       boolean NOT NULL DEFAULT false,
  -- tsvector caps at 1 MB; 100k chars keeps huge tool outputs from failing the insert.
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', left(coalesce(content_text, ''), 100000))) STORED,
  UNIQUE (session_id, external_id)
);
CREATE INDEX archive_messages_tsv_idx ON archive_messages USING gin (tsv);
CREATE INDEX archive_messages_seq_idx ON archive_messages (session_id, seq);
CREATE INDEX archive_messages_ts_idx ON archive_messages (ts);

CREATE TABLE archive_log_lines (
  id          bigserial PRIMARY KEY,
  host        text NOT NULL CHECK (host IN ('mac', 'droplet')),
  file        text NOT NULL,
  fingerprint text NOT NULL,
  byte_offset bigint NOT NULL,
  ts          timestamptz,
  level       text,
  message     text NOT NULL,
  UNIQUE (host, file, fingerprint, byte_offset)
);
CREATE INDEX archive_log_lines_ts_idx ON archive_log_lines (ts);

CREATE TABLE archive_memory_versions (
  id          bigserial PRIMARY KEY,
  source      text NOT NULL,
  host        text NOT NULL CHECK (host IN ('mac', 'droplet')),
  path        text NOT NULL,
  content     text NOT NULL,
  sha256      text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, host, path, sha256)
);

-- Down Migration

DROP TABLE IF EXISTS archive_memory_versions;
DROP TABLE IF EXISTS archive_log_lines;
DROP TABLE IF EXISTS archive_messages;
DROP TABLE IF EXISTS archive_sessions;
DROP TABLE IF EXISTS archive_files;

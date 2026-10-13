-- Up Migration

CREATE TABLE sources (
  id          serial PRIMARY KEY,
  kind        text NOT NULL,
  name        text NOT NULL,
  config      jsonb NOT NULL DEFAULT '{}',
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, name)
);

CREATE TABLE ingest_runs (
  id           serial PRIMARY KEY,
  source_id    integer NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  status       text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  stats        jsonb NOT NULL DEFAULT '{}',
  progress     jsonb NOT NULL DEFAULT '{}',
  error        text
);
CREATE INDEX ingest_runs_source_started_idx ON ingest_runs (source_id, started_at DESC);

-- ---------------------------------------------------------------- vault index

CREATE TABLE vault_files (
  id            serial PRIMARY KEY,
  path          text NOT NULL UNIQUE,
  parent_path   text NOT NULL,
  name          text NOT NULL,
  title         text,
  ext           text NOT NULL,
  is_markdown   boolean NOT NULL,
  size_bytes    bigint NOT NULL,
  mtime         timestamptz NOT NULL,
  content_hash  text NOT NULL,
  frontmatter   jsonb,
  body          text,
  indexed_at    timestamptz NOT NULL DEFAULT now(),
  tsv           tsvector GENERATED ALWAYS AS (
                  setweight(to_tsvector('english', coalesce(title, name)), 'A') ||
                  setweight(to_tsvector('english', coalesce(body, '')), 'B')
                ) STORED
);
CREATE INDEX vault_files_tsv_idx ON vault_files USING GIN (tsv);
CREATE INDEX vault_files_parent_idx ON vault_files (parent_path, name);
CREATE INDEX vault_files_hash_idx ON vault_files (content_hash);
CREATE INDEX vault_files_name_idx ON vault_files (lower(name));

CREATE TABLE vault_links (
  id             serial PRIMARY KEY,
  from_file_id   integer NOT NULL REFERENCES vault_files(id) ON DELETE CASCADE,
  target_raw     text NOT NULL,
  target_file_id integer REFERENCES vault_files(id) ON DELETE SET NULL,
  alias          text
);
CREATE INDEX vault_links_from_idx ON vault_links (from_file_id);
CREATE INDEX vault_links_target_idx ON vault_links (target_file_id);

CREATE TABLE vault_tags (
  file_id integer NOT NULL REFERENCES vault_files(id) ON DELETE CASCADE,
  tag     text NOT NULL,
  PRIMARY KEY (file_id, tag)
);
CREATE INDEX vault_tags_tag_idx ON vault_tags (tag);

-- ------------------------------------------------- discord archive (phase 2)
-- Ships in v1 so the search view and connector interface are complete.
-- Snowflake IDs are text, never bigint: they exceed JS's safe integer range.

CREATE TABLE discord_guilds (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  icon       text,
  raw        jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE discord_channels (
  id                      text PRIMARY KEY,
  guild_id                text REFERENCES discord_guilds(id) ON DELETE CASCADE,
  name                    text NOT NULL,
  type                    integer NOT NULL,
  parent_id               text,
  topic                   text,
  sync_enabled            boolean NOT NULL DEFAULT false,
  last_synced_message_id  text,
  last_synced_at          timestamptz,
  raw                     jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX discord_channels_guild_idx ON discord_channels (guild_id);

CREATE TABLE discord_authors (
  id           text PRIMARY KEY,
  username     text NOT NULL,
  global_name  text,
  display_name text,
  avatar       text,
  is_bot       boolean NOT NULL DEFAULT false,
  raw          jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE discord_messages (
  id           text PRIMARY KEY,
  channel_id   text NOT NULL REFERENCES discord_channels(id) ON DELETE CASCADE,
  author_id    text REFERENCES discord_authors(id) ON DELETE SET NULL,
  content      text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL,
  edited_at    timestamptz,
  reply_to_id  text,
  thread_id    text,
  pinned       boolean NOT NULL DEFAULT false,
  deleted_at   timestamptz,
  raw          jsonb NOT NULL DEFAULT '{}',
  tsv          tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED
);
CREATE INDEX discord_messages_tsv_idx ON discord_messages USING GIN (tsv);
CREATE INDEX discord_messages_channel_created_idx ON discord_messages (channel_id, created_at DESC);
CREATE INDEX discord_messages_thread_idx ON discord_messages (thread_id);

CREATE TABLE discord_message_versions (
  id          serial PRIMARY KEY,
  message_id  text NOT NULL REFERENCES discord_messages(id) ON DELETE CASCADE,
  content     text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  raw         jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX discord_message_versions_msg_idx ON discord_message_versions (message_id, captured_at DESC);

CREATE TABLE discord_attachments (
  id          text PRIMARY KEY,
  message_id  text NOT NULL REFERENCES discord_messages(id) ON DELETE CASCADE,
  filename    text NOT NULL,
  url         text NOT NULL,
  content_type text,
  size_bytes  bigint,
  local_path  text,
  raw         jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX discord_attachments_msg_idx ON discord_attachments (message_id);

CREATE TABLE discord_embeds (
  id          serial PRIMARY KEY,
  message_id  text NOT NULL REFERENCES discord_messages(id) ON DELETE CASCADE,
  type        text,
  title       text,
  description text,
  url         text,
  raw         jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX discord_embeds_msg_idx ON discord_embeds (message_id);

CREATE TABLE discord_reactions (
  message_id text NOT NULL REFERENCES discord_messages(id) ON DELETE CASCADE,
  emoji      text NOT NULL,
  count      integer NOT NULL DEFAULT 0,
  raw        jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (message_id, emoji)
);

-- ------------------------------------------------------------- unified search

CREATE VIEW search_documents AS
  SELECT 'vault'::text AS source_kind,
         id::text       AS ref_id,
         path           AS ref_path,
         coalesce(title, name) AS title,
         body           AS content,
         tsv,
         mtime          AS occurred_at
  FROM vault_files
  WHERE is_markdown
UNION ALL
  SELECT 'discord'::text,
         id,
         channel_id,
         NULL,
         content,
         tsv,
         created_at
  FROM discord_messages
  WHERE deleted_at IS NULL;

INSERT INTO sources (kind, name, config) VALUES
  ('vault', 'Vault', '{"skip_dirs": ["app","node_modules",".git",".venv","venv",".obsidian",".parked-agent","__pycache__",".next","dist","build",".cache"]}');

-- Down Migration

DROP VIEW IF EXISTS search_documents;
DROP TABLE IF EXISTS discord_reactions, discord_embeds, discord_attachments,
                     discord_message_versions, discord_messages, discord_authors,
                     discord_channels, discord_guilds;
DROP TABLE IF EXISTS vault_tags, vault_links, vault_files;
DROP TABLE IF EXISTS ingest_runs, sources;

-- db/migrations/1756000013500_local-ai.sql
-- Up Migration

-- Local model usage: a home model host (Ollama, a speech server) logs every call through a
-- logging gateway into its own database and serves the rows at /api/export in change order.
-- `local-ai-pull` copies them here so local and cloud use live in one place. One host may run
-- the gateway; every row is keyed by the usage_hosts slug it came from. Read-only to the app.

-- One row per model call through the gateway.
CREATE TABLE local_ai_runs (
  host               text NOT NULL REFERENCES usage_hosts(slug) ON UPDATE CASCADE,
  id                 uuid NOT NULL,
  started_at         timestamptz NOT NULL,
  ended_at           timestamptz,
  state              text NOT NULL,              -- running | ok | error | cancelled
  service            text NOT NULL,              -- ollama | tts
  route              text NOT NULL,
  http_status        int,
  model              text,
  model_digest       text,
  stream             boolean,
  options            jsonb,
  request_meta       jsonb,                      -- the request body with every text replaced by a count
  tool_names         text[],
  message_count      int,
  image_count        int,
  caller_label       text,                       -- X-Argo-Caller-style header: agent/role
  caller_node        text,
  caller_process     text,
  user_agent         text,
  prompt_tokens      int,
  cached_tokens      int,
  output_tokens      int,
  embed_count        int,
  ttft_ms            int,
  total_ms           int,
  load_ms            int,
  prompt_eval_ms     int,
  eval_ms            int,
  prompt_tps         real,
  output_tps         real,
  done_reason        text,
  cold_start         boolean,
  input_chars        int,
  output_chars       int,
  audio_seconds      real,
  voice              text,
  gpu_avg_w          real,
  package_avg_w      real,
  energy_j           real,
  error              text,
  source_seq         bigint NOT NULL,            -- the host's change_seq, for the pull cursor
  pulled_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (host, id)
);
CREATE INDEX local_ai_runs_started_idx ON local_ai_runs (started_at);
CREATE INDEX local_ai_runs_caller_idx ON local_ai_runs (caller_label, started_at);

-- Every distinct text (prompt, message, response, reasoning, tool schema), once by hash.
CREATE TABLE local_ai_texts (
  host        text NOT NULL REFERENCES usage_hosts(slug) ON UPDATE CASCADE,
  sha256      text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content     text NOT NULL,
  chars       int NOT NULL,
  first_seen  timestamptz NOT NULL,
  source_seq  bigint NOT NULL,
  PRIMARY KEY (host, sha256)
);

-- Which texts a run used, in order. No foreign keys to the two tables above: the pull copies
-- each table on its own cursor, so a link can arrive before its run or its text.
CREATE TABLE local_ai_run_texts (
  host        text NOT NULL REFERENCES usage_hosts(slug) ON UPDATE CASCADE,
  run_id      uuid NOT NULL,
  seq         int NOT NULL,
  role        text NOT NULL,
  kind        text NOT NULL,
  text_sha256 text NOT NULL,
  source_seq  bigint NOT NULL,
  PRIMARY KEY (host, run_id, seq)
);

CREATE TABLE local_models (
  host        text NOT NULL REFERENCES usage_hosts(slug) ON UPDATE CASCADE,
  name        text NOT NULL,
  digest      text,
  family      text,
  param_size  text,
  quant       text,
  format      text,
  size_bytes  bigint,
  modified_at timestamptz,
  first_seen  timestamptz,
  last_seen   timestamptz,
  removed_at  timestamptz,
  source_seq  bigint NOT NULL,
  PRIMARY KEY (host, name)
);

CREATE TABLE local_model_loads (
  host           text NOT NULL REFERENCES usage_hosts(slug) ON UPDATE CASCADE,
  id             bigint NOT NULL,
  model          text NOT NULL,
  digest         text,
  loaded_at      timestamptz NOT NULL,
  unloaded_at    timestamptz,
  size_bytes     bigint,
  size_vram      bigint,
  context_length int,
  runner         text,
  quant          text,
  source_seq     bigint NOT NULL,
  PRIMARY KEY (host, id)
);

-- One cursor per host and table: the highest change_seq copied so far.
CREATE TABLE local_ai_cursors (
  host        text NOT NULL REFERENCES usage_hosts(slug) ON UPDATE CASCADE,
  tbl         text NOT NULL CHECK (tbl IN ('ai_runs', 'ai_texts', 'ai_run_texts', 'models', 'model_loads')),
  after_seq   bigint NOT NULL DEFAULT 0,
  rows_total  bigint NOT NULL DEFAULT 0,
  last_ok_at  timestamptz,
  last_error  text,
  last_try_at timestamptz,
  PRIMARY KEY (host, tbl)
);

-- Down Migration

DROP TABLE local_ai_cursors;
DROP TABLE local_model_loads;
DROP TABLE local_models;
DROP TABLE local_ai_run_texts;
DROP TABLE local_ai_texts;
DROP TABLE local_ai_runs;

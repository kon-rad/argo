-- db/migrations/1756000012000_usage.sql
-- Up Migration

-- The usage ledger (Projects/secondbrain-app/usage-ledger-plan.md). Every row is rebuilt
-- from files: Claude Code transcripts, cc-runs stream-json logs, Hermes state.db and the
-- plan-usage log the status-line wrapper writes. Nothing here exists only in Postgres.

-- One row per model API response. Claude Code repeats a response's usage on every
-- content-block line; the parser keeps one row per message id (call_id).
CREATE TABLE usage_calls (
  id                  bigserial PRIMARY KEY,
  source              text NOT NULL,                 -- 'claude-code'
  host                text NOT NULL CHECK (host IN ('mac', 'droplet')),
  call_id             text NOT NULL,                 -- Anthropic message id, msg_...
  request_id          text,
  session_external_id text NOT NULL,                 -- transcript file name without .jsonl
  message_external_id text,                          -- transcript record uuid -> archive_messages.external_id
  ts                  timestamptz NOT NULL,
  model               text NOT NULL,
  entrypoint          text,                          -- 'cli' (interactive), 'sdk-cli' (claude -p), ...
  cwd                 text,
  is_sidechain        boolean NOT NULL DEFAULT false, -- subagent work
  input_tokens        bigint NOT NULL DEFAULT 0,
  cache_write_tokens  bigint NOT NULL DEFAULT 0,
  cache_read_tokens   bigint NOT NULL DEFAULT 0,
  output_tokens       bigint NOT NULL DEFAULT 0,
  thinking_tokens     bigint NOT NULL DEFAULT 0,
  web_search_requests int NOT NULL DEFAULT 0,
  UNIQUE (source, host, call_id)
);
CREATE INDEX usage_calls_ts_idx ON usage_calls (ts);
CREATE INDEX usage_calls_session_idx ON usage_calls (host, session_external_id);

-- One row per headless run (one `claude -p` process) in a cc-runs log.
CREATE TABLE usage_runs (
  host            text NOT NULL CHECK (host IN ('mac', 'droplet')),
  session_id      text NOT NULL,
  task_id         text,
  board           text,
  lane            text,
  model           text,
  started_at      timestamptz,
  ended_at        timestamptz,
  duration_ms     bigint,
  duration_api_ms bigint,
  num_turns       int,
  subtype         text,                              -- success | error_max_turns | ...
  is_error        boolean,
  total_cost_usd  double precision,                  -- stored as logged; never displayed (subscription: show % and tokens)
  usage           jsonb,
  model_usage     jsonb,
  verify_name     text,
  verify_passed   boolean,
  verify_exit     int,
  verify_metric   double precision,
  verify_output   text,
  verify_at       timestamptz,
  log_path        text NOT NULL,
  PRIMARY KEY (host, session_id)
);
CREATE INDEX usage_runs_task_idx ON usage_runs (task_id);
CREATE INDEX usage_runs_started_idx ON usage_runs (started_at);

CREATE TABLE plan_usage_snapshots (
  id          bigserial PRIMARY KEY,
  host        text NOT NULL CHECK (host IN ('mac', 'droplet')),
  origin      text NOT NULL CHECK (origin IN ('statusline', 'stream-json')),
  "window"    text NOT NULL CHECK ("window" IN ('five_hour', 'seven_day')),
  used_pct    real NOT NULL,                         -- 0 to 100
  resets_at   timestamptz,
  observed_at timestamptz NOT NULL,
  UNIQUE (host, "window", observed_at)
);
CREATE INDEX plan_usage_observed_idx ON plan_usage_snapshots (observed_at);

-- Hermes keeps running totals per session; a row is written only when they change.
-- The time series is the difference between consecutive rows.
CREATE TABLE hermes_usage_snapshots (
  host               text NOT NULL CHECK (host IN ('mac', 'droplet')),
  profile            text NOT NULL,
  session_id         text NOT NULL,
  observed_at        timestamptz NOT NULL,
  model              text,
  billing_provider   text,
  input_tokens       bigint NOT NULL DEFAULT 0,
  output_tokens      bigint NOT NULL DEFAULT 0,
  cache_read_tokens  bigint NOT NULL DEFAULT 0,
  cache_write_tokens bigint NOT NULL DEFAULT 0,
  reasoning_tokens   bigint NOT NULL DEFAULT 0,
  api_calls          int NOT NULL DEFAULT 0,
  cost_usd           double precision,
  PRIMARY KEY (host, profile, session_id, observed_at)
);
CREATE INDEX hermes_usage_observed_idx ON hermes_usage_snapshots (observed_at);

-- Read offsets for the droplet collector (the Mac keeps its own cursor file).
CREATE TABLE usage_files (
  host         text NOT NULL CHECK (host IN ('mac', 'droplet')),
  path         text NOT NULL,
  fingerprint  text NOT NULL,
  offset_bytes bigint NOT NULL DEFAULT 0,
  lines        int NOT NULL DEFAULT 0,
  size_bytes   bigint NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (host, path)
);

-- Down Migration

DROP TABLE usage_files;
DROP TABLE hermes_usage_snapshots;
DROP TABLE plan_usage_snapshots;
DROP TABLE usage_runs;
DROP TABLE usage_calls;

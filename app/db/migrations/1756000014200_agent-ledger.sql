-- Up Migration

-- Agent ledger sync: each machine keeps its agent turns in a local SQLite
-- ledger and posts batches to /api/ingest/batch with a per-device token. The
-- token, not the request, decides which usage_hosts row the batch is written
-- as, so one machine can never write another machine's rows.
CREATE TABLE ingest_devices (
  id           bigserial PRIMARY KEY,
  host         text NOT NULL REFERENCES usage_hosts(slug) ON UPDATE CASCADE,
  label        text,
  token_hash   text NOT NULL UNIQUE,        -- sha256 hex of the bearer token; the token itself is shown once
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at   timestamptz
);

-- One row per accepted batch: the "last sync per machine" view and a trail for debugging.
CREATE TABLE ingest_batches (
  id          bigserial PRIMARY KEY,
  device_id   bigint NOT NULL REFERENCES ingest_devices(id) ON DELETE CASCADE,
  host        text NOT NULL,
  ledger_id   text NOT NULL,
  bundle      text,
  from_seq    bigint NOT NULL,
  to_seq      bigint NOT NULL,
  rows        int NOT NULL,
  counts      jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ingest_batches_host_received ON ingest_batches (host, received_at DESC);

-- Which provider served a call: 'anthropic' for Claude Code unless it runs on Bedrock or Vertex.
-- IF NOT EXISTS: the sessions-viewer work adds the same column.
ALTER TABLE usage_calls ADD COLUMN IF NOT EXISTS provider text;

-- The capture proxy's exact API calls. The system prompt, the tool list and each message
-- are stored once by content hash (every turn re-sends the whole conversation); an
-- exchange lists the hashes it sent, so the request can be rebuilt byte for byte.
-- request_id matches the transcript's requestId and usage_calls.request_id.
CREATE TABLE llm_blobs (
  sha        text PRIMARY KEY,                 -- sha256 hex of the body's JSON
  kind       text NOT NULL CHECK (kind IN ('system', 'tools', 'message')),
  body       jsonb NOT NULL,
  bytes      int NOT NULL,
  first_host text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE llm_exchanges (
  id                  bigserial PRIMARY KEY,
  host                text NOT NULL REFERENCES usage_hosts(slug) ON UPDATE CASCADE,
  provider            text NOT NULL,
  exchange_key        text NOT NULL,
  request_id          text,
  session_external_id text,
  ts                  timestamptz NOT NULL,
  model               text,
  status              int,
  duration_ms         int,
  params              jsonb,                    -- everything sent except system, tools and messages
  system_sha          text,
  tools_sha           text,
  message_shas        text[] NOT NULL DEFAULT '{}',
  response            jsonb,                    -- the assembled final message: content blocks, stop reason, usage
  usage               jsonb,
  error               text,
  UNIQUE (host, exchange_key)
);
CREATE INDEX llm_exchanges_request ON llm_exchanges (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX llm_exchanges_session ON llm_exchanges (host, session_external_id, ts);

-- Hermes calls, one row per provider request, from the engine's usage-ledger plugin. match_key (the
-- response's tool-call ids or a hash of its text) ties a call to its stored message.
ALTER TABLE usage_calls ADD COLUMN match_key text;
-- usage_facts stays Claude Code only: the usage totals take Hermes from its own session counters
-- (hermes_usage_snapshots, with Hermes's cost), so Hermes calls here would be counted twice.
CREATE OR REPLACE VIEW usage_facts AS
SELECT c.id, c.ts, c.host, c.source, c.model, c.session_external_id AS sid, c.entrypoint,
       (c.entrypoint IS DISTINCT FROM 'cli') AS headless,
       CASE WHEN c.host = 'droplet' AND r.agent_name IS NOT NULL THEN 'bot'
            WHEN c.host = 'droplet' AND r.run_id IS NOT NULL THEN 'cc-lane'
            WHEN c.host = 'droplet' THEN 'droplet'
            WHEN c.entrypoint = 'cli' THEN c.host ELSE c.host || '-headless' END AS surface,
       c.run_id, r.agent_name, coalesce(r.team_slug, a.team_slug) AS team_slug,
       coalesce(r.reasons -> 0 ->> 'reason', w.reason) AS reason,
       c.tool, c.action,
       coalesce(tl.work_type, r.work_type,
                CASE r.lane WHEN 'cc-coder' THEN 'coding' WHEN 'cc-research' THEN 'research'
                            WHEN 'cc-writer' THEN 'writing' WHEN 'cc-reviewer' THEN 'coding' END,
                a.work) AS work_type,
       tl.project_slug, tl.feature_slug, r.task_id, r.board, r.lane,
       c.input_tokens AS input, c.cache_write_tokens AS cache_write, c.cache_read_tokens AS cache_read, c.output_tokens AS output
FROM usage_calls c
LEFT JOIN usage_runs r ON r.host = c.host AND r.run_id = c.run_id
LEFT JOIN org_agents a ON a.name = r.agent_name
LEFT JOIN task_links tl ON tl.task_id = r.task_id
LEFT JOIN LATERAL (SELECT reason FROM org_wakeups WHERE claimed_by = r.run_id ORDER BY id LIMIT 1) w ON r.run_id IS NOT NULL
WHERE c.source = 'claude-code';

-- Down Migration

CREATE OR REPLACE VIEW usage_facts AS
SELECT c.id, c.ts, c.host, c.source, c.model, c.session_external_id AS sid, c.entrypoint,
       (c.entrypoint IS DISTINCT FROM 'cli') AS headless,
       CASE WHEN c.host = 'droplet' AND r.agent_name IS NOT NULL THEN 'bot'
            WHEN c.host = 'droplet' AND r.run_id IS NOT NULL THEN 'cc-lane'
            WHEN c.host = 'droplet' THEN 'droplet'
            WHEN c.entrypoint = 'cli' THEN c.host ELSE c.host || '-headless' END AS surface,
       c.run_id, r.agent_name, coalesce(r.team_slug, a.team_slug) AS team_slug,
       coalesce(r.reasons -> 0 ->> 'reason', w.reason) AS reason,
       c.tool, c.action,
       coalesce(tl.work_type, r.work_type,
                CASE r.lane WHEN 'cc-coder' THEN 'coding' WHEN 'cc-research' THEN 'research'
                            WHEN 'cc-writer' THEN 'writing' WHEN 'cc-reviewer' THEN 'coding' END,
                a.work) AS work_type,
       tl.project_slug, tl.feature_slug, r.task_id, r.board, r.lane,
       c.input_tokens AS input, c.cache_write_tokens AS cache_write, c.cache_read_tokens AS cache_read, c.output_tokens AS output
FROM usage_calls c
LEFT JOIN usage_runs r ON r.host = c.host AND r.run_id = c.run_id
LEFT JOIN org_agents a ON a.name = r.agent_name
LEFT JOIN task_links tl ON tl.task_id = r.task_id
LEFT JOIN LATERAL (SELECT reason FROM org_wakeups WHERE claimed_by = r.run_id ORDER BY id LIMIT 1) w ON r.run_id IS NOT NULL;
ALTER TABLE usage_calls DROP COLUMN match_key;

DROP TABLE llm_exchanges;
DROP TABLE llm_blobs;
DROP TABLE ingest_batches;
DROP TABLE ingest_devices;
ALTER TABLE usage_calls DROP COLUMN IF EXISTS provider;

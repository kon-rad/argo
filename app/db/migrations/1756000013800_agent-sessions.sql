-- db/migrations/1756000013800_agent-sessions.sql
-- Up Migration

-- Agent sessions (vault: agent-sessions-viewer-design.md): one sessions list and one
-- step-by-step view for every agent harness. The archive stays the only transcript
-- store; these columns let the page and its filters read structure instead of
-- harness-specific JSON.

-- What ran the session, which profile, which provider. Derived from what is already
-- stored, so every writer (archive run, usage-sync, agents-sync, the ledger) fills them.
ALTER TABLE archive_sessions
  ADD COLUMN harness text GENERATED ALWAYS AS (split_part(source, ':', 1)) STORED,
  ADD COLUMN profile text GENERATED ALWAYS AS (
    CASE WHEN source = 'claude-code' THEN NULL
         WHEN position(':' IN source) > 0 THEN split_part(source, ':', 2)
         ELSE 'main' END) STORED,
  ADD COLUMN provider text GENERATED ALWAYS AS (
    CASE WHEN source = 'claude-code' THEN 'anthropic'
         ELSE nullif(meta ->> 'billing_provider', '') END) STORED;
CREATE INDEX archive_sessions_harness_idx ON archive_sessions (harness, host, started_at);
CREATE INDEX archive_sessions_parent_idx ON archive_sessions (host, source, parent_external_id) WHERE parent_external_id IS NOT NULL;

-- One stored row per source record, classified (server/src/archive/steps.ts). A Hermes
-- assistant row can hold thinking, a response and several tool calls: `step` is its main
-- part and `tool_names` lists every call; the API expands the parts when it reads.
-- Filled at ingest; `secondbrain archive-steps` fills rows stored before this migration.
-- Nullable columns and a NOT VALID check: no table rewrite and no scan of the 1.6 GB table
-- under the exclusive lock (a plain CHECK on ADD COLUMN validates every row).
ALTER TABLE archive_messages
  ADD COLUMN step         text,
  ADD COLUMN tool_names   text[],
  ADD COLUMN tool_call_id text,
  ADD COLUMN is_error     boolean;
ALTER TABLE archive_messages ADD CONSTRAINT archive_messages_step_check
  CHECK (step IN ('prompt', 'response', 'thinking', 'tool_call', 'tool_result', 'system', 'meta')) NOT VALID;
CREATE INDEX archive_messages_step_todo_idx ON archive_messages (id) WHERE step IS NULL;
CREATE INDEX archive_messages_tools_idx ON archive_messages USING gin (tool_names);
CREATE INDEX archive_messages_tool_call_idx ON archive_messages (session_id, tool_call_id) WHERE tool_call_id IS NOT NULL;
CREATE INDEX archive_messages_errors_idx ON archive_messages (session_id) WHERE is_error;

-- Down Migration

DROP INDEX archive_messages_errors_idx;
DROP INDEX archive_messages_tool_call_idx;
DROP INDEX archive_messages_tools_idx;
DROP INDEX archive_messages_step_todo_idx;
ALTER TABLE archive_messages DROP CONSTRAINT archive_messages_step_check;
ALTER TABLE archive_messages DROP COLUMN is_error, DROP COLUMN tool_call_id, DROP COLUMN tool_names, DROP COLUMN step;
DROP INDEX archive_sessions_parent_idx;
DROP INDEX archive_sessions_harness_idx;
ALTER TABLE archive_sessions DROP COLUMN provider, DROP COLUMN profile, DROP COLUMN harness;

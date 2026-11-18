-- db/migrations/1756000015500_chat-presets.sql
-- Up Migration

-- The Chat tab's "Preset" button: one saved way to start a session (harness, provider, model, org role, tools),
-- so one click launches it.
-- A convenience, not a permission: launching still goes through agent-hub or `zen-agent serve`, which validate it.
CREATE TABLE chat_presets (
  name       text PRIMARY KEY CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  harness    text NOT NULL CHECK (harness IN ('claude-code', 'zen-agent')),
  config     jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE IF EXISTS chat_presets;

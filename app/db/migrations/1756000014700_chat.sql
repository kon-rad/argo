-- Up Migration

-- The chat module (docs/rag.md, section 6): conversations with the vault's
-- assistant, the sources each answer was built from, and the one row of
-- settings the settings modal edits. Module data, not derived from markdown:
-- dropping the database loses it, unlike the index.

CREATE TABLE chat_conversations (
  id          serial PRIMARY KEY,
  title       text NOT NULL DEFAULT 'New conversation',
  -- The persona the conversation was started with: 'default' or an org agent name.
  persona     text NOT NULL DEFAULT 'default',
  -- The provider and model pinned when the conversation started; null: whatever the settings say.
  provider    text,
  model       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_conversations_updated_idx ON chat_conversations (updated_at DESC);

CREATE TABLE chat_messages (
  id               bigserial PRIMARY KEY,
  conversation_id  integer NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('user', 'assistant')),
  content          text NOT NULL,
  -- For an assistant turn: the passages it was given ({n, path, title, heading_path, chunk_from, chunk_to, score}).
  sources          jsonb NOT NULL DEFAULT '[]',
  -- Provider, model, persona, token usage, retrieval timings, the queries used.
  meta             jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_messages_conversation_idx ON chat_messages (conversation_id, id);

CREATE TABLE chat_settings (
  id        integer PRIMARY KEY CHECK (id = 1),
  settings  jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE IF EXISTS chat_settings;
DROP TABLE IF EXISTS chat_messages;
DROP TABLE IF EXISTS chat_conversations;

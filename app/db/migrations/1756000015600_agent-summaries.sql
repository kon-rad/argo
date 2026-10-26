-- Up Migration

-- One summary per finished agent session (any harness, any machine), written by `secondbrain summarize`.
-- Derived data: rebuildable from archive_*; never edited by hand. The model writes request, done, learned,
-- open_items and outcome; touched and metrics are computed in SQL/rules so the model cannot invent them.
-- Design: docs/summaries.md.
CREATE TABLE agent_summaries (
  id             bigserial PRIMARY KEY,
  session_id     bigint NOT NULL REFERENCES archive_sessions (id) ON DELETE CASCADE,
  prompt_version text NOT NULL,
  -- Hash of the compacted input the model read; a changed hash (the session grew) means re-summarize.
  source_sha     text NOT NULL,
  status         text NOT NULL CHECK (status IN ('ok', 'skipped')),
  -- Copied from archive_sessions so the day view filters without a join.
  harness        text,
  host           text NOT NULL,
  profile        text,
  project        text,
  started_at     timestamptz,
  ended_at       timestamptz,
  request        text NOT NULL DEFAULT '',
  done           text NOT NULL DEFAULT '',
  learned        text NOT NULL DEFAULT '',
  open_items     text NOT NULL DEFAULT '',
  outcome        text NOT NULL DEFAULT 'unknown' CHECK (outcome IN ('finished', 'partial', 'blocked', 'failed', 'unknown')),
  touched        jsonb NOT NULL DEFAULT '{}',
  metrics        jsonb NOT NULL DEFAULT '{}',
  -- The hash of the rules/skills/roster the run ran under (docs/self-improvement.md); null until that exists.
  harness_version text,
  -- Who wrote it: the first provider in the chain that answered, and what the others did.
  writer_provider text,
  writer_model    text,
  attempts        jsonb NOT NULL DEFAULT '[]',
  writer_input_tokens  integer,
  writer_output_tokens integer,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, prompt_version)
);
CREATE INDEX agent_summaries_started_idx ON agent_summaries (started_at DESC);
CREATE INDEX agent_summaries_outcome_idx ON agent_summaries (outcome, started_at DESC);

-- What a session learned, as candidates. A candidate becomes a memory_facts row only when promoted
-- (by the owner on the Summaries view or a reviewer); recall never sees a candidate.
CREATE TABLE agent_summary_facts (
  id         bigserial PRIMARY KEY,
  summary_id bigint NOT NULL REFERENCES agent_summaries (id) ON DELETE CASCADE,
  subject    text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  claim      text NOT NULL CHECK (length(claim) BETWEEN 1 AND 1000),
  status     text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'promoted', 'rejected')),
  fact_id    bigint REFERENCES memory_facts (id),
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_summary_facts_status_idx ON agent_summary_facts (status, created_at DESC);
CREATE INDEX agent_summary_facts_summary_idx ON agent_summary_facts (summary_id);

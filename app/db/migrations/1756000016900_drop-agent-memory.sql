-- Up Migration

-- Memory is a core feature (docs/memory.md; engine-core-v2 phase 6, section 6). The per-bot persona store
-- (`org_agent_memory`, migration 1756000015200) is retired now that the shared store carries an `agent` column
-- (migration 1756000016800): one memory, `memory_facts`, tagged with the bot it is about.
--
-- Nothing durable is lost: every persona row is exported into memory_facts first, then the table is dropped in the
-- same migration. The episodic store, `org_agent_episodes`, stays: one row per finished wake.
--
-- Mapping (the proposal's, against the real memory_facts columns):
--   agent        = agent_name
--   claim        = content
--   author       = 'summaries'
--   confidence   = 'inferred'   (memory_facts.confidence is a text enum, not a number, so the proposed numeric
--                                confidence from occurrences has no column; occurrences ride in the subject label)
--   source       = 'episode:<first evidence_episode_id>' or 'persona-export' when there is none
--   subject      = '<agent> · <kind>[ ×occurrences]' (a short label, capped at 200)
--   project_slug = NULL
-- A row already retired (active = false) is exported retired: valid_to set, retired_by 'persona-export', the old
-- retired_why kept.

INSERT INTO memory_facts (subject, claim, source, author, confidence, agent, project_slug, valid_to, retired_by, retired_why)
SELECT
  left(m.agent_name || ' · ' || m.kind || CASE WHEN m.occurrences > 1 THEN ' ×' || m.occurrences ELSE '' END, 200),
  m.content,
  CASE WHEN cardinality(m.evidence_episode_ids) > 0 THEN 'episode:' || m.evidence_episode_ids[1] ELSE 'persona-export' END,
  'summaries',
  'inferred',
  m.agent_name,
  NULL,
  CASE WHEN m.active THEN NULL ELSE now() END,
  CASE WHEN m.active THEN NULL ELSE 'persona-export' END,
  CASE WHEN m.active THEN NULL ELSE m.retired_why END
FROM org_agent_memory m;

DROP TABLE org_agent_memory;

-- Down Migration

-- Recreate the persona store verbatim (schema from 1756000015200_agent-memory.sql). The export above is one-way:
-- this brings the empty table back, not its data. org_agent_episodes is untouched by this migration, so its
-- policies and grant stay as they were.

CREATE TABLE org_agent_memory (
  id                   bigserial PRIMARY KEY,
  agent_name           text NOT NULL REFERENCES org_agents(name) ON UPDATE CASCADE,
  kind                 text NOT NULL CHECK (kind IN ('lesson','anti_pattern','preference','friction')),
  content              text NOT NULL CHECK (length(content) BETWEEN 1 AND 500),
  evidence_episode_ids bigint[] NOT NULL DEFAULT '{}',
  occurrences          integer NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
  active               boolean NOT NULL DEFAULT true,
  retired_why          text,
  supersedes           bigint REFERENCES org_agent_memory(id),
  promoted_to_proposal boolean NOT NULL DEFAULT false,
  proposal_task_id     text,
  proposed_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX org_agent_memory_agent_idx ON org_agent_memory (agent_name) WHERE active;
CREATE INDEX org_agent_memory_proposed_idx ON org_agent_memory (agent_name, proposed_at) WHERE proposed_at IS NOT NULL;

ALTER TABLE org_agent_memory ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON org_agent_memory TO sb_org;
CREATE POLICY org_agent_memory_own ON org_agent_memory FOR SELECT TO sb_org USING (agent_name = org_me());

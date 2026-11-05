-- Up Migration

-- Memory as a core feature (docs/memory.md; engine core v2 phase 6).
--
-- 1. memory_facts gains `agent`: NULL for a company-wide claim every agent may recall, or the name of the one agent
--    the claim is about (the old persona rows, `org_agent_memory`, import with their owner's name here). Recall and
--    the /memory page filter on it; the wake-time injection picks the top facts where agent is the bot or the
--    fact's project is the card's.
-- 2. agent_summary_facts gains `agent`: the agent whose finished session proposed the candidate, so /memory can show
--    a candidate under the bot it came from before a person promotes it into memory_facts.

ALTER TABLE memory_facts ADD COLUMN agent text
  CHECK (agent IS NULL OR agent ~ '^[a-z0-9][a-z0-9-]*$');
CREATE INDEX memory_facts_agent_idx ON memory_facts (agent, id DESC) WHERE agent IS NOT NULL AND valid_to IS NULL;

ALTER TABLE agent_summary_facts ADD COLUMN agent text;

-- Down Migration

DROP INDEX IF EXISTS memory_facts_agent_idx;
ALTER TABLE memory_facts DROP COLUMN IF EXISTS agent;
ALTER TABLE agent_summary_facts DROP COLUMN IF EXISTS agent;

-- Up Migration

-- The `dispatch` capability: give any card to any bot. One holder, the chief of staff, for the daily sweep that
-- assigns unassigned cards and nudges stale ones (vault: Areas/argo/second-brain/agent-company/agent-company-design.md;
-- Konrad, 2026-10-21). It is a power, not a card need, so task_links.needs keeps its list.

ALTER TABLE org_agents DROP CONSTRAINT org_agents_capabilities_check;
ALTER TABLE org_agents ADD CONSTRAINT org_agents_capabilities_check
  CHECK (capabilities <@ ARRAY['code','review','merge','deploy','m1','web','dispatch']::text[]);

-- Down Migration

UPDATE org_agents SET capabilities = array_remove(capabilities, 'dispatch');
ALTER TABLE org_agents DROP CONSTRAINT org_agents_capabilities_check;
ALTER TABLE org_agents ADD CONSTRAINT org_agents_capabilities_check
  CHECK (capabilities <@ ARRAY['code','review','merge','deploy','m1','web']::text[]);

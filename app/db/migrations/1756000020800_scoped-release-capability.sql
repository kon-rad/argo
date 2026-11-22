-- Up Migration

-- An owner-installed repo or deploy target must also name the agent. The DB capability alone does not grant a target.
ALTER TABLE org_agents DROP CONSTRAINT org_agents_capabilities_check;
ALTER TABLE org_agents ADD CONSTRAINT org_agents_capabilities_check
  CHECK (capabilities <@ ARRAY['code','review','merge','deploy','m1','web','dispatch','scoped-release']::text[]);

-- Down Migration

UPDATE org_agents SET capabilities = array_remove(capabilities, 'scoped-release');
ALTER TABLE org_agents DROP CONSTRAINT org_agents_capabilities_check;
ALTER TABLE org_agents ADD CONSTRAINT org_agents_capabilities_check
  CHECK (capabilities <@ ARRAY['code','review','merge','deploy','m1','web','dispatch']::text[]);

-- Up Migration

-- Removing a project must not be blocked by the shared-memory facts tagged
-- with it: the fact outlives the tag.
ALTER TABLE memory_facts DROP CONSTRAINT memory_facts_project_slug_fkey;
ALTER TABLE memory_facts ADD CONSTRAINT memory_facts_project_slug_fkey
  FOREIGN KEY (project_slug) REFERENCES projects(slug) ON UPDATE CASCADE ON DELETE SET NULL;

-- Down Migration

ALTER TABLE memory_facts DROP CONSTRAINT memory_facts_project_slug_fkey;
ALTER TABLE memory_facts ADD CONSTRAINT memory_facts_project_slug_fkey
  FOREIGN KEY (project_slug) REFERENCES projects(slug) ON UPDATE CASCADE;

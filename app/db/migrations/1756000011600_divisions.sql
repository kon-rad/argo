-- Up Migration

-- Divisions: the organisation's branches, modeled after a large company.
-- Corporation -> division -> projects -> features; teams
-- stay the functional groups that do the work. Numbered under the unmerged
-- usage-ledger migration (12000), like 11500.

CREATE TABLE divisions (
  slug        text PRIMARY KEY CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
  name        text NOT NULL,
  mission     text,
  head        text,
  sort        integer NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE projects
  ADD COLUMN division_slug text REFERENCES divisions(slug) ON UPDATE CASCADE ON DELETE SET NULL;

-- Down Migration

ALTER TABLE projects DROP COLUMN division_slug;
DROP TABLE divisions;

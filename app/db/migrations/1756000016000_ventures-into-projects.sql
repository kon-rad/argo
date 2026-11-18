-- Up Migration

-- Ventures are rolled back into projects (the tracker stays the one place
-- agents read and update). Any venture without a project row of the same
-- slug becomes one, with its home folder kept in projects.paths (a project
-- is not tied to a folder; paths is just a pointer). Then the venture
-- column and table go. Design: Projects/secondbrain-app/dev-log in the
-- owner's vault, 2026-10-28.

INSERT INTO projects (slug, title, stage, paths, goals, updated_by)
SELECT v.slug, v.name, 'building',
       CASE WHEN v.home_path IS NULL THEN '{}'::text[] ELSE ARRAY[v.home_path] END,
       v.goals, 'migration-16000'
FROM ventures v
WHERE length(v.slug) <= 64
ON CONFLICT (slug) DO UPDATE
  SET paths = CASE WHEN projects.paths = '{}' THEN EXCLUDED.paths ELSE projects.paths END;

ALTER TABLE projects DROP COLUMN venture_slug;
DROP TABLE ventures;

-- Down Migration

CREATE TABLE ventures (
  slug         text PRIMARY KEY CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
  name         text NOT NULL,
  kind         text NOT NULL DEFAULT 'product',
  summary      text,
  parent_slug  text REFERENCES ventures(slug) ON UPDATE CASCADE ON DELETE SET NULL,
  division_slug text REFERENCES divisions(slug) ON UPDATE CASCADE ON DELETE SET NULL,
  home_path    text,
  goals        text[] NOT NULL DEFAULT '{}',
  links        jsonb NOT NULL DEFAULT '[]',
  sort         integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text,
  CHECK (parent_slug IS NULL OR parent_slug <> slug)
);
CREATE INDEX ventures_parent_idx ON ventures (parent_slug);
ALTER TABLE projects
  ADD COLUMN venture_slug text REFERENCES ventures(slug) ON UPDATE CASCADE ON DELETE SET NULL;
CREATE INDEX projects_venture_idx ON projects (venture_slug);

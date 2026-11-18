-- Up Migration

-- Ventures: the things the owner runs (a product, program, community, brand,
-- platform). A venture owns a vault folder (`home_path`) with a standard
-- layout, may sit under one parent venture (an umbrella brand and its
-- children) and may belong to a division (an optional grouping label).
-- Projects point at the venture they build. Design:
-- Projects/secondbrain-app/ventures-design.md in the owner's vault.
--
-- Nothing here names a venture: slugs, kinds and folders are data.

CREATE TABLE ventures (
  slug         text PRIMARY KEY CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
  name         text NOT NULL,
  kind         text NOT NULL DEFAULT 'product',
  summary      text,
  parent_slug  text REFERENCES ventures(slug) ON UPDATE CASCADE ON DELETE SET NULL,
  division_slug text REFERENCES divisions(slug) ON UPDATE CASCADE ON DELETE SET NULL,
  home_path    text,                              -- vault-relative folder, Areas/ or Projects/
  goals        text[] NOT NULL DEFAULT '{}',      -- goal codes, as on projects
  links        jsonb NOT NULL DEFAULT '[]',       -- [{"label": "...", "url": "..."}]
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

-- Down Migration

DROP INDEX projects_venture_idx;
ALTER TABLE projects DROP COLUMN venture_slug;
DROP TABLE ventures;

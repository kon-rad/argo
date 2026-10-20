-- Up Migration

-- Archive for the project tracker: hide a project or feature from the default
-- board without deleting it. Archiving is about visibility, stage is about
-- progress, so it is a flag beside `stage`, not a stage. Rows, features,
-- verifications and stage history all stay. Design:
-- Projects/secondbrain-app/sol-archive-and-dynamic-boards-plan.md section 3.1.

ALTER TABLE projects
  ADD COLUMN archived     boolean NOT NULL DEFAULT false,
  ADD COLUMN archived_at  timestamptz,
  ADD COLUMN archived_by  text;

ALTER TABLE features
  ADD COLUMN archived     boolean NOT NULL DEFAULT false,
  ADD COLUMN archived_at  timestamptz,
  ADD COLUMN archived_by  text;

CREATE INDEX projects_archived_idx ON projects (archived);
CREATE INDEX features_archived_idx ON features (archived);

-- Audit trail, append-only. Its own table rather than stage_changes with a
-- sentinel to_stage: stage_changes feeds "moved this week" and days-in-stage,
-- and an archive is not a stage move.
CREATE TABLE archive_events (
  id            bigserial PRIMARY KEY,
  project_slug  text NOT NULL REFERENCES projects(slug) ON UPDATE CASCADE ON DELETE CASCADE,
  feature_id    bigint REFERENCES features(id) ON DELETE CASCADE,   -- NULL = the project itself
  action        text NOT NULL CHECK (action IN ('archive','restore')),
  reason        text,
  at            timestamptz NOT NULL DEFAULT now(),
  by            text
);
CREATE INDEX archive_events_project_idx ON archive_events (project_slug, at DESC);

-- Down Migration

DROP TABLE archive_events;
DROP INDEX features_archived_idx;
DROP INDEX projects_archived_idx;
ALTER TABLE features DROP COLUMN archived_by, DROP COLUMN archived_at, DROP COLUMN archived;
ALTER TABLE projects DROP COLUMN archived_by, DROP COLUMN archived_at, DROP COLUMN archived;

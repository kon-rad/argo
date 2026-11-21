-- Up Migration
ALTER TABLE org_runtime_targets
  ADD COLUMN probe_status text NOT NULL DEFAULT 'unsupported' CHECK (probe_status IN ('unsupported','unhealthy','ready')),
  ADD COLUMN observed jsonb,
  ADD COLUMN supported jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN checked_at timestamptz;

ALTER TABLE org_runtime_versions DROP CONSTRAINT org_runtime_versions_status_check;
ALTER TABLE org_runtime_versions ADD CHECK (status IN ('org-applied','partially-applied','launchers-verified'));

-- Down Migration
UPDATE org_runtime_versions SET status='partially-applied' WHERE status='launchers-verified';
ALTER TABLE org_runtime_versions DROP CONSTRAINT org_runtime_versions_status_check;
ALTER TABLE org_runtime_versions ADD CHECK (status IN ('org-applied','partially-applied'));
ALTER TABLE org_runtime_targets DROP COLUMN probe_status, DROP COLUMN observed, DROP COLUMN supported, DROP COLUMN checked_at;

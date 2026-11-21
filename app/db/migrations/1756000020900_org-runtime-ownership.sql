-- Up Migration
-- Launchers read org_agents_effective. Profiles and audit history are owner-only.
REVOKE ALL ON org_runtime_profiles,org_runtime_targets,org_runtime_previews,org_runtime_versions,org_runtime_receipts FROM sb_org;

-- One immutable profile revision per affected target, including restored selections.
ALTER TABLE org_runtime_versions ADD COLUMN applied_profiles jsonb NOT NULL DEFAULT '[]';
ALTER TABLE org_runtime_versions ADD COLUMN previous_profiles jsonb NOT NULL DEFAULT '[]';
-- Existing ordinary applies have known provenance. Older rollback provenance is
-- deliberately not guessed; restoring an entry without metadata fails closed.
UPDATE org_runtime_versions v SET applied_profiles = (
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',v.profile_id,'version',v.profile_version) ORDER BY n),'[]'::jsonb)
  FROM jsonb_array_elements(v.changes) WITH ORDINALITY AS x(c,n)
) WHERE reverted_version IS NULL;

-- Down Migration
ALTER TABLE org_runtime_versions DROP COLUMN applied_profiles, DROP COLUMN previous_profiles;

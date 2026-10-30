-- Up Migration

-- `cli-org apply` (docs/org-routing.md) archives a team or a channel that the org file no longer names instead of
-- deleting it: projects, boards, cards and messages keep joining the row. NULL is live. An import or apply that
-- names the team or channel again clears it.
ALTER TABLE teams ADD COLUMN archived_at timestamptz;
ALTER TABLE org_channels ADD COLUMN archived_at timestamptz;

-- Down Migration

ALTER TABLE org_channels DROP COLUMN archived_at;
ALTER TABLE teams DROP COLUMN archived_at;

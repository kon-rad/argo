-- Up Migration

-- `cli-org breaker` runs as the sb_org role (ORG_AGENT + SB_ORG_DB_URL) and reads the latest OpenRouter balance from
-- provider_credit_snapshots. The table predates sb_org and was never granted, so --dry-run failed live on 2026-10-27
-- with "permission denied for table provider_credit_snapshots" (card t_edade866). Read-only: sb_org still writes
-- nothing here; `secondbrain credits sync` writes it as the app role.
GRANT SELECT ON provider_credit_snapshots TO sb_org;

-- Down Migration

REVOKE SELECT ON provider_credit_snapshots FROM sb_org;

-- Up Migration

-- `cli-org task create` checks the feature exists before creating the card;
-- as sb_org (every caller with ORG_AGENT set, the owner included) that read was
-- refused on the first live run (2026-10-15: "permission denied for table
-- features"). Features are tracker records every bot may read anyway.
GRANT SELECT ON features TO sb_org;

-- Down Migration

REVOKE SELECT ON features FROM sb_org;

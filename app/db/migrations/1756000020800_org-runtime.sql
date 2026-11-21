-- Up Migration
CREATE TABLE org_runtime_profiles (
  id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  definition jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version)
);
CREATE TABLE org_runtime_targets (
  kind text NOT NULL CHECK (kind IN ('cron-job','telegram-gateway','telegram-poller','default-route')),
  id text NOT NULL,
  configured jsonb NOT NULL,
  PRIMARY KEY (kind,id)
);
-- Inventory placeholders are intentionally unsupported, never inferred healthy.
INSERT INTO org_runtime_targets VALUES
 ('cron-job','unregistered','{"runtime":"unknown","model":null,"provider":null}'),
 ('telegram-gateway','unregistered','{"runtime":"unknown","model":null,"provider":null}'),
 ('telegram-poller','unregistered','{"runtime":"unknown","model":null,"provider":null}'),
 ('default-route','unregistered','{"runtime":"unknown","model":null,"provider":null}');
CREATE TABLE org_runtime_previews (
  token text PRIMARY KEY,
  snapshot text NOT NULL,
  payload jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  used boolean NOT NULL DEFAULT false,
  created_by text NOT NULL
);
CREATE TABLE org_runtime_versions (
  version integer PRIMARY KEY,
  profile_id text NOT NULL,
  profile_version integer NOT NULL,
  changes jsonb NOT NULL,
  previous_overrides jsonb NOT NULL,
  uncovered jsonb NOT NULL,
  applied_by text NOT NULL,
  reverted_version integer REFERENCES org_runtime_versions(version),
  status text NOT NULL CHECK (status IN ('org-applied','partially-applied')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (profile_id,profile_version) REFERENCES org_runtime_profiles(id,version)
);
CREATE TABLE org_runtime_receipts (
  version integer NOT NULL REFERENCES org_runtime_versions(version),
  kind text NOT NULL,
  target_id text NOT NULL,
  status text NOT NULL,
  assignment jsonb NOT NULL,
  observed_at timestamptz,
  PRIMARY KEY (version,kind,target_id)
);
-- No write grant and no SECURITY DEFINER entry point: a bot cannot spoof the owner.
REVOKE ALL ON org_runtime_profiles,org_runtime_targets,org_runtime_previews,org_runtime_versions,org_runtime_receipts FROM PUBLIC, sb_org;
GRANT SELECT ON org_runtime_profiles,org_runtime_targets,org_runtime_versions,org_runtime_receipts TO sb_org;

-- Down Migration
DROP TABLE org_runtime_receipts,org_runtime_versions,org_runtime_previews,org_runtime_targets,org_runtime_profiles;

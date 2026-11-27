-- Up Migration
CREATE TABLE hc_registry_snapshots (
  revision text PRIMARY KEY CHECK (revision ~ '^[0-9a-f]{64}$'),
  registry jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- This row exists before first apply, so two first-time applicants lock the same row.
CREATE TABLE hc_registry_head (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision text REFERENCES hc_registry_snapshots(revision)
);
INSERT INTO hc_registry_head (singleton) VALUES (true);
-- Down Migration
DROP TABLE hc_registry_head, hc_registry_snapshots;

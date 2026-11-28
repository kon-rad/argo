-- Up Migration
ALTER TABLE hc_requests ADD COLUMN input_ref jsonb;
CREATE TABLE hc_artifacts (
  id uuid PRIMARY KEY,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  content bytea NOT NULL CHECK (octet_length(content) <= 4194304),
  run_id text REFERENCES hc_requests(id),
  generation integer,
  CHECK ((run_id IS NULL) = (generation IS NULL)),
  UNIQUE (run_id, generation),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE INDEX hc_artifacts_expiry ON hc_artifacts(expires_at);
-- Down Migration
DROP TABLE hc_artifacts;
ALTER TABLE hc_requests DROP COLUMN input_ref;

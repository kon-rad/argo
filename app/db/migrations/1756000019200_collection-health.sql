-- Up Migration
CREATE TABLE usage_import_quarantine (
  host text NOT NULL, digest text NOT NULL, wire text NOT NULL,
  reason text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (host, digest)
);
-- Quarantine is retryable data, never subject to attempt-history cleanup.
CREATE TABLE collection_attempts (
  host text NOT NULL REFERENCES usage_hosts(slug), collector_instance text NOT NULL,
  runtime text NOT NULL, path text NOT NULL, attempt_seq bigint NOT NULL,
  collector_version text NOT NULL, started_at timestamptz NOT NULL, ended_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), outcome text NOT NULL,
  observed_at timestamptz, imported_at timestamptz, backlog bigint, oldest_pending_at timestamptz,
  rejected bigint, quarantined bigint, reason text, capabilities text[] NOT NULL,
  PRIMARY KEY (host, collector_instance, runtime, path, attempt_seq)
);
CREATE INDEX collection_attempts_received ON collection_attempts(received_at);
CREATE TABLE collection_streams (LIKE collection_attempts INCLUDING DEFAULTS);
ALTER TABLE collection_streams ADD PRIMARY KEY (host, collector_instance, runtime, path);
ALTER TABLE collection_streams ADD COLUMN last_success_at timestamptz;
-- Down Migration
DROP TABLE collection_streams;
DROP TABLE collection_attempts;
DROP TABLE usage_import_quarantine;

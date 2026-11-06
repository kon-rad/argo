-- Up Migration
-- P3 reserved migration for private Hiring Desk orchestration state.
-- All public-chain facts remain independently verified by the public-store adapters.
CREATE TABLE desk_assignments (
  job_ref text PRIMARY KEY,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  aggregate jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE desk_idempotency (
  job_ref text NOT NULL REFERENCES desk_assignments(job_ref) ON DELETE CASCADE,
  action text NOT NULL,
  idempotency_key text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_ref, action, idempotency_key)
);

CREATE TABLE desk_audit_events (
  id bigserial PRIMARY KEY,
  job_ref text NOT NULL REFERENCES desk_assignments(job_ref) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision > 0),
  actor text NOT NULL,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_ref, revision)
);

CREATE TABLE desk_payment_allocations (
  receipt_id text PRIMARY KEY,
  job_ref text NOT NULL REFERENCES desk_assignments(job_ref),
  allocated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_ref, receipt_id)
);

CREATE INDEX desk_assignments_updated_idx ON desk_assignments(updated_at DESC);

-- Down Migration
DROP INDEX IF EXISTS desk_assignments_updated_idx;
DROP TABLE IF EXISTS desk_payment_allocations;
DROP TABLE IF EXISTS desk_audit_events;
DROP TABLE IF EXISTS desk_idempotency;
DROP TABLE IF EXISTS desk_assignments;

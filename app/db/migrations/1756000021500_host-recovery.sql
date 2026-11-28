-- Up Migration
ALTER TABLE hc_requests
  ADD COLUMN attempt_id text,
  ADD COLUMN caller_id text NOT NULL DEFAULT 'owner',
  ADD COLUMN command_revision text,
  ADD COLUMN registry_revision text,
  ADD COLUMN reconciled_at timestamptz,
  DROP CONSTRAINT hc_requests_request_key_key,
  ADD CONSTRAINT hc_requests_caller_key UNIQUE(caller_id,request_key),
  ADD COLUMN deadline_at timestamptz,
  DROP CONSTRAINT hc_requests_state_check,
  ADD CONSTRAINT hc_requests_state_check
    CHECK (state IN ('queued','reserved','running','succeeded','failed','unknown'));
UPDATE hc_requests SET attempt_id=id WHERE machine IS NOT NULL;
CREATE UNIQUE INDEX hc_requests_attempt ON hc_requests(attempt_id);
CREATE INDEX hc_requests_deadline ON hc_requests(deadline_at) WHERE state IN ('reserved','running');
-- Down Migration
-- An ambiguous execution requires reconciliation before a downgrade.
ALTER TABLE hc_requests DROP CONSTRAINT hc_requests_state_check,
  ADD CONSTRAINT hc_requests_state_check CHECK (state IN ('queued','reserved','running','succeeded','failed'));
ALTER TABLE hc_requests DROP CONSTRAINT hc_requests_caller_key,
  ADD UNIQUE(request_key), DROP COLUMN caller_id, DROP COLUMN command_revision, DROP COLUMN registry_revision, DROP COLUMN reconciled_at;
DROP INDEX hc_requests_attempt, hc_requests_deadline;
ALTER TABLE hc_requests DROP COLUMN attempt_id, DROP COLUMN deadline_at;

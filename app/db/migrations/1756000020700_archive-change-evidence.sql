-- Prospective runtime capture. Historical absence stays NULL; replay never crawls checkouts.
-- The metadata projection can be rebuilt from redacted raw runtime results.
ALTER TABLE archive_messages ADD COLUMN IF NOT EXISTS change_evidence jsonb;
COMMENT ON COLUMN archive_messages.change_evidence IS
  'Validated runtime-owned file capture metadata; diff body remains in authorized redacted raw source. NULL means unknown.';
CREATE INDEX IF NOT EXISTS review_attempts_job_at ON review_attempts(job, at, id);
CREATE INDEX IF NOT EXISTS review_attempts_at ON review_attempts(at, id);

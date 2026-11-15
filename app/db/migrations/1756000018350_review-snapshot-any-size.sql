-- Up Migration
-- A review snapshot holds the whole diff and every changed source. PR size is no longer a reason to refuse a
-- review (large PRs are read in several passes), so the 1 MB ceiling on the stored snapshot goes. The new bound
-- only keeps a runaway write out of the table.
ALTER TABLE review_jobs DROP CONSTRAINT IF EXISTS review_jobs_snapshot_check;
ALTER TABLE review_jobs ADD CONSTRAINT review_jobs_snapshot_check CHECK (octet_length(snapshot::text) <= 64000000);

-- Down Migration
ALTER TABLE review_jobs DROP CONSTRAINT IF EXISTS review_jobs_snapshot_check;
ALTER TABLE review_jobs ADD CONSTRAINT review_jobs_snapshot_check CHECK (octet_length(snapshot::text) <= 1000000) NOT VALID;

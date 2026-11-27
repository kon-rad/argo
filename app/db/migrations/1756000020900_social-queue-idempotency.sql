-- Up Migration

-- Social queue retries that cannot post twice.
--
-- 1. Idempotent enqueue. A caller may send a stable idempotency key with a
--    queue request. The key is unique across social_posts (the database, not
--    the app, enforces it), and request_fingerprint is a SHA-256 of the exact
--    request (account, schedule, body, options, media bytes, draft flag, card
--    and source). The same key with the same fingerprint returns the original
--    post; the same key with anything else is a conflict. Requests without a
--    key behave as before (both columns NULL).
ALTER TABLE social_posts
  ADD COLUMN idempotency_key     text CHECK (idempotency_key ~ '^[A-Za-z0-9._:/-]{1,200}$'),
  ADD COLUMN request_fingerprint text CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT social_posts_idempotency_pair_check CHECK ((idempotency_key IS NULL) = (request_fingerprint IS NULL));
CREATE UNIQUE INDEX social_posts_idempotency_key_idx ON social_posts (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- 2. Claims. A worker takes a due post with one conditional UPDATE and a
--    random claim_token; every later write by that worker is conditional on
--    the token, so an overlapping or stale worker cannot touch a post it no
--    longer holds. publishing_started_at (already there) is the lease start.
ALTER TABLE social_posts ADD COLUMN claim_token uuid;

-- 3. 'uncertain': the provider call may have gone out (timeout, lost
--    response, an accepted response without an id, a crash or a lease that
--    expired after the write-ahead row). Never retried automatically; only an
--    audited reconciliation (cli-social reconcile, POST /posts/:id/reconcile)
--    moves it on.
ALTER TABLE social_posts DROP CONSTRAINT social_posts_status_check;
ALTER TABLE social_posts ADD CONSTRAINT social_posts_status_check
  CHECK (status IN ('draft', 'queued', 'publishing', 'posted', 'failed', 'canceled', 'uncertain'));
CREATE INDEX social_posts_uncertain_idx ON social_posts (id) WHERE status = 'uncertain';

-- 4. Write-ahead provider attempts. A row in state 'sending' is committed
--    before the provider's publish call starts, under the post's row lock and
--    only while the worker still holds its claim. Whatever happens next, the
--    row says a send may have happened.
CREATE TABLE social_post_attempts (
  id           bigserial PRIMARY KEY,
  post_id      bigint NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  attempt_no   int NOT NULL CHECK (attempt_no >= 1),
  claim_token  uuid NOT NULL,
  state        text NOT NULL DEFAULT 'sending'
               CHECK (state IN ('sending', 'not_sent', 'rejected', 'sent', 'handed_off', 'uncertain')),
  started_at   timestamptz NOT NULL,
  finished_at  timestamptz,
  remote_id    text,
  error        text,
  UNIQUE (post_id, attempt_no)
);
-- At most one provider call in flight per post, whatever the app does.
CREATE UNIQUE INDEX social_post_attempts_one_sending_idx ON social_post_attempts (post_id) WHERE state = 'sending';

-- 5. The audit trail of every human resolution of an uncertain post.
CREATE TABLE social_post_reconciliations (
  id           bigserial PRIMARY KEY,
  post_id      bigint NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  attempt_id   bigint REFERENCES social_post_attempts(id) ON DELETE SET NULL,
  prior_status text NOT NULL,
  outcome      text NOT NULL CHECK (outcome IN ('posted', 'not_posted')),
  new_status   text NOT NULL CHECK (new_status IN ('posted', 'failed', 'queued')),
  remote_id    text,
  remote_url   text,
  note         text NOT NULL CHECK (length(note) BETWEEN 1 AND 2000),
  actor        text NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
  via          text NOT NULL CHECK (via IN ('cli', 'api')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (outcome <> 'posted' OR (remote_id IS NOT NULL AND new_status = 'posted')),
  CHECK (outcome <> 'not_posted' OR new_status IN ('failed', 'queued'))
);
CREATE INDEX social_post_reconciliations_post_idx ON social_post_reconciliations (post_id);

-- Down Migration

DROP TABLE social_post_reconciliations;
DROP TABLE social_post_attempts;
DROP INDEX social_posts_uncertain_idx;
-- The old schema has no 'uncertain'; 'failed' with a check-first message is
-- its closest meaning (the old code never retried a failed post either).
UPDATE social_posts SET status = 'failed',
  last_error = 'uncertain: the provider may have the post; check it before queueing again' || coalesce(' (' || last_error || ')', '')
  WHERE status = 'uncertain';
ALTER TABLE social_posts DROP CONSTRAINT social_posts_status_check;
ALTER TABLE social_posts ADD CONSTRAINT social_posts_status_check
  CHECK (status IN ('draft', 'queued', 'publishing', 'posted', 'failed', 'canceled'));
ALTER TABLE social_posts DROP COLUMN claim_token;
DROP INDEX social_posts_idempotency_key_idx;
ALTER TABLE social_posts DROP CONSTRAINT social_posts_idempotency_pair_check;
ALTER TABLE social_posts DROP COLUMN request_fingerprint, DROP COLUMN idempotency_key;

-- Up Migration
-- Owner reconciliation of a PR the owner merged outside the review gate.
-- The gate turns every done write on a gated card into a review round and blocks a job whose PR it did not merge
-- ("Unknown prior merge, owner reconciliation required"). This adds the owner verb those errors name: an immutable,
-- attested receipt (who, when, PR, merge commit, reason, the GitHub facts checked) that closes the job without
-- claiming a reviewer verdict and moves the card to done, which releases its dependants.

CREATE TABLE review_owner_merges (
  id bigserial PRIMARY KEY,
  card text NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  job bigint REFERENCES review_jobs(id) ON DELETE CASCADE,
  repo text NOT NULL,
  pr integer NOT NULL CHECK (pr > 0),
  merged text NOT NULL CHECK (merged ~ '^[a-f0-9]{40}$'),
  head text NOT NULL CHECK (head ~ '^[a-f0-9]{40}$'),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 8 AND 2000),
  reconciled_by name NOT NULL,
  reconciled_at timestamptz NOT NULL DEFAULT now(),
  attestation jsonb NOT NULL CHECK (octet_length(attestation::text) <= 20000),
  -- The transaction that wrote the receipt. Only that transaction may move the card past the gate.
  xact bigint NOT NULL,
  UNIQUE (card, pr, merged)
);
CREATE TRIGGER review_owner_merges_immutable BEFORE UPDATE OR DELETE ON review_owner_merges FOR EACH ROW EXECUTE FUNCTION review_immutable();
GRANT SELECT ON review_owner_merges TO sb_review_worker;

-- The owner only: superuser, database owner or owner of the review tables. The review worker login is refused: this
-- path trusts the caller's GitHub check (the unassigned case has no worker-recorded merge to bind to), and only the
-- owner, who can already bypass every trigger, may vouch for it. Never an org identity: a bot, builder or model
-- connection carries org.agent and is refused even on an owner login.
CREATE FUNCTION review_owner_authorize() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF coalesce(current_setting('org.agent', true), '') <> '' THEN
    RAISE EXCEPTION 'review: owner reconciliation is refused for org identity %', current_setting('org.agent', true);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = session_user AND rolsuper) THEN RETURN; END IF;
  IF session_user = (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) THEN RETURN; END IF;
  IF session_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.review_jobs'::regclass) THEN RETURN; END IF;
  RAISE EXCEPTION 'review: owner reconciliation requires the database owner login';
END $$;
REVOKE ALL ON FUNCTION review_owner_authorize() FROM PUBLIC;

-- The only states this verb recovers, exactly as the gate leaves them:
--   1. the latest job is blocked with one of the two owner-merge errors from gate.ts, and the worker recorded the
--      merge commit it saw on GitHub (j.merged), which must equal the merge being reconciled;
--   2. the card has no review job and no assignee, so every done write is refused with "original builder required".
-- Queued, reviewing, rejected, approved or otherwise blocked jobs are ordinary review work and are refused.
CREATE FUNCTION review_owner_stuck(c cards, j review_jobs, p_merged text) RETURNS text LANGUAGE plpgsql STABLE SET search_path = public AS $$
BEGIN
  IF c.id IS NULL THEN RAISE EXCEPTION 'review: no such card'; END IF;
  IF c.status IN ('done', 'archived') THEN RAISE EXCEPTION 'review: card % is already %; nothing to reconcile', c.id, c.status; END IF;
  IF NOT review_required(c.id) THEN RAISE EXCEPTION 'review: card % has no review gate; move it normally', c.id; END IF;
  IF j.id IS NULL THEN
    IF c.assignee IS NOT NULL THEN
      RAISE EXCEPTION 'review: card % has no review job and is assigned to %; no owner-merge problem to reconcile', c.id, c.assignee;
    END IF;
    RETURN 'unassigned';
  END IF;
  IF j.state <> 'blocked' OR j.error IS NULL OR j.error NOT IN ('Unknown prior merge, owner reconciliation required',
                                                                 'Merged revision has no accepted review; reconciliation required') THEN
    RAISE EXCEPTION 'review: review job % for card % is % (%); no owner-merge problem to reconcile', j.id, c.id, j.state, coalesce(j.error, 'no error');
  END IF;
  IF j.merged IS NULL THEN RAISE EXCEPTION 'review: review job % recorded no merge commit; let the worker retry it first', j.id; END IF;
  IF p_merged IS NOT NULL AND j.merged <> p_merged THEN
    RAISE EXCEPTION 'review: review job % recorded merge %, not %', j.id, j.merged, p_merged;
  END IF;
  RETURN 'owner-merge';
END $$;
REVOKE ALL ON FUNCTION review_owner_stuck(cards, review_jobs, text) FROM PUBLIC;

-- Read-only precheck before any GitHub call: the card must be stuck behind the gate, not already done.
CREATE FUNCTION review_owner_merge_check(p_card text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c cards; j review_jobs;
BEGIN
  PERFORM review_owner_authorize();
  SELECT * INTO c FROM cards WHERE id = p_card;
  IF c.id IS NULL THEN RAISE EXCEPTION 'review: no card %', p_card; END IF;
  SELECT * INTO j FROM review_jobs WHERE card = c.id ORDER BY round DESC LIMIT 1;
  RETURN jsonb_build_object('kind', review_owner_stuck(c, j, NULL), 'card', c.id, 'status', c.status, 'assignee', c.assignee, 'repo', c.repo, 'body', c.body,
    'job', j.id, 'state', j.state, 'pr', (j.snapshot->>'pr')::integer, 'merged', j.merged, 'error', j.error);
END $$;
REVOKE ALL ON FUNCTION review_owner_merge_check(text) FROM PUBLIC;

-- Owner only. The caller (cli-review reconcile-owner-merge) has already confirmed on GitHub that the PR is merged into the
-- registered base with exactly this merge commit and that its branch names the card; p_attestation is that record.
CREATE FUNCTION review_owner_reconcile(p_card text, p_pr integer, p_merged text, p_reason text, p_attestation jsonb)
RETURNS review_owner_merges LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c cards; j review_jobs; r review_owner_merges; prior review_owner_merges;
BEGIN
  PERFORM review_owner_authorize();
  IF p_merged IS NULL OR p_merged !~ '^[a-f0-9]{40}$' THEN RAISE EXCEPTION 'review: merge commit must be a full 40 character sha'; END IF;
  IF p_pr IS NULL OR p_pr <= 0 THEN RAISE EXCEPTION 'review: PR number required'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 8 THEN RAISE EXCEPTION 'review: a reason of at least 8 characters is required'; END IF;
  IF p_attestation->>'state' IS DISTINCT FROM 'MERGED' OR p_attestation->>'merged' IS DISTINCT FROM p_merged
     OR (p_attestation->>'pr')::integer IS DISTINCT FROM p_pr OR coalesce(p_attestation->>'repo', '') = ''
     OR coalesce(p_attestation->>'head', '') !~ '^[a-f0-9]{40}$' THEN
    RAISE EXCEPTION 'review: GitHub attestation does not show PR % merged as %', p_pr, p_merged;
  END IF;
  SELECT * INTO c FROM cards WHERE id = p_card FOR UPDATE;
  IF c.id IS NULL THEN RAISE EXCEPTION 'review: no card %', p_card; END IF;
  SELECT * INTO prior FROM review_owner_merges WHERE card = c.id AND pr = p_pr AND merged = p_merged;
  IF prior.id IS NOT NULL AND c.status = 'done' THEN RETURN prior; END IF;
  SELECT * INTO j FROM review_jobs WHERE card = c.id ORDER BY round DESC LIMIT 1 FOR UPDATE;
  PERFORM review_owner_stuck(c, j, p_merged);
  IF j.snapshot IS NOT NULL AND (j.snapshot->>'pr')::integer IS DISTINCT FROM p_pr THEN
    RAISE EXCEPTION 'review: review job % is for PR %, not PR %', j.id, j.snapshot->>'pr', p_pr;
  END IF;
  IF j.snapshot IS NOT NULL AND j.snapshot->>'repo' IS DISTINCT FROM p_attestation->>'repo' THEN
    RAISE EXCEPTION 'review: review job % is for repository %, not %', j.id, j.snapshot->>'repo', p_attestation->>'repo';
  END IF;
  -- Never race the worker: it holds these session locks while it reviews or ships this job.
  IF j.id IS NOT NULL AND NOT pg_try_advisory_xact_lock(hashtextextended('review-job:' || j.id, 0)) THEN
    RAISE EXCEPTION 'review: the review worker is processing job %; retry when it finishes', j.id;
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('review-content:' || c.id, 0)) THEN
    RAISE EXCEPTION 'review: card % evidence is locked by the review worker; retry when it finishes', c.id;
  END IF;

  INSERT INTO review_owner_merges (card, job, repo, pr, merged, head, reason, reconciled_by, attestation, xact)
  VALUES (c.id, j.id, p_attestation->>'repo', p_pr, p_merged, p_attestation->>'head', btrim(p_reason), session_user, p_attestation, txid_current())
  RETURNING * INTO r;
  IF j.id IS NOT NULL THEN
    -- Closed without a reviewer verdict: verdict, deployed and health are left as they were.
    UPDATE review_jobs SET state = 'done', merged = p_merged, error = NULL, updated_at = now() WHERE id = j.id;
    INSERT INTO review_attempts (job, patch) VALUES (j.id, jsonb_build_object('owner_reconciled', r.id, 'merged', p_merged, 'pr', p_pr, 'by', session_user));
  END IF;
  UPDATE review_corrections SET state = 'cancelled', error = 'Owner reconciled a merge made outside the gate', lease_token = NULL, lease_until = NULL, updated_at = now()
   WHERE card = c.id AND state IN ('queued', 'claimed', 'starting', 'running', 'retry');
  UPDATE card_runs SET finished_at = now(), outcome = 'partial' WHERE card_id = c.id AND finished_at IS NULL;
  UPDATE cards SET status = 'done', completed_at = now(), block_kind = NULL, block_reason = NULL WHERE id = c.id;
  PERFORM board_event(c.id, 'owner-reconciled', NULL, jsonb_build_object('receipt', r.id, 'job', j.id, 'repo', r.repo, 'pr', p_pr,
    'merged', p_merged, 'by', session_user, 'reason', r.reason, 'from', c.status, 'assignee', c.assignee));
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION review_owner_reconcile(text, integer, text, text, jsonb) FROM PUBLIC;

-- The gate, unchanged except for one clause: a done write in the same transaction as an owner-merge receipt passes.
-- The receipt is only writable by review_owner_reconcile, and xact pins it to that one transaction, so a later
-- reopen and finish goes through review as before.
CREATE OR REPLACE FUNCTION review_submission_gate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p review_policy; j review_jobs; gated boolean;
BEGIN
  SELECT * INTO p FROM review_policy;
  SELECT * INTO j FROM review_jobs WHERE card = NEW.id ORDER BY round DESC LIMIT 1;
  IF j.id IS NULL AND NOT OLD.review_enforced AND OLD.status IN ('done','archived') AND NEW.status=OLD.status THEN RETURN NEW; END IF;
  gated := j.id IS NOT NULL OR OLD.review_enforced
    OR (review_applies(OLD.repo,OLD.body,OLD.board_slug) AND review_is_code(OLD.work_type,OLD.needs,OLD.kind))
    OR (review_applies(NEW.repo,NEW.body,NEW.board_slug) AND review_is_code(NEW.work_type,NEW.needs,NEW.kind));
  IF NOT gated THEN RETURN NEW; END IF;
  IF j.id IS NOT NULL AND
     (NEW.repo IS DISTINCT FROM OLD.repo OR NEW.work_type IS DISTINCT FROM OLD.work_type OR NEW.assignee IS DISTINCT FROM OLD.assignee OR NEW.board_slug IS DISTINCT FROM OLD.board_slug) THEN
    RAISE EXCEPTION 'review: preserve original builder, repository and work type';
  END IF;
  IF p.enabled AND review_is_code(OLD.work_type,OLD.needs,OLD.kind) AND NOT review_is_code(NEW.work_type,NEW.needs,NEW.kind) THEN
    RAISE EXCEPTION 'review: coding classification cannot bypass policy';
  END IF;
  IF NEW.status = 'done' AND OLD.status NOT IN ('done','archived')
     AND EXISTS (SELECT 1 FROM review_owner_merges r WHERE r.card = NEW.id AND r.xact = txid_current()) THEN
    RETURN NEW;
  END IF;
  IF NEW.status IN ('done','archived') AND j.state = 'done' THEN
    IF p.worker_login <> session_user OR NOT pg_has_role(session_user, 'sb_review_worker', 'member') THEN
      -- Repeated completion cannot change the accepted revision or result.
      IF OLD.status = 'done' AND NEW.status = 'done' THEN RETURN OLD; END IF;
      RAISE EXCEPTION 'review: only worker finalizes shipping';
    END IF;
    IF j.merged IS NULL OR j.deployed IS DISTINCT FROM j.merged OR j.health IS DISTINCT FROM j.merged OR j.verdict->>'decision' <> 'accept' THEN
      RAISE EXCEPTION 'review: missing shipping receipt';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IN ('done','review','archived') THEN
    IF j.id IS NULL OR (j.state = 'rejected' AND OLD.status NOT IN ('review','done','archived')) THEN
      IF NEW.assignee IS NULL THEN RAISE EXCEPTION 'review: original builder required'; END IF;
      INSERT INTO review_jobs(card,builder,reviewer,repo,round)
      VALUES(NEW.id,NEW.assignee,coalesce(j.reviewer,p.reviewer),NEW.repo,coalesce(j.round+1,0))
      ON CONFLICT(card,round) DO NOTHING;
      PERFORM board_event(NEW.id,'review-submitted',NEW.assignee,jsonb_build_object('round',coalesce(j.round+1,0)));
    END IF;
    NEW.status := 'review'; NEW.completed_at := NULL;
  ELSIF j.id IS NOT NULL AND j.state NOT IN ('rejected','done') AND NEW.status IN ('ready','running','todo','scheduled') THEN
    IF p.worker_login IS DISTINCT FROM session_user THEN RAISE EXCEPTION 'review: submission is pending'; END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION review_submission_gate() FROM PUBLIC;

-- Down Migration
-- Deliberately forward only, like the review gate: receipts are part of the shipping record.

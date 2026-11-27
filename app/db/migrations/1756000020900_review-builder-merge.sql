-- Up Migration
-- Owner-controlled independent review mode (docs/automatic-review.md, "Review mode").
--
-- independent_review = true (the default, and the only behaviour before this migration): every gated submission needs
-- an accepted critical-only verdict from the independent reviewer, bound to the exact PR head, before the worker merges.
--
-- independent_review = false: a submission whose original builder is on the owner's builder_merge_agents list is
-- merged by the trusted review worker without a reviewer call, after the same mechanical checks (required CI on the exact
-- head, readiness, verification, staged evidence, branch protection, merge-parent checks, deployment and health). The
-- job records a builder merge authorization, never a verdict, so no receipt claims an independent review happened.
--
-- Toggling: the mode is frozen per submission when the job is created. Relaxing review never downgrades an active
-- submission; it applies from the next submission round. Tightening (turning review back on, or removing the builder
-- from the list) applies at once to every builder submission not yet merged: the worker withdraws its authorization
-- and the job goes to independent review. A job that already merged under builder authorization keeps that history.
ALTER TABLE review_policy ADD COLUMN independent_review boolean NOT NULL DEFAULT true;
ALTER TABLE review_policy ADD COLUMN builder_merge_agents text[] NOT NULL DEFAULT '{}';

ALTER TABLE review_jobs ADD COLUMN mode text NOT NULL DEFAULT 'independent' CHECK (mode IN ('independent','builder'));
ALTER TABLE review_jobs ADD COLUMN merge_authorization jsonb CHECK (octet_length(merge_authorization::text) <= 20000);

-- The effective mode right now: builder only while the job was submitted in builder mode, it has not been tightened,
-- review is enabled, the owner still has independent review off and the original builder is still listed and active.
CREATE FUNCTION review_effective_mode(j review_jobs) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN j.mode = 'builder' AND EXISTS (
      SELECT 1 FROM review_policy p JOIN org_agents a ON a.name = j.builder
       WHERE p.enabled AND NOT p.independent_review AND j.builder = ANY (p.builder_merge_agents) AND a.retired_at IS NULL)
    THEN 'builder' ELSE 'independent' END
$$;
REVOKE ALL ON FUNCTION review_effective_mode(review_jobs) FROM PUBLIC;

-- Mode is decided by the database from owner policy when a submission is created, never by the caller.
CREATE FUNCTION review_jobs_mode() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.merge_authorization := NULL;
    NEW.mode := CASE WHEN EXISTS (SELECT 1 FROM review_policy p JOIN org_agents a ON a.name = NEW.builder
        WHERE p.enabled AND NOT p.independent_review AND NEW.builder = ANY (p.builder_merge_agents) AND a.retired_at IS NULL)
      THEN 'builder' ELSE 'independent' END;
    RETURN NEW;
  END IF;
  IF NEW.mode IS DISTINCT FROM OLD.mode AND NOT (OLD.mode = 'builder' AND NEW.mode = 'independent' AND OLD.merged IS NULL) THEN
    RAISE EXCEPTION 'review: submission mode can only tighten to independent review before merge';
  END IF;
  IF OLD.merged IS NOT NULL AND NEW.merge_authorization IS DISTINCT FROM OLD.merge_authorization THEN
    RAISE EXCEPTION 'review: builder merge authorization is part of the merge receipt';
  END IF;
  -- An authorization is bound to the exact recorded head. Any change of snapshot or mode before merge drops it.
  IF NEW.merged IS NULL AND NEW.merge_authorization IS NOT NULL AND (NEW.mode <> 'builder' OR NEW.snapshot IS NULL
      OR NEW.snapshot->>'head' IS DISTINCT FROM NEW.merge_authorization->>'head'
      OR NEW.snapshot->>'base' IS DISTINCT FROM NEW.merge_authorization->>'base') THEN
    NEW.merge_authorization := NULL;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION review_jobs_mode() FROM PUBLIC;
CREATE TRIGGER review_jobs_mode BEFORE INSERT OR UPDATE ON review_jobs FOR EACH ROW EXECUTE FUNCTION review_jobs_mode();

-- What a gated job needs before shipping receipts can complete it: an accepted independent verdict, or a builder
-- merge authorization bound to the same snapshot head on a builder-mode job.
CREATE FUNCTION review_job_approved(j review_jobs) RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT coalesce(j.verdict->>'decision' = 'accept', false)
      OR coalesce(j.mode = 'builder' AND j.verdict IS NULL AND j.merge_authorization->>'mode' = 'builder'
         AND j.merge_authorization->>'builder' = j.builder AND j.merge_authorization->>'head' = j.snapshot->>'head', false)
$$;
REVOKE ALL ON FUNCTION review_job_approved(review_jobs) FROM PUBLIC;

-- Worker only. Records the builder merge authorization for the exact head and base of the job's recorded snapshot.
CREATE FUNCTION review_builder_authorize(p_job bigint, p_auth jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j review_jobs; a jsonb;
BEGIN
  PERFORM review_authorize();
  SELECT * INTO STRICT j FROM review_jobs WHERE id = p_job FOR UPDATE;
  IF j.state IN ('done','rejected') OR j.merged IS NOT NULL THEN RAISE EXCEPTION 'review: builder merge authorization only before merge'; END IF;
  IF review_effective_mode(j) <> 'builder' THEN RAISE EXCEPTION 'review: owner policy requires independent review for this submission'; END IF;
  IF j.verdict IS NOT NULL THEN RAISE EXCEPTION 'review: a review verdict is recorded; builder merge authorization refused'; END IF;
  IF j.snapshot IS NULL OR p_auth->>'mode' IS DISTINCT FROM 'builder' OR p_auth->>'builder' IS DISTINCT FROM j.builder
     OR coalesce(p_auth->>'head','') !~ '^[a-f0-9]{40}$' OR p_auth->>'head' IS DISTINCT FROM j.snapshot->>'head'
     OR p_auth->>'base' IS DISTINCT FROM j.snapshot->>'base' OR p_auth->>'repo' IS DISTINCT FROM j.snapshot->>'repo'
     OR (p_auth->>'pr')::integer IS DISTINCT FROM (j.snapshot->>'pr')::integer OR coalesce(p_auth->>'evidence','') !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'review: builder merge authorization must bind the exact recorded head';
  END IF;
  a := p_auth || jsonb_build_object('authorized_by', session_user::text, 'authorized_at', now());
  UPDATE review_jobs SET merge_authorization = a, updated_at = now() WHERE id = p_job;
  INSERT INTO review_attempts(job, patch) VALUES (p_job, jsonb_build_object('merge_authorization', a));
  PERFORM board_event(j.card, 'review-builder-authorized', j.builder, jsonb_build_object('job', j.id, 'head', a->>'head', 'pr', a->'pr', 'independent_review', false));
  RETURN a;
END $$;
REVOKE ALL ON FUNCTION review_builder_authorize(bigint, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION review_builder_authorize(bigint, jsonb) TO sb_review_worker;

-- Worker only. Moves an unmerged builder submission to independent review after the owner tightened policy.
CREATE FUNCTION review_builder_withdraw(p_job bigint, p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j review_jobs;
BEGIN
  PERFORM review_authorize();
  SELECT * INTO STRICT j FROM review_jobs WHERE id = p_job FOR UPDATE;
  IF j.mode = 'independent' THEN RETURN; END IF;
  IF j.merged IS NOT NULL OR j.state IN ('done','rejected') THEN RAISE EXCEPTION 'review: a merged builder submission keeps its history'; END IF;
  IF review_effective_mode(j) = 'builder' THEN RAISE EXCEPTION 'review: owner policy still allows builder merge'; END IF;
  UPDATE review_jobs SET mode = 'independent', merge_authorization = NULL, updated_at = now() WHERE id = p_job;
  INSERT INTO review_attempts(job, patch) VALUES (p_job, jsonb_build_object('mode', 'independent', 'reason', left(coalesce(p_reason,''), 500)));
  PERFORM board_event(j.card, 'review-mode-tightened', NULL, jsonb_build_object('job', j.id, 'reason', left(coalesce(p_reason,''), 500)));
END $$;
REVOKE ALL ON FUNCTION review_builder_withdraw(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION review_builder_withdraw(bigint, text) TO sb_review_worker;

-- Read-only runner contract: which path a card's submission takes. Grants no authority.
CREATE FUNCTION review_merge_mode(p_card text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE p review_policy; j review_jobs; c cards; listed boolean;
BEGIN
  SELECT * INTO p FROM review_policy;
  SELECT * INTO c FROM cards WHERE id = p_card;
  IF c.id IS NULL THEN RAISE EXCEPTION 'review: no card %', p_card; END IF;
  SELECT * INTO j FROM review_jobs WHERE card = c.id ORDER BY round DESC LIMIT 1;
  listed := coalesce(c.assignee = ANY (p.builder_merge_agents), false) AND EXISTS (SELECT 1 FROM org_agents a WHERE a.name = c.assignee AND a.retired_at IS NULL);
  RETURN jsonb_build_object(
    'card', c.id, 'gated', review_required(c.id), 'review_enabled', coalesce(p.enabled, false),
    'independent_review', coalesce(p.independent_review, true), 'builder', c.assignee, 'builder_authorized', listed,
    'job', j.id, 'round', j.round, 'state', j.state,
    -- The active submission's frozen mode and what applies now; with no active submission, what the next one gets.
    'submission_mode', j.mode,
    'mode', CASE WHEN j.id IS NOT NULL AND j.state NOT IN ('done','rejected') THEN review_effective_mode(j)
                 WHEN coalesce(p.enabled AND NOT p.independent_review, false) AND listed THEN 'builder' ELSE 'independent' END,
    'merged', j.merged, 'merge_authorized', j.merge_authorization IS NOT NULL);
END $$;
REVOKE ALL ON FUNCTION review_merge_mode(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION review_merge_mode(text) TO sb_review_worker, sb_org;

-- Completion: unchanged except that a builder-mode job completes on its builder merge authorization and records a
-- builder-shipped event that says no independent review took place.
CREATE OR REPLACE FUNCTION review_complete(p_job bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j review_jobs;
BEGIN
  PERFORM review_authorize();
  SELECT * INTO STRICT j FROM review_jobs WHERE id=p_job FOR UPDATE;
  IF j.state='done' THEN RETURN; END IF;
  IF NOT EXISTS(SELECT 1 FROM review_policy WHERE enabled AND shipping_enabled) THEN RAISE EXCEPTION 'review: shipping is disabled'; END IF;
  IF j.state<>'deployed' OR j.merged IS NULL OR j.merged IS DISTINCT FROM j.deployed OR j.merged IS DISTINCT FROM j.health OR
    NOT review_job_approved(j) THEN RAISE EXCEPTION 'review: no deployment receipt'; END IF;
  UPDATE review_jobs SET state='done',error=NULL,updated_at=now() WHERE id=j.id;
  UPDATE cards SET status='done',completed_at=now(),block_kind=NULL,block_reason=NULL WHERE id=j.card;
  IF j.verdict->>'decision' = 'accept' THEN
    PERFORM board_event(j.card,'review-shipped',j.reviewer,jsonb_build_object('job',j.id,'merged',j.merged,'deployed',j.deployed,'mode','independent','independent_review',true));
  ELSE
    PERFORM board_event(j.card,'builder-shipped',j.builder,jsonb_build_object('job',j.id,'merged',j.merged,'deployed',j.deployed,'mode','builder','independent_review',false,
      'head',j.merge_authorization->>'head','authorized_by',j.merge_authorization->>'authorized_by'));
  END IF;
END $$;

-- The gate as of 1756000018800, with one change: the done receipt check accepts review_job_approved(j).
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
    IF j.merged IS NULL OR j.deployed IS DISTINCT FROM j.merged OR j.health IS DISTINCT FROM j.merged OR NOT review_job_approved(j) THEN
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
-- Forward only, like the rest of the review gate: builder merge authorizations are part of the shipping record.

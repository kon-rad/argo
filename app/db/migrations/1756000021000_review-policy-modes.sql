-- Up Migration
-- Replace the boolean/allowlist waiver with one owner-controlled policy mode.
ALTER TABLE review_policy ADD COLUMN mode text NOT NULL DEFAULT 'review'
  CHECK (mode IN ('review','checks-only','off'));
UPDATE review_policy SET mode=CASE WHEN independent_review THEN 'review' ELSE 'checks-only' END;

ALTER TABLE review_jobs DROP CONSTRAINT IF EXISTS review_jobs_mode_check;
UPDATE review_jobs SET mode=CASE mode WHEN 'independent' THEN 'review' WHEN 'builder' THEN 'checks-only' ELSE mode END;
ALTER TABLE review_jobs ADD CONSTRAINT review_jobs_mode_check CHECK (mode IN ('review','checks-only'));
ALTER TABLE review_jobs ALTER COLUMN mode SET DEFAULT 'review';

CREATE OR REPLACE FUNCTION review_applies(p_repo text,p_body text,p_board text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT EXISTS(SELECT 1 FROM review_policy WHERE enabled AND mode<>'off'
   AND (boards IS NULL OR p_board=ANY(boards))
   AND (repositories IS NULL OR lower(coalesce((regexp_match(coalesce(p_body,''),'^[ \t]*Repo:[ \t]*([A-Za-z0-9_.-]+)[ \t]*$','in'))[1],p_repo))=ANY(repositories)))
$$;

CREATE OR REPLACE FUNCTION review_effective_mode(j review_jobs) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN j.merged IS NOT NULL THEN j.mode
    WHEN NOT p.enabled OR p.mode='off' THEN 'off'
    WHEN j.mode='checks-only' AND p.mode='review' THEN 'review'
    ELSE j.mode END
  FROM review_policy p
$$;

CREATE OR REPLACE FUNCTION review_jobs_mode() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    NEW.merge_authorization:=NULL;
    SELECT CASE WHEN mode='checks-only' THEN 'checks-only' ELSE 'review' END INTO NEW.mode FROM review_policy;
    RETURN NEW;
  END IF;
  IF NEW.mode IS DISTINCT FROM OLD.mode AND NOT (OLD.mode='checks-only' AND NEW.mode='review' AND OLD.merged IS NULL) THEN
    RAISE EXCEPTION 'review: submission mode can only tighten to review before merge';
  END IF;
  IF OLD.merged IS NOT NULL AND (NEW.mode IS DISTINCT FROM OLD.mode OR NEW.merge_authorization IS DISTINCT FROM OLD.merge_authorization) THEN
    RAISE EXCEPTION 'review: mode and authorization are part of the merge receipt';
  END IF;
  IF NEW.merged IS NULL AND NEW.merge_authorization IS NOT NULL AND (NEW.mode<>'checks-only' OR NEW.snapshot IS NULL
      OR NEW.snapshot->>'head' IS DISTINCT FROM NEW.merge_authorization->>'head'
      OR NEW.snapshot->>'base' IS DISTINCT FROM NEW.merge_authorization->>'base') THEN NEW.merge_authorization:=NULL; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION review_job_approved(j review_jobs) RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT coalesce(j.verdict->>'decision'='accept',false) OR coalesce(j.mode='checks-only' AND j.verdict IS NULL
    AND j.merge_authorization->>'mode'='checks-only' AND j.merge_authorization->>'builder'=j.builder
    AND j.merge_authorization->>'head'=j.snapshot->>'head',false)
$$;

CREATE OR REPLACE FUNCTION review_builder_authorize(p_job bigint,p_auth jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE j review_jobs; a jsonb;
BEGIN
  PERFORM review_authorize(); SELECT * INTO STRICT j FROM review_jobs WHERE id=p_job FOR UPDATE;
  IF j.state IN ('done','rejected') OR j.merged IS NOT NULL THEN RAISE EXCEPTION 'review: checks-only authorization only before merge'; END IF;
  IF review_effective_mode(j)<>'checks-only' THEN RAISE EXCEPTION 'review: owner policy does not allow checks-only for this submission'; END IF;
  IF j.verdict IS NOT NULL THEN RAISE EXCEPTION 'review: a review verdict is recorded; checks-only authorization refused'; END IF;
  IF j.snapshot IS NULL OR p_auth->>'mode' IS DISTINCT FROM 'checks-only' OR p_auth->>'builder' IS DISTINCT FROM j.builder
    OR coalesce(p_auth->>'head','')!~'^[a-f0-9]{40}$' OR p_auth->>'head' IS DISTINCT FROM j.snapshot->>'head'
    OR p_auth->>'base' IS DISTINCT FROM j.snapshot->>'base' OR p_auth->>'repo' IS DISTINCT FROM j.snapshot->>'repo'
    OR (p_auth->>'pr')::integer IS DISTINCT FROM (j.snapshot->>'pr')::integer OR coalesce(p_auth->>'evidence','')!~'^[a-f0-9]{64}$'
    THEN RAISE EXCEPTION 'review: checks-only authorization must bind the exact recorded head'; END IF;
  a:=p_auth||jsonb_build_object('authorized_by',session_user::text,'authorized_at',now());
  UPDATE review_jobs SET merge_authorization=a,updated_at=now() WHERE id=p_job;
  INSERT INTO review_attempts(job,patch) VALUES(p_job,jsonb_build_object('merge_authorization',a));
  PERFORM board_event(j.card,'review-checks-authorized',j.builder,jsonb_build_object('job',j.id,'head',a->>'head','pr',a->'pr','mode','checks-only'));
  RETURN a;
END $$;

CREATE OR REPLACE FUNCTION review_builder_withdraw(p_job bigint,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE j review_jobs;
BEGIN
  PERFORM review_authorize(); SELECT * INTO STRICT j FROM review_jobs WHERE id=p_job FOR UPDATE;
  IF j.mode='review' THEN RETURN; END IF;
  IF j.merged IS NOT NULL OR j.state IN ('done','rejected') THEN RAISE EXCEPTION 'review: a merged checks-only submission keeps its history'; END IF;
  IF review_effective_mode(j)<>'review' THEN RAISE EXCEPTION 'review: owner policy does not require review'; END IF;
  UPDATE review_jobs SET mode='review',merge_authorization=NULL,updated_at=now() WHERE id=p_job;
  INSERT INTO review_attempts(job,patch) VALUES(p_job,jsonb_build_object('mode','review','reason',left(coalesce(p_reason,''),500)));
  PERFORM board_event(j.card,'review-mode-tightened',NULL,jsonb_build_object('job',j.id,'reason',left(coalesce(p_reason,''),500)));
END $$;

CREATE OR REPLACE FUNCTION review_merge_mode(p_card text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE p review_policy; j review_jobs; c cards;
BEGIN
  SELECT * INTO p FROM review_policy; SELECT * INTO c FROM cards WHERE id=p_card;
  IF c.id IS NULL THEN RAISE EXCEPTION 'review: no card %',p_card; END IF;
  SELECT * INTO j FROM review_jobs WHERE card=c.id ORDER BY round DESC LIMIT 1;
  RETURN jsonb_build_object('card',c.id,'gated',review_required(c.id),'enabled',p.enabled,'policy_mode',p.mode,
    'job',j.id,'round',j.round,'state',j.state,'submission_mode',j.mode,
    'mode',CASE WHEN j.id IS NOT NULL AND j.state NOT IN ('done','rejected') THEN review_effective_mode(j) ELSE p.mode END,
    'merged',j.merged,'authorized',j.merge_authorization IS NOT NULL);
END $$;

CREATE FUNCTION review_policy_status() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT jsonb_build_object('enabled',enabled,'mode',mode,'shipping_enabled',shipping_enabled,'reviewer',reviewer,
   'active', (SELECT count(*) FROM review_jobs WHERE state NOT IN ('done','rejected')),
   'unmerged', (SELECT count(*) FROM review_jobs WHERE state NOT IN ('done','rejected') AND merged IS NULL)) FROM review_policy
$$;
REVOKE ALL ON FUNCTION review_policy_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION review_policy_status() TO sb_review_worker,sb_org;

CREATE OR REPLACE FUNCTION review_complete(p_job bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE j review_jobs;
BEGIN
  PERFORM review_authorize(); SELECT * INTO STRICT j FROM review_jobs WHERE id=p_job FOR UPDATE;
  IF j.state='done' THEN RETURN; END IF;
  IF NOT EXISTS(SELECT 1 FROM review_policy WHERE enabled AND shipping_enabled) THEN RAISE EXCEPTION 'review: shipping is disabled'; END IF;
  IF j.state<>'deployed' OR j.merged IS NULL OR j.merged IS DISTINCT FROM j.deployed OR j.merged IS DISTINCT FROM j.health OR NOT review_job_approved(j)
    THEN RAISE EXCEPTION 'review: no deployment receipt'; END IF;
  UPDATE review_jobs SET state='done',error=NULL,updated_at=now() WHERE id=j.id;
  UPDATE cards SET status='done',completed_at=now(),block_kind=NULL,block_reason=NULL WHERE id=j.card;
  IF j.mode='review' THEN
    PERFORM board_event(j.card,'review-shipped',j.reviewer,jsonb_build_object('job',j.id,'merged',j.merged,'deployed',j.deployed,'mode','review','model_review',true));
  ELSE
    PERFORM board_event(j.card,'checks-only-shipped',j.builder,jsonb_build_object('job',j.id,'merged',j.merged,'deployed',j.deployed,'mode','checks-only','model_review',false,'head',j.merge_authorization->>'head','authorized_by',j.merge_authorization->>'authorized_by'));
  END IF;
END $$;

-- Down Migration
-- Forward only. Submission modes and release receipts are audit records.

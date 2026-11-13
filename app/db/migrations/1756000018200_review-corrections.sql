-- Up Migration
-- Owner opt-in. Disabled installations retain the review gate's legacy ready/wake behavior.
ALTER TABLE review_policy ADD COLUMN corrections_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE review_launches (
  card text PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
  builder text NOT NULL REFERENCES org_agents(name) ON UPDATE CASCADE,
  persona text NOT NULL, runtime text NOT NULL, model text NOT NULL, host text NOT NULL,
  repo text NOT NULL, branch text NOT NULL, worktree text NOT NULL, common_dir text NOT NULL,
  original_run_id text NOT NULL, stage text CHECK(stage IN ('plan','build','correction')),
  registered_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE review_feedback (
  id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'),
  job bigint NOT NULL REFERENCES review_jobs(id) ON DELETE CASCADE,
  card text NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  repo text NOT NULL, pr integer NOT NULL CHECK(pr>0), base text NOT NULL CHECK(base ~ '^[a-f0-9]{40}$'),
  head text NOT NULL CHECK(head ~ '^[a-f0-9]{40}$'), evidence_hash text NOT NULL CHECK(evidence_hash ~ '^[a-f0-9]{64}$'),
  finding_hash text NOT NULL CHECK(finding_hash ~ '^[a-f0-9]{64}$'),
  code text NOT NULL, severity text NOT NULL CHECK(severity IN ('critical','high','medium','low')),
  reason text NOT NULL, evidence text NOT NULL, required_fix text NOT NULL, verification text NOT NULL,
  producer_kind text NOT NULL CHECK(producer_kind IN ('reviewer','coordinator')), producer text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(job,head,evidence_hash,finding_hash)
);
CREATE TABLE review_corrections (
  id bigserial PRIMARY KEY, feedback_id text NOT NULL UNIQUE REFERENCES review_feedback(id),
  card text NOT NULL REFERENCES cards(id) ON DELETE CASCADE, launch_card text NOT NULL REFERENCES review_launches(card),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','claimed','starting','running','retry','review','cancelled','blocked')),
  head text NOT NULL CHECK(head ~ '^[a-f0-9]{40}$'), completion_head text CHECK(completion_head ~ '^[a-f0-9]{40}$'), base text NOT NULL CHECK(base ~ '^[a-f0-9]{40}$'), pr integer NOT NULL,
  evidence_hash text NOT NULL CHECK(evidence_hash ~ '^[a-f0-9]{64}$'),
  lease_token text, lease_until timestamptz, fence bigint NOT NULL DEFAULT 0,
  run_id text UNIQUE, process_id text, transient_attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(), error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX review_corrections_active_card ON review_corrections(card) WHERE state IN ('queued','claimed','starting','running','retry');
GRANT SELECT ON review_launches,review_feedback,review_corrections TO sb_review_worker;

CREATE FUNCTION review_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'review: immutable record'; END $$;
CREATE TRIGGER review_launches_immutable BEFORE UPDATE OR DELETE ON review_launches FOR EACH ROW EXECUTE FUNCTION review_immutable();
CREATE TRIGGER review_feedback_immutable BEFORE UPDATE OR DELETE ON review_feedback FOR EACH ROW EXECUTE FUNCTION review_immutable();

CREATE FUNCTION review_register_launch(p_launch jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c cards; prior review_launches;
BEGIN
 PERFORM review_authorize(); SELECT * INTO STRICT c FROM cards WHERE id=p_launch->>'card' FOR UPDATE;
 IF c.assignee IS NULL OR c.assignee IS DISTINCT FROM p_launch->>'builder' THEN RAISE EXCEPTION 'review: launch builder is not the trusted assignee'; END IF;
 IF p_launch->>'worktree' !~ '^/' OR p_launch->>'commonDir' !~ '^/' OR coalesce(p_launch->>'originalRunId','')='' THEN RAISE EXCEPTION 'review: invalid launch identity'; END IF;
 IF p_launch ? 'stage' AND p_launch->>'stage' NOT IN ('plan','build','correction') THEN RAISE EXCEPTION 'review: invalid launch stage'; END IF;
 SELECT * INTO prior FROM review_launches WHERE card=c.id;
 IF prior.card IS NOT NULL THEN
   IF to_jsonb(prior)-ARRAY['created_at','registered_by'] IS DISTINCT FROM jsonb_build_object('card',p_launch->>'card','builder',p_launch->>'builder','persona',p_launch->>'persona','runtime',p_launch->>'runtime','model',p_launch->>'model','host',p_launch->>'host','repo',p_launch->>'repo','branch',p_launch->>'branch','worktree',p_launch->>'worktree','common_dir',p_launch->>'commonDir','original_run_id',p_launch->>'originalRunId','stage',p_launch->>'stage') THEN RAISE EXCEPTION 'review: launch identity is immutable'; END IF;
   RETURN;
 END IF;
 INSERT INTO review_launches(card,builder,persona,runtime,model,host,repo,branch,worktree,common_dir,original_run_id,stage,registered_by)
 VALUES(c.id,p_launch->>'builder',p_launch->>'persona',p_launch->>'runtime',p_launch->>'model',p_launch->>'host',p_launch->>'repo',p_launch->>'branch',p_launch->>'worktree',p_launch->>'commonDir',p_launch->>'originalRunId',p_launch->>'stage',session_user);
END $$;
REVOKE ALL ON FUNCTION review_register_launch(jsonb) FROM PUBLIC; GRANT EXECUTE ON FUNCTION review_register_launch(jsonb) TO sb_review_worker;

DROP FUNCTION review_save(bigint,jsonb);
CREATE FUNCTION review_save(p_job bigint, p_patch jsonb, p_origin text DEFAULT 'reviewer') RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j review_jobs; p review_policy; v jsonb; finding jsonb; finding_identity jsonb; fhash text; fid text; first_feedback text; snap jsonb;
BEGIN
  PERFORM review_authorize(); SELECT * INTO STRICT j FROM review_jobs WHERE id=p_job FOR UPDATE; SELECT * INTO p FROM review_policy;
  IF p_origin NOT IN ('reviewer','coordinator') THEN RAISE EXCEPTION 'review: invalid trusted feedback origin'; END IF;
  IF j.reviewer IS DISTINCT FROM p.reviewer OR j.builder=j.reviewer THEN RAISE EXCEPTION 'review: unauthorized reviewer or self-review'; END IF;
  IF j.state IN ('done','rejected') THEN RETURN; END IF;
  IF p_patch ? 'target' AND j.target IS NOT NULL AND p_patch->>'target' IS DISTINCT FROM j.target THEN RAISE EXCEPTION 'review: target changed'; END IF;
  v := coalesce(p_patch->'verdict',j.verdict);
  IF v IS NOT NULL AND v <> 'null'::jsonb AND (v->>'reviewer' IS DISTINCT FROM j.reviewer OR v->>'decision' NOT IN ('accept','reject') OR v->>'head' !~ '^[a-f0-9]{40}$' OR v->>'evidence' !~ '^[a-f0-9]{64}$') THEN RAISE EXCEPTION 'review: invalid verdict'; END IF;
  UPDATE review_jobs SET state=coalesce(p_patch->>'state',state),target=coalesce(target,p_patch->>'target'),snapshot=CASE WHEN p_patch?'snapshot' THEN nullif(p_patch->'snapshot','null'::jsonb) ELSE snapshot END,verdict=CASE WHEN p_patch?'verdict' THEN nullif(p_patch->'verdict','null'::jsonb) ELSE verdict END,merged=coalesce(p_patch->>'merged',merged),deployed=coalesce(p_patch->>'deployed',deployed),health=coalesce(p_patch->>'health',health),error=CASE WHEN p_patch?'error' THEN p_patch->>'error' ELSE error END,updated_at=now() WHERE id=p_job RETURNING * INTO j;
  IF j.state='done' THEN RAISE EXCEPTION 'review: use review_complete'; END IF;
  INSERT INTO review_attempts(job,patch) VALUES(p_job,p_patch);
  IF j.state='blocked' THEN UPDATE cards SET status='blocked',block_kind='tool-error',block_reason=j.error WHERE id=j.card; PERFORM board_event(j.card,'review-blocked',j.reviewer,jsonb_build_object('job',j.id,'error',j.error,'merged',j.merged,'deployed',j.deployed)); END IF;
  IF j.state='rejected' THEN
    IF j.verdict->>'decision' IS DISTINCT FROM 'reject' THEN RAISE EXCEPTION 'review: rejection requires findings'; END IF;
    snap:=coalesce(j.snapshot,p_patch->'snapshot');
    FOR finding IN SELECT value FROM jsonb_array_elements(coalesce(j.verdict->'findings','[]'::jsonb)) LOOP
      INSERT INTO card_comments(card_id,author,body) VALUES(j.card,j.reviewer,left(format('[review %s] Changes requested [%s] %s\nEvidence: %s\nImpact: %s\nRequired fix: %s\nVerification: %s',j.id,finding->>'severity',finding->>'location',finding->>'evidence',finding->>'impact',finding->>'fix',finding->>'verification'),7900));
      IF p.corrections_enabled THEN
        IF snap->>'repo' IS NULL OR (snap->>'pr')::integer IS NULL OR snap->>'base' !~ '^[a-f0-9]{40}$' OR j.verdict->>'head' !~ '^[a-f0-9]{40}$' THEN RAISE EXCEPTION 'review: revision-bound feedback required'; END IF;
        finding_identity:=jsonb_build_object('code',coalesce(finding->>'code','code-finding'),'severity',coalesce(finding->>'severity','high'),'location',coalesce(finding->>'location',''),'evidence',coalesce(finding->>'evidence','No evidence supplied'),'impact',coalesce(finding->>'impact',''),'fix',coalesce(finding->>'fix','Address the finding'),'verification',coalesce(finding->>'verification','Rerun required checks'));
        fhash:=md5(finding_identity::text)||md5('finding|'||finding_identity::text);
        fid:=md5(concat_ws('|',j.id,j.verdict->>'head',j.verdict->>'evidence',fhash))||md5(concat_ws('|','feedback',j.id,j.verdict->>'head',j.verdict->>'evidence',fhash));
        INSERT INTO review_feedback(id,job,card,repo,pr,base,head,evidence_hash,finding_hash,code,severity,reason,evidence,required_fix,verification,producer_kind,producer)
        VALUES(fid,j.id,j.card,snap->>'repo',(snap->>'pr')::integer,snap->>'base',j.verdict->>'head',j.verdict->>'evidence',fhash,finding_identity->>'code',finding_identity->>'severity',coalesce(nullif(finding_identity->>'impact',''),nullif(finding_identity->>'location',''),'Review finding'),finding_identity->>'evidence',finding_identity->>'fix',finding_identity->>'verification',p_origin,CASE WHEN p_origin='coordinator' THEN session_user ELSE j.reviewer END) ON CONFLICT(job,head,evidence_hash,finding_hash) DO NOTHING;
        first_feedback:=coalesce(first_feedback,fid);
      END IF;
    END LOOP;
    IF j.round>=p.max_rounds THEN
      UPDATE cards SET status='blocked',rounds=rounds+1,block_kind='review-changes',block_reason='Automatic correction limit reached; reviewer findings require escalation' WHERE id=j.card;
    ELSIF p.corrections_enabled THEN
      IF first_feedback IS NULL THEN RAISE EXCEPTION 'review: actionable finding required'; END IF;
      IF NOT EXISTS(SELECT 1 FROM review_launches l WHERE l.card=j.card AND l.builder=j.builder) THEN UPDATE cards SET status='blocked',rounds=rounds+1,block_kind='review-changes',block_reason='Trusted original launch identity is missing; automatic correction blocked' WHERE id=j.card;
      ELSE
        UPDATE cards SET status='ready',rounds=rounds+1,block_kind=NULL,block_reason=NULL WHERE id=j.card;
        INSERT INTO review_corrections(feedback_id,card,launch_card,head,base,pr,evidence_hash) VALUES(first_feedback,j.card,j.card,j.verdict->>'head',snap->>'base',(snap->>'pr')::integer,j.verdict->>'evidence') ON CONFLICT DO NOTHING;
      END IF;
    ELSE
      UPDATE cards SET status='ready',rounds=rounds+1,block_kind=NULL,block_reason=NULL WHERE id=j.card; PERFORM board_wake(j.card);
    END IF;
    PERFORM board_event(j.card,'review-rejected',j.reviewer,jsonb_build_object('job',j.id,'round',j.round,'feedback',first_feedback));
  END IF;
END $$;
REVOKE ALL ON FUNCTION review_save(bigint,jsonb,text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION review_save(bigint,jsonb,text) TO sb_review_worker;

CREATE FUNCTION review_correction_claim(p_host text,p_ttl integer DEFAULT 300) RETURNS TABLE(id bigint,feedback_id text,card text,builder text,persona text,runtime text,model text,host text,repo text,branch text,worktree text,common_dir text,original_run_id text,head text,base text,pr integer,evidence_hash text,lease_token text,fence bigint,transient_attempts integer) LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE item review_corrections; token text;
BEGIN
 PERFORM review_authorize(); IF p_ttl NOT BETWEEN 1 AND 3600 THEN RAISE EXCEPTION 'review: invalid lease ttl'; END IF;
 IF NOT EXISTS(SELECT 1 FROM review_policy WHERE corrections_enabled) THEN RETURN; END IF;
 FOR item IN SELECT q.* FROM review_corrections q JOIN review_launches l ON l.card=q.launch_card WHERE q.state IN ('claimed','starting') AND q.lease_until<now() AND l.host=p_host ORDER BY q.lease_until,q.id LIMIT 100 FOR UPDATE OF q SKIP LOCKED LOOP
   IF NOT EXISTS(SELECT 1 FROM cards c JOIN review_feedback f ON f.id=item.feedback_id WHERE c.id=item.card AND c.status='ready' AND f.job=(SELECT max(j.id) FROM review_jobs j WHERE j.card=item.card)) THEN
     UPDATE review_corrections SET state='cancelled',error='Correction superseded before expired lease reconciliation',updated_at=now() WHERE review_corrections.id=item.id;
   ELSIF item.state='starting' OR item.run_id IS NOT NULL THEN
     UPDATE review_corrections SET state='blocked',error='Correction launch may have started but was not acknowledged; owner reconciliation required',updated_at=now() WHERE review_corrections.id=item.id;
     UPDATE cards SET status='blocked',block_kind='tool-error',block_reason='Correction launch state is ambiguous; reconcile the reserved run before retrying' WHERE cards.id=item.card AND cards.status='ready' AND (SELECT max(j.id) FROM review_jobs j WHERE j.card=cards.id)=(SELECT f.job FROM review_feedback f WHERE f.id=item.feedback_id);
   ELSIF item.transient_attempts>=9 OR item.created_at<now()-interval '24 hours' THEN
     UPDATE review_corrections SET state='blocked',error='Expired correction claim retry limit reached',updated_at=now() WHERE review_corrections.id=item.id;
     UPDATE cards SET status='blocked',block_kind='tool-error',block_reason='Correction worker repeatedly claimed without starting; owner reconciliation required' WHERE cards.id=item.card AND cards.status='ready' AND (SELECT max(j.id) FROM review_jobs j WHERE j.card=cards.id)=(SELECT f.job FROM review_feedback f WHERE f.id=item.feedback_id);
   ELSE
     UPDATE review_corrections q SET state='retry',lease_token=NULL,lease_until=NULL,transient_attempts=q.transient_attempts+1,available_at=now(),error='Expired claim reconciled as proven no-start',updated_at=now() WHERE q.id=item.id;
   END IF;
 END LOOP;
 SELECT q.* INTO item FROM review_corrections q JOIN review_launches l ON l.card=q.launch_card JOIN cards c ON c.id=q.card WHERE q.state IN ('queued','retry') AND q.available_at<=now() AND l.host=p_host AND c.status='ready' ORDER BY q.created_at,q.id LIMIT 1 FOR UPDATE OF q SKIP LOCKED;
 IF item.id IS NULL THEN RETURN; END IF; token:=md5(random()::text||clock_timestamp()::text||item.id::text)||md5(session_user||item.id::text);
 UPDATE review_corrections q SET state='claimed',lease_token=token,lease_until=now()+make_interval(secs=>p_ttl),fence=q.fence+1,updated_at=now() WHERE q.id=item.id;
 RETURN QUERY SELECT q.id,q.feedback_id,q.card,l.builder,l.persona,l.runtime,l.model,l.host,l.repo,l.branch,l.worktree,l.common_dir,l.original_run_id,q.head,q.base,q.pr,q.evidence_hash,q.lease_token,q.fence,q.transient_attempts FROM review_corrections q JOIN review_launches l ON l.card=q.launch_card WHERE q.id=item.id;
END $$;
REVOKE ALL ON FUNCTION review_correction_claim(text,integer) FROM PUBLIC; GRANT EXECUTE ON FUNCTION review_correction_claim(text,integer) TO sb_review_worker;

CREATE FUNCTION review_correction_prepare(p_id bigint,p_token text,p_run text,p_head text) RETURNS TABLE(state text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE q review_corrections; c cards; bound_job bigint; latest_job bigint;
BEGIN
 PERFORM review_authorize(); SELECT * INTO STRICT q FROM review_corrections WHERE id=p_id FOR UPDATE;
 IF q.state IN ('starting','running') AND q.run_id=p_run THEN RETURN QUERY SELECT q.state; RETURN; END IF;
 IF q.state='cancelled' THEN RETURN QUERY SELECT q.state; RETURN; END IF;
 IF q.state<>'claimed' OR q.lease_token IS DISTINCT FROM p_token OR q.lease_until<now() THEN RAISE EXCEPTION 'review: invalid or expired correction lease'; END IF;
 IF q.head IS DISTINCT FROM p_head OR coalesce(p_run,'')='' THEN RAISE EXCEPTION 'review: stale correction head or missing run id'; END IF;
 IF EXISTS(SELECT 1 FROM review_corrections WHERE run_id=p_run AND id<>p_id) THEN RAISE EXCEPTION 'review: run id already registered'; END IF;
 SELECT * INTO STRICT c FROM cards WHERE id=q.card FOR UPDATE;
 SELECT f.job INTO STRICT bound_job FROM review_feedback f WHERE f.id=q.feedback_id;
 SELECT max(j.id) INTO latest_job FROM review_jobs j WHERE j.card=q.card;
 IF c.status IS DISTINCT FROM 'ready' OR latest_job IS DISTINCT FROM bound_job THEN
   UPDATE review_corrections SET state='cancelled',error='Correction superseded before launch preparation',updated_at=now() WHERE id=p_id RETURNING review_corrections.state INTO q.state;
   RETURN QUERY SELECT q.state; RETURN;
 END IF;
 UPDATE review_corrections SET state='starting',run_id=p_run,updated_at=now() WHERE id=p_id RETURNING review_corrections.state INTO q.state;
 RETURN QUERY SELECT q.state;
END $$;
REVOKE ALL ON FUNCTION review_correction_prepare(bigint,text,text,text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION review_correction_prepare(bigint,text,text,text) TO sb_review_worker;

CREATE FUNCTION review_correction_ack(p_id bigint,p_token text,p_run text,p_process text,p_head text) RETURNS TABLE(state text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE q review_corrections; l review_launches; c cards; bound_job bigint; latest_job bigint;
BEGIN
 PERFORM review_authorize(); SELECT * INTO STRICT q FROM review_corrections WHERE id=p_id FOR UPDATE; SELECT * INTO STRICT l FROM review_launches WHERE card=q.launch_card;
 IF q.state='running' AND q.run_id=p_run AND q.process_id=p_process THEN RETURN QUERY SELECT q.state; RETURN; END IF;
 IF q.state='cancelled' THEN RETURN QUERY SELECT q.state; RETURN; END IF;
 IF q.state<>'starting' OR q.run_id IS DISTINCT FROM p_run OR q.lease_token IS DISTINCT FROM p_token OR q.lease_until<now() THEN RAISE EXCEPTION 'review: launch must be prepared under a live correction lease'; END IF;
 IF q.head IS DISTINCT FROM p_head THEN RAISE EXCEPTION 'review: stale correction head'; END IF;
 SELECT * INTO STRICT c FROM cards WHERE id=q.card FOR UPDATE;
 SELECT f.job INTO STRICT bound_job FROM review_feedback f WHERE f.id=q.feedback_id;
 SELECT max(j.id) INTO latest_job FROM review_jobs j WHERE j.card=q.card;
 IF c.status IS DISTINCT FROM 'ready' OR latest_job IS DISTINCT FROM bound_job THEN
   UPDATE review_corrections SET state='cancelled',error='Correction superseded before launch acknowledgement',updated_at=now() WHERE id=p_id RETURNING review_corrections.state INTO q.state;
   RETURN QUERY SELECT q.state; RETURN;
 END IF;
 INSERT INTO card_runs(card_id,agent_name,runtime,run_id,lease_until) VALUES(q.card,l.builder,l.runtime,p_run,q.lease_until);
 UPDATE cards SET status='running',started_at=coalesce(started_at,now()),block_kind=NULL,block_reason=NULL WHERE id=q.card AND status='ready';
 IF NOT FOUND THEN RAISE EXCEPTION 'review: correction card is no longer ready'; END IF;
 UPDATE review_corrections SET state='running',run_id=p_run,process_id=p_process,updated_at=now() WHERE id=p_id RETURNING review_corrections.state INTO q.state;
 RETURN QUERY SELECT q.state;
END $$;
REVOKE ALL ON FUNCTION review_correction_ack(bigint,text,text,text,text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION review_correction_ack(bigint,text,text,text,text) TO sb_review_worker;

CREATE FUNCTION review_correction_retry(p_id bigint,p_token text,p_reason text,p_delay integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE q review_corrections; c cards; bound_job bigint; latest_job bigint; BEGIN PERFORM review_authorize(); SELECT * INTO STRICT q FROM review_corrections WHERE id=p_id FOR UPDATE;
 IF q.state IN ('cancelled','blocked') THEN RETURN; END IF;
 IF q.state<>'claimed' OR q.lease_token IS DISTINCT FROM p_token OR q.run_id IS NOT NULL THEN RAISE EXCEPTION 'review: only an unstarted claimed correction may retry'; END IF;
 IF p_delay NOT BETWEEN 1 AND 86400 THEN RAISE EXCEPTION 'review: invalid retry delay'; END IF;
 SELECT * INTO STRICT c FROM cards WHERE id=q.card FOR UPDATE;
 SELECT f.job INTO STRICT bound_job FROM review_feedback f WHERE f.id=q.feedback_id;
 SELECT max(j.id) INTO latest_job FROM review_jobs j WHERE j.card=q.card;
 IF c.status IS DISTINCT FROM 'ready' OR latest_job IS DISTINCT FROM bound_job THEN UPDATE review_corrections SET state='cancelled',error='Correction superseded before retry',updated_at=now() WHERE id=p_id; RETURN; END IF;
 IF q.transient_attempts>=9 OR q.created_at<now()-interval '24 hours' THEN UPDATE review_corrections SET state='blocked',error='Transient correction retry limit reached',updated_at=now() WHERE id=p_id; UPDATE cards SET status='blocked',block_kind='tool-error',block_reason='Correction host remained unavailable; owner reconciliation required' WHERE id=q.card AND status='ready' AND (SELECT max(j.id) FROM review_jobs j WHERE j.card=q.card)=bound_job; RETURN; END IF;
 UPDATE review_corrections target SET state='retry',lease_token=NULL,lease_until=NULL,transient_attempts=target.transient_attempts+1,available_at=now()+make_interval(secs=>p_delay),error=p_reason,updated_at=now() WHERE target.id=p_id; END $$;
REVOKE ALL ON FUNCTION review_correction_retry(bigint,text,text,integer) FROM PUBLIC; GRANT EXECUTE ON FUNCTION review_correction_retry(bigint,text,text,integer) TO sb_review_worker;

CREATE FUNCTION review_correction_cancel(p_id bigint,p_token text,p_fence bigint,p_run text,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE q review_corrections; c cards; r card_runs; bound_job bigint; latest_job bigint; current_attempt boolean;
BEGIN PERFORM review_authorize(); SELECT * INTO STRICT q FROM review_corrections WHERE id=p_id FOR UPDATE;
 IF q.state IN ('review','cancelled','blocked') THEN RETURN; END IF;
 SELECT * INTO STRICT c FROM cards WHERE id=q.card FOR UPDATE;
 IF q.lease_token IS DISTINCT FROM p_token OR q.fence IS DISTINCT FROM p_fence OR
    (q.run_id IS NULL AND p_run IS NOT NULL) OR (q.run_id IS NOT NULL AND q.run_id IS DISTINCT FROM p_run) THEN
   RAISE EXCEPTION 'review: stale correction callback';
 END IF;
 SELECT * INTO r FROM card_runs WHERE card_id=q.card AND finished_at IS NULL FOR UPDATE;
 SELECT f.job INTO STRICT bound_job FROM review_feedback f WHERE f.id=q.feedback_id;
 SELECT max(j.id) INTO latest_job FROM review_jobs j WHERE j.card=q.card;
 current_attempt:=latest_job=bound_job AND ((q.state='running' AND c.status='running' AND r.run_id=q.run_id) OR (q.state<>'running' AND c.status='ready' AND r.id IS NULL));
 IF q.state='running' THEN UPDATE card_runs SET finished_at=now(),outcome='partial' WHERE card_id=q.card AND run_id=q.run_id AND finished_at IS NULL; END IF;
 UPDATE review_corrections SET state='cancelled',error=p_reason,updated_at=now() WHERE id=p_id;
 IF current_attempt THEN UPDATE cards SET status='blocked',block_kind='review-changes',block_reason=p_reason WHERE id=q.card; END IF;
END $$;
REVOKE ALL ON FUNCTION review_correction_cancel(bigint,text,bigint,text,text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION review_correction_cancel(bigint,text,bigint,text,text) TO sb_review_worker;

CREATE FUNCTION review_correction_reconcile(p_id bigint,p_token text,p_fence bigint,p_run text,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE q review_corrections; c cards; r card_runs; bound_job bigint; latest_job bigint; current_attempt boolean;
BEGIN PERFORM review_authorize(); SELECT * INTO STRICT q FROM review_corrections WHERE id=p_id FOR UPDATE;
 IF q.state IN ('review','cancelled','blocked') THEN RETURN; END IF;
 SELECT * INTO STRICT c FROM cards WHERE id=q.card FOR UPDATE;
 IF q.lease_token IS DISTINCT FROM p_token OR q.fence IS DISTINCT FROM p_fence OR
    (q.run_id IS NULL AND p_run IS NOT NULL) OR (q.run_id IS NOT NULL AND q.run_id IS DISTINCT FROM p_run) THEN
   RAISE EXCEPTION 'review: stale correction callback';
 END IF;
 SELECT * INTO r FROM card_runs WHERE card_id=q.card AND finished_at IS NULL FOR UPDATE;
 SELECT f.job INTO STRICT bound_job FROM review_feedback f WHERE f.id=q.feedback_id;
 SELECT max(j.id) INTO latest_job FROM review_jobs j WHERE j.card=q.card;
 current_attempt:=latest_job=bound_job AND ((q.state='running' AND c.status='running' AND r.run_id=q.run_id) OR (q.state<>'running' AND c.status='ready' AND r.id IS NULL));
 UPDATE review_corrections SET state='blocked',error=p_reason,updated_at=now() WHERE id=p_id;
 IF current_attempt THEN UPDATE cards SET status='blocked',block_kind='tool-error',block_reason=p_reason WHERE id=q.card; END IF;
END $$;
REVOKE ALL ON FUNCTION review_correction_reconcile(bigint,text,bigint,text,text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION review_correction_reconcile(bigint,text,bigint,text,text) TO sb_review_worker;

CREATE FUNCTION review_correction_finish(p_id bigint,p_run text,p_head text,p_completion_head text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE q review_corrections; c cards; r card_runs; bound_job bigint; latest_job bigint;
BEGIN PERFORM review_authorize(); SELECT * INTO STRICT q FROM review_corrections WHERE id=p_id FOR UPDATE;
 IF q.run_id IS DISTINCT FROM p_run OR q.head IS DISTINCT FROM p_head THEN RAISE EXCEPTION 'review: stale or unknown correction run'; END IF;
 IF p_completion_head !~ '^[a-f0-9]{40}$' OR p_completion_head=p_head THEN RAISE EXCEPTION 'review: invalid trusted completion head'; END IF;
 IF q.state='review' AND q.completion_head=p_completion_head THEN RETURN; END IF;
 IF q.state='cancelled' THEN RETURN; END IF; IF q.state<>'running' OR q.completion_head IS NOT NULL THEN RAISE EXCEPTION 'review: stale or unknown correction run'; END IF;
 SELECT * INTO STRICT c FROM cards WHERE id=q.card FOR UPDATE;
 SELECT f.job INTO STRICT bound_job FROM review_feedback f WHERE f.id=q.feedback_id;
 SELECT max(j.id) INTO latest_job FROM review_jobs j WHERE j.card=q.card;
 SELECT * INTO r FROM card_runs WHERE card_id=q.card AND finished_at IS NULL FOR UPDATE;
 IF c.status IS DISTINCT FROM 'running' OR latest_job IS DISTINCT FROM bound_job OR r.run_id IS DISTINCT FROM p_run THEN
   UPDATE card_runs SET finished_at=now(),outcome='partial' WHERE card_id=q.card AND run_id=p_run AND finished_at IS NULL;
   UPDATE review_corrections SET state='cancelled',error='Correction superseded before finish',updated_at=now() WHERE id=p_id;
   RETURN;
 END IF;
 UPDATE card_runs SET finished_at=now(),outcome='done' WHERE id=r.id;
 UPDATE review_corrections SET state='review',completion_head=p_completion_head,updated_at=now() WHERE id=p_id;
 UPDATE cards SET status='review' WHERE id=q.card AND status='running';
END $$;
REVOKE ALL ON FUNCTION review_correction_finish(bigint,text,text,text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION review_correction_finish(bigint,text,text,text) TO sb_review_worker;

-- Down Migration
-- Forward only. Disabling corrections retains immutable feedback and queued evidence.

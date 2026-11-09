-- Up Migration
-- Policy is owner-written, never writable by a board token or org identity.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sb_review_worker') THEN
    CREATE ROLE sb_review_worker NOLOGIN;
  END IF;
END $$;
CREATE TABLE review_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  shipping_enabled boolean NOT NULL DEFAULT false,
  boards text[],
  repositories text[],
  max_rounds integer NOT NULL DEFAULT 2 CHECK(max_rounds BETWEEN 0 AND 10),
  reviewer text,
  worker_login name,
  CHECK (NOT enabled OR (reviewer IS NOT NULL AND worker_login IS NOT NULL))
);
INSERT INTO review_policy DEFAULT VALUES;
CREATE TABLE review_jobs (
  id bigserial PRIMARY KEY,
  card text NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  builder text NOT NULL REFERENCES org_agents(name),
  reviewer text NOT NULL REFERENCES org_agents(name),
  repo text,
  target text,
  round integer NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','reviewing','approved','merging','merged','deploying','deployed','blocked','rejected','done')),
  snapshot jsonb CHECK (octet_length(snapshot::text)<=1000000),
  verdict jsonb CHECK (octet_length(verdict::text)<=100000),
  merged text CHECK (merged ~ '^[a-f0-9]{40}$'),
  deployed text CHECK (deployed ~ '^[a-f0-9]{40}$'),
  health text CHECK (health ~ '^[a-f0-9]{40}$'),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(card, round)
);
CREATE UNIQUE INDEX review_jobs_active ON review_jobs(card) WHERE state NOT IN ('rejected','done');
CREATE TABLE review_attempts (
  id bigserial PRIMARY KEY,
  job bigint NOT NULL REFERENCES review_jobs(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  patch jsonb NOT NULL
);
GRANT USAGE ON SCHEMA public TO sb_review_worker;
GRANT SELECT ON review_policy, review_jobs, review_attempts TO sb_review_worker;

CREATE FUNCTION review_authorize() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM review_policy p WHERE p.worker_login = session_user
      AND pg_has_role(session_user, 'sb_review_worker', 'member')
      AND EXISTS(SELECT 1 FROM org_agents a WHERE a.name=p.reviewer AND a.retired_at IS NULL AND 'review'=ANY(a.capabilities))) THEN
    RAISE EXCEPTION 'review: dedicated worker login required';
  END IF;
END $$;
REVOKE ALL ON FUNCTION review_authorize() FROM PUBLIC;

CREATE FUNCTION review_applies(p_repo text,p_body text,p_board text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT EXISTS(SELECT 1 FROM review_policy WHERE enabled
   AND (boards IS NULL OR p_board=ANY(boards))
   AND (repositories IS NULL OR lower(coalesce((regexp_match(coalesce(p_body,''),'^[ \t]*Repo:[ \t]*([A-Za-z0-9_.-]+)[ \t]*$','in'))[1],p_repo))=ANY(repositories)))
$$;
REVOKE ALL ON FUNCTION review_applies(text,text,text) FROM PUBLIC;

-- Runs before both existing completion functions and the runner's review handoff.
-- No configurable GUC can grant completion authority. The durable receipt is required.
CREATE FUNCTION review_submission_gate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p review_policy; j review_jobs; gated boolean;
BEGIN
  SELECT * INTO p FROM review_policy;
  SELECT * INTO j FROM review_jobs WHERE card = NEW.id ORDER BY round DESC LIMIT 1;
  gated := j.id IS NOT NULL OR (review_applies(NEW.repo,NEW.body,NEW.board_slug) AND coalesce(OLD.work_type='coding' OR OLD.needs='code' OR NEW.work_type='coding' OR NEW.needs='code',false));
  IF NOT gated THEN RETURN NEW; END IF;
  IF j.id IS NOT NULL AND
     (NEW.repo IS DISTINCT FROM OLD.repo OR NEW.work_type IS DISTINCT FROM OLD.work_type OR NEW.assignee IS DISTINCT FROM OLD.assignee) THEN
    RAISE EXCEPTION 'review: preserve original builder, repository and work type';
  END IF;
  IF p.enabled AND (OLD.work_type='coding' OR OLD.needs='code') AND NOT (coalesce(NEW.work_type,'')='coding' OR coalesce(NEW.needs,'')='code') THEN
    RAISE EXCEPTION 'review: coding classification cannot bypass policy';
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
CREATE TRIGGER cards_review_gate BEFORE UPDATE ON cards FOR EACH ROW EXECUTE FUNCTION review_submission_gate();

CREATE FUNCTION review_context(p_job bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j review_jobs; result jsonb;
BEGIN
  PERFORM review_authorize();
  SELECT * INTO STRICT j FROM review_jobs WHERE id=p_job;
  SELECT jsonb_build_object(
    'ticket', (SELECT to_jsonb(c) - 'tsv' - 'updated_at' - 'status' - 'completed_at' - 'block_kind' - 'block_reason' FROM cards c WHERE id=j.card),
    'comments', coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM (SELECT * FROM card_comments WHERE card_id=j.card ORDER BY id LIMIT 101) c WHERE NOT EXISTS
      (SELECT 1 FROM review_jobs r WHERE r.card=j.card AND c.author=r.reviewer AND c.body LIKE '[review ' || r.id || ']%')), '[]'::jsonb),
    'dependencies', coalesce((SELECT jsonb_agg(to_jsonb(c) - 'tsv' ORDER BY c.id) FROM (SELECT * FROM card_deps WHERE card_id=j.card ORDER BY depends_on LIMIT 101) d JOIN cards c ON c.id=d.depends_on),'[]'::jsonb),
    'conversations', coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM (SELECT * FROM org_messages WHERE task_id=j.card OR thread_id IN
      (SELECT coalesce(thread_id,id) FROM org_messages WHERE task_id=j.card) ORDER BY id LIMIT 101) m), '[]'::jsonb),
    'runs', coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM (SELECT * FROM card_runs WHERE card_id=j.card ORDER BY id LIMIT 101) r),'[]'::jsonb),
    'earlier_findings', coalesce((SELECT jsonb_agg(jsonb_build_object('round',round,'pr',snapshot->'pr','verdict',left(verdict::text,8000),'truncated',octet_length(verdict::text)>8000) ORDER BY round) FROM (SELECT * FROM review_jobs WHERE card=j.card AND id<j.id ORDER BY round LIMIT 101) history),'[]'::jsonb),
    'project', (SELECT to_jsonb(p) FROM projects p JOIN cards c ON c.project_slug=p.slug WHERE c.id=j.card),
    'feature', (SELECT to_jsonb(f) FROM features f JOIN cards c ON c.project_slug=f.project_slug AND c.feature_slug=f.slug WHERE c.id=j.card)
  ) INTO result;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION review_context(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION review_context(bigint) TO sb_review_worker;

CREATE FUNCTION review_save(p_job bigint, p_patch jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j review_jobs; p review_policy; v jsonb; finding jsonb;
BEGIN
  PERFORM review_authorize();
  SELECT * INTO STRICT j FROM review_jobs WHERE id=p_job FOR UPDATE;
  SELECT * INTO p FROM review_policy;
  IF j.reviewer IS DISTINCT FROM p.reviewer OR j.builder=j.reviewer THEN RAISE EXCEPTION 'review: unauthorized reviewer or self-review'; END IF;
  IF j.state IN ('done','rejected') THEN RETURN; END IF;
  IF p_patch ? 'target' AND j.target IS NOT NULL AND p_patch->>'target' IS DISTINCT FROM j.target THEN
    RAISE EXCEPTION 'review: target changed';
  END IF;
  v := coalesce(p_patch->'verdict',j.verdict);
  IF v IS NOT NULL AND v <> 'null'::jsonb THEN
    IF v->>'reviewer' IS DISTINCT FROM j.reviewer OR v->>'decision' NOT IN ('accept','reject') OR
       v->>'head' !~ '^[a-f0-9]{40}$' OR v->>'evidence' !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'review: invalid verdict';
    END IF;
  END IF;
  UPDATE review_jobs SET
    state=coalesce(p_patch->>'state',state), target=coalesce(target,p_patch->>'target'),
    snapshot=CASE WHEN p_patch ? 'snapshot' THEN nullif(p_patch->'snapshot','null'::jsonb) ELSE snapshot END,
    verdict=CASE WHEN p_patch ? 'verdict' THEN nullif(p_patch->'verdict','null'::jsonb) ELSE verdict END,
    merged=coalesce(p_patch->>'merged',merged), deployed=coalesce(p_patch->>'deployed',deployed), health=coalesce(p_patch->>'health',health),
    error=CASE WHEN p_patch ? 'error' THEN p_patch->>'error' ELSE error END, updated_at=now()
    WHERE id=p_job RETURNING * INTO j;
  IF j.state='done' THEN RAISE EXCEPTION 'review: use review_complete'; END IF;
  INSERT INTO review_attempts(job,patch) VALUES(p_job,p_patch);
  IF j.state='blocked' THEN
    UPDATE cards SET status='blocked',block_kind='tool-error',block_reason=j.error WHERE id=j.card;
    PERFORM board_event(j.card,'review-blocked',j.reviewer,jsonb_build_object('job',j.id,'error',j.error,'merged',j.merged,'deployed',j.deployed));
  END IF;
  IF j.state='rejected' THEN
    IF j.verdict->>'decision' IS DISTINCT FROM 'reject' THEN RAISE EXCEPTION 'review: rejection requires findings'; END IF;
    FOR finding IN SELECT value FROM jsonb_array_elements(coalesce(j.verdict->'findings','[]'::jsonb)) LOOP
      INSERT INTO card_comments(card_id,author,body) VALUES(j.card,j.reviewer,left(format('[review %s] Changes requested [%s] %s\nEvidence: %s\nImpact: %s\nRequired fix: %s\nVerification: %s',j.id,finding->>'severity',finding->>'location',finding->>'evidence',finding->>'impact',finding->>'fix',finding->>'verification'),7900));
    END LOOP;
    UPDATE cards SET status=CASE WHEN j.round>=p.max_rounds THEN 'blocked' ELSE 'ready' END,rounds=rounds+1,block_kind=CASE WHEN j.round>=p.max_rounds THEN 'review-changes' ELSE NULL END,block_reason=CASE WHEN j.round>=p.max_rounds THEN 'Automatic correction limit reached; reviewer findings require escalation' ELSE NULL END WHERE id=j.card;
    PERFORM board_event(j.card,'review-rejected',j.reviewer,jsonb_build_object('job',j.id,'round',j.round));
    IF j.round<p.max_rounds THEN PERFORM board_wake(j.card); END IF;
  END IF;
END $$;
REVOKE ALL ON FUNCTION review_save(bigint,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION review_save(bigint,jsonb) TO sb_review_worker;

CREATE FUNCTION review_complete(p_job bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j review_jobs;
BEGIN
  PERFORM review_authorize();
  SELECT * INTO STRICT j FROM review_jobs WHERE id=p_job FOR UPDATE;
  IF j.state='done' THEN RETURN; END IF;
  IF NOT EXISTS(SELECT 1 FROM review_policy WHERE enabled AND shipping_enabled) THEN RAISE EXCEPTION 'review: shipping is disabled'; END IF;
  IF j.state<>'deployed' OR j.merged IS NULL OR j.merged IS DISTINCT FROM j.deployed OR j.merged IS DISTINCT FROM j.health OR
    j.verdict->>'decision' IS DISTINCT FROM 'accept' THEN RAISE EXCEPTION 'review: no deployment receipt'; END IF;
  UPDATE review_jobs SET state='done',error=NULL,updated_at=now() WHERE id=j.id;
  UPDATE cards SET status='done',completed_at=now(),block_kind=NULL,block_reason=NULL WHERE id=j.card;
  PERFORM board_event(j.card,'review-shipped',j.reviewer,jsonb_build_object('job',j.id,'merged',j.merged,'deployed',j.deployed));
END $$;
REVOKE ALL ON FUNCTION review_complete(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION review_complete(bigint) TO sb_review_worker;

CREATE OR REPLACE FUNCTION board_card_move(p_by text, p_card text, p_status text, p_note text, p_block_kind text, p_rounds integer)
RETURNS cards LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c org_agents; card cards; was text;
BEGIN
  c := board_caller(p_by);
  SELECT * INTO card FROM cards WHERE id = p_card FOR UPDATE;
  IF card.id IS NULL THEN RAISE EXCEPTION 'no card %', p_card; END IF;
  IF c.runtime <> 'human' AND NOT ('dispatch' = ANY (c.capabilities)) THEN
    IF card.assignee IS DISTINCT FROM c.name THEN RAISE EXCEPTION '% can''t move %''s card', c.name, card.assignee; END IF;
    IF p_status = 'archived' OR (p_status = 'done' AND NOT (review_applies(card.repo,card.body,card.board_slug) AND (card.work_type='coding' OR card.needs='code'))) THEN RAISE EXCEPTION 'finish the card (cli-board finish) instead of moving it to %', p_status; END IF;
  END IF;
  IF card.status = 'running' AND p_status <> 'running' AND EXISTS (SELECT 1 FROM card_runs WHERE card_id = p_card AND finished_at IS NULL) THEN
    UPDATE card_runs SET finished_at = now(), outcome = 'partial' WHERE card_id = p_card AND finished_at IS NULL;
  END IF;
  was := card.status;
  UPDATE cards SET status = p_status,
         started_at = CASE WHEN p_status = 'running' THEN coalesce(started_at, now()) ELSE started_at END,
         completed_at = CASE WHEN p_status = 'done' THEN coalesce(completed_at, now()) ELSE completed_at END,
         block_kind = CASE WHEN p_status = 'blocked' THEN coalesce(p_block_kind, block_kind, 'other')
                           WHEN p_status IN ('ready', 'todo', 'running', 'done') THEN NULL ELSE block_kind END,
         block_reason = CASE WHEN p_status = 'blocked' THEN coalesce(p_note, block_reason)
                             WHEN p_status IN ('ready', 'todo', 'running', 'done') THEN NULL ELSE block_reason END,
         rounds = coalesce(p_rounds, rounds)
   WHERE id = p_card RETURNING * INTO card;
  PERFORM board_event(p_card, 'moved', c.name, json_build_object('from', was, 'to', p_status, 'note', p_note)::jsonb);
  IF p_status = 'ready' THEN PERFORM board_wake(p_card); END IF;
  RETURN card;
END
$$;


-- Existing shipping wrappers must not let a ship-now approval bypass this gate.
CREATE FUNCTION review_required(p_card text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM review_jobs WHERE card=p_card) OR EXISTS
    (SELECT 1 FROM cards WHERE cards.id=p_card AND review_applies(repo,body,board_slug) AND (work_type='coding' OR needs='code'))
$$;
REVOKE ALL ON FUNCTION review_required(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION review_required(text) TO sb_org;


-- Evidence writers share the worker's content lock. This closes the ticket/comment
-- race between verdict validation and the external compare-and-swap merge.
CREATE FUNCTION review_evidence_lock() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE data jsonb; cid text; ids text[] := '{}'; item text;
BEGIN
  data := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_TABLE_NAME='cards' THEN ids := ARRAY[data->>'id'];
  ELSIF TG_TABLE_NAME IN ('card_comments','card_runs','card_deps') THEN ids := ARRAY[data->>'card_id'];
  ELSIF TG_TABLE_NAME='org_messages' THEN
    ids := ARRAY[data->>'task_id'];
    SELECT array_cat(ids,array_agg(task_id)) INTO ids FROM org_messages
      WHERE id=(data->>'thread_id')::bigint OR thread_id=coalesce((data->>'thread_id')::bigint,(data->>'id')::bigint);
  ELSIF TG_TABLE_NAME='projects' THEN SELECT array_agg(id) INTO ids FROM cards WHERE project_slug=data->>'slug';
  ELSIF TG_TABLE_NAME='features' THEN SELECT array_agg(id) INTO ids FROM cards WHERE project_slug=data->>'project_slug' AND feature_slug=data->>'slug';
  END IF;
  FOR item IN SELECT DISTINCT j.card FROM review_jobs j WHERE
    (j.card=ANY(ids) OR j.card IN (SELECT card_id FROM card_deps WHERE depends_on=ANY(ids))) AND j.state NOT IN ('done','rejected') ORDER BY j.card
  LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended('review-content:' || item,0)) THEN
      RAISE EXCEPTION 'review: evidence is locked during review/shipping, retry after worker finishes';
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION review_evidence_lock() FROM PUBLIC;
CREATE TRIGGER review_lock_cards AFTER INSERT OR UPDATE OR DELETE ON cards FOR EACH ROW EXECUTE FUNCTION review_evidence_lock();
CREATE TRIGGER review_lock_comments AFTER INSERT OR UPDATE OR DELETE ON card_comments FOR EACH ROW EXECUTE FUNCTION review_evidence_lock();
CREATE TRIGGER review_lock_deps AFTER INSERT OR UPDATE OR DELETE ON card_deps FOR EACH ROW EXECUTE FUNCTION review_evidence_lock();
CREATE TRIGGER review_lock_runs AFTER INSERT OR UPDATE OR DELETE ON card_runs FOR EACH ROW EXECUTE FUNCTION review_evidence_lock();
CREATE TRIGGER review_lock_messages AFTER INSERT OR UPDATE OR DELETE ON org_messages FOR EACH ROW EXECUTE FUNCTION review_evidence_lock();
CREATE TRIGGER review_lock_projects AFTER UPDATE OR DELETE ON projects FOR EACH ROW EXECUTE FUNCTION review_evidence_lock();
CREATE TRIGGER review_lock_features AFTER UPDATE OR DELETE ON features FOR EACH ROW EXECUTE FUNCTION review_evidence_lock();

CREATE FUNCTION review_builder_retries() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 PERFORM review_authorize();
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('card',c.id,'assignee',c.assignee,'rounds',c.rounds,'review',j.id))
  FROM cards c JOIN review_jobs j ON j.card=c.id WHERE c.status='ready' AND j.state='rejected' AND EXISTS(SELECT 1 FROM review_policy WHERE enabled)
    AND j.id=(SELECT max(r.id) FROM review_jobs r WHERE r.card=c.id)), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION review_builder_retries() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION review_builder_retries() TO sb_review_worker;

-- Down Migration
-- Deliberately forward only: disabling policy does not discard active shipping receipts.

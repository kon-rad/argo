-- Up Migration
-- An owner can archive a cancelled review submission that never produced a PR.
-- A separate terminal state keeps this outcome distinct from accepted shipping and owner-merged code.
ALTER TABLE review_jobs DROP CONSTRAINT review_jobs_state_check;
ALTER TABLE review_jobs ADD CONSTRAINT review_jobs_state_check CHECK (state IN
  ('queued','reviewing','approved','merging','merged','deploying','deployed','blocked','rejected','done','superseded'));
DROP INDEX review_jobs_active;
CREATE UNIQUE INDEX review_jobs_active ON review_jobs(card) WHERE state NOT IN ('rejected','done','superseded');

CREATE TABLE review_owner_supersedes (
  id bigserial PRIMARY KEY,
  card text NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  job bigint NOT NULL REFERENCES review_jobs(id) ON DELETE CASCADE,
  successor text NOT NULL REFERENCES cards(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 8 AND 2000),
  superseded_by name NOT NULL,
  superseded_at timestamptz NOT NULL DEFAULT now(),
  xact bigint NOT NULL,
  UNIQUE (card, job),
  CHECK (card <> successor)
);
CREATE TRIGGER review_owner_supersedes_immutable BEFORE UPDATE OR DELETE ON review_owner_supersedes
  FOR EACH ROW EXECUTE FUNCTION review_immutable();

-- Prevent stale worker patches from reviving a superseded job, and prevent a worker from
-- asserting that state without the owner receipt in the same transaction.
CREATE FUNCTION review_superseded_state_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF OLD.state='superseded' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'review: superseded job is immutable';
  END IF;
  IF NEW.state='superseded' AND OLD.state IS DISTINCT FROM NEW.state AND NOT EXISTS
    (SELECT 1 FROM review_owner_supersedes r WHERE r.job=NEW.id AND r.xact=txid_current()) THEN
    RAISE EXCEPTION 'review: owner supersede receipt required';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION review_superseded_state_guard() FROM PUBLIC;
CREATE TRIGGER review_superseded_state_guard BEFORE UPDATE ON review_jobs FOR EACH ROW EXECUTE FUNCTION review_superseded_state_guard();

CREATE FUNCTION review_owner_supersede(p_card text,p_successor text,p_reason text)
RETURNS review_owner_supersedes LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c cards; j review_jobs; s cards; prior review_owner_supersedes; r review_owner_supersedes;
BEGIN
  PERFORM review_owner_authorize();
  IF length(btrim(coalesce(p_reason,''))) NOT BETWEEN 8 AND 2000 THEN
    RAISE EXCEPTION 'review: reason must be 8 to 2000 characters';
  END IF;
  IF p_card=p_successor THEN RAISE EXCEPTION 'review: successor must differ from card'; END IF;
  SELECT * INTO c FROM cards WHERE id=p_card FOR UPDATE;
  IF c.id IS NULL THEN RAISE EXCEPTION 'review: no card %',p_card; END IF;
  SELECT * INTO prior FROM review_owner_supersedes WHERE card=p_card;
  IF prior.id IS NOT NULL THEN
    IF c.status='archived' AND prior.successor=p_successor AND prior.reason=btrim(p_reason) THEN RETURN prior; END IF;
    RAISE EXCEPTION 'review: card % already has a supersede receipt',p_card;
  END IF;
  SELECT * INTO s FROM cards WHERE id=p_successor;
  IF s.id IS NULL THEN RAISE EXCEPTION 'review: no successor card %',p_successor; END IF;
  IF c.status<>'blocked' THEN RAISE EXCEPTION 'review: card % is %, not blocked',p_card,c.status; END IF;
  SELECT * INTO j FROM review_jobs WHERE card=p_card ORDER BY round DESC LIMIT 1 FOR UPDATE;
  IF j.id IS NULL OR j.state<>'blocked' OR j.snapshot IS NOT NULL OR j.verdict IS NOT NULL
     OR j.merged IS NOT NULL OR j.deployed IS NOT NULL OR j.health IS NOT NULL THEN
    RAISE EXCEPTION 'review: only a blocked submission without PR, verdict or shipping evidence can be superseded';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM card_comments cm JOIN org_agents a ON a.name=cm.author
                 WHERE cm.card_id=p_card AND a.runtime='human' AND cm.body ~* 'supersed|cancel') THEN
    RAISE EXCEPTION 'review: a human cancellation comment is required';
  END IF;
  IF EXISTS (SELECT 1 FROM card_comments WHERE card_id=p_card AND body ~* 'github[.]com/[^[:space:]]+/pull/[0-9]+') THEN
    RAISE EXCEPTION 'review: card references a PR; reconcile that PR instead';
  END IF;
  IF EXISTS (SELECT 1 FROM card_runs WHERE card_id=p_card)
     OR EXISTS (SELECT 1 FROM review_launches WHERE card=p_card)
     OR EXISTS (SELECT 1 FROM review_corrections WHERE card=p_card AND state IN ('claimed','starting','running')) THEN
    RAISE EXCEPTION 'review: a builder launch or active correction must be resolved first';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('review-job:'||j.id,0))
     OR NOT pg_try_advisory_xact_lock(hashtextextended('review-content:'||p_card,0)) THEN
    RAISE EXCEPTION 'review: review worker or evidence lock is active';
  END IF;
  INSERT INTO review_owner_supersedes(card,job,successor,reason,superseded_by,xact)
    VALUES(p_card,j.id,p_successor,btrim(p_reason),session_user,txid_current()) RETURNING * INTO r;
  UPDATE review_jobs SET state='superseded',error=NULL,updated_at=now() WHERE id=j.id;
  INSERT INTO review_attempts(job,patch) VALUES(j.id,jsonb_build_object('owner_superseded',r.id,'successor',p_successor,'by',session_user));
  UPDATE review_corrections SET state='cancelled',error='Owner superseded this card',lease_token=NULL,lease_until=NULL,updated_at=now()
    WHERE card=p_card AND state IN ('queued','retry');
  UPDATE cards SET status='archived',block_kind=NULL,block_reason=NULL WHERE id=p_card;
  PERFORM board_event(p_card,'owner-superseded',NULL,jsonb_build_object('receipt',r.id,'job',j.id,'successor',p_successor,
    'by',session_user,'reason',r.reason,'from',c.status,'reviewed',false,'merged',false,'deployed',false));
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION review_owner_supersede(text,text,text) FROM PUBLIC;

-- The archive receipt is transaction-scoped. Reopening is permitted, but a later completion
-- creates a fresh review round rather than inheriting the cancellation.
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
  IF NEW.status='archived' AND OLD.status NOT IN ('done','archived')
     AND EXISTS (SELECT 1 FROM review_owner_supersedes r WHERE r.card=NEW.id AND r.xact=txid_current()) THEN RETURN NEW; END IF;
  IF NEW.status = 'done' AND OLD.status NOT IN ('done','archived')
     AND EXISTS (SELECT 1 FROM review_owner_merges r WHERE r.card = NEW.id AND r.xact = txid_current()) THEN RETURN NEW; END IF;
  IF NEW.status IN ('done','archived') AND j.state = 'done' THEN
    IF p.worker_login <> session_user OR NOT pg_has_role(session_user, 'sb_review_worker', 'member') THEN
      IF OLD.status = 'done' AND NEW.status = 'done' THEN RETURN OLD; END IF;
      RAISE EXCEPTION 'review: only worker finalizes shipping';
    END IF;
    IF j.merged IS NULL OR j.deployed IS DISTINCT FROM j.merged OR j.health IS DISTINCT FROM j.merged OR j.verdict->>'decision' <> 'accept' THEN
      RAISE EXCEPTION 'review: missing shipping receipt';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IN ('done','review','archived') THEN
    IF j.id IS NULL OR (j.state IN ('rejected','superseded') AND OLD.status NOT IN ('review','done','archived')) THEN
      IF NEW.assignee IS NULL THEN RAISE EXCEPTION 'review: original builder required'; END IF;
      INSERT INTO review_jobs(card,builder,reviewer,repo,round)
      VALUES(NEW.id,NEW.assignee,coalesce(j.reviewer,p.reviewer),NEW.repo,coalesce(j.round+1,0))
      ON CONFLICT(card,round) DO NOTHING;
      PERFORM board_event(NEW.id,'review-submitted',NEW.assignee,jsonb_build_object('round',coalesce(j.round+1,0)));
    END IF;
    NEW.status := 'review'; NEW.completed_at := NULL;
  ELSIF j.id IS NOT NULL AND j.state NOT IN ('rejected','done','superseded') AND NEW.status IN ('ready','running','todo','scheduled') THEN
    IF p.worker_login IS DISTINCT FROM session_user THEN RAISE EXCEPTION 'review: submission is pending'; END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION review_submission_gate() FROM PUBLIC;

-- Down Migration
-- Forward only: historical cancellation receipts must not be discarded.

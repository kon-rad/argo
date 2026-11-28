-- Up Migration
ALTER TABLE review_jobs DROP CONSTRAINT review_jobs_state_check;
ALTER TABLE review_jobs ADD CONSTRAINT review_jobs_state_check CHECK (state IN
  ('queued','reviewing','approved','merging','merged','deploying','deployed','blocked','rejected','done','superseded','historical-archived'));
DROP INDEX review_jobs_active;
CREATE UNIQUE INDEX review_jobs_active ON review_jobs(card)
  WHERE state NOT IN ('rejected','done','superseded','historical-archived');

CREATE TABLE review_owner_history_archives (
  id bigserial PRIMARY KEY,
  card text NOT NULL UNIQUE REFERENCES cards(id),
  job bigint NOT NULL UNIQUE REFERENCES review_jobs(id),
  repo_key text NOT NULL,
  repo text NOT NULL,
  pr integer NOT NULL CHECK (pr > 0),
  outcome text NOT NULL CHECK (outcome IN ('merged','closed-unmerged')),
  merge_sha text CHECK (merge_sha ~ '^[a-f0-9]{40}$'),
  merged boolean GENERATED ALWAYS AS (outcome = 'merged') STORED,
  reviewed boolean NOT NULL DEFAULT false CHECK (NOT reviewed),
  deployed boolean NOT NULL DEFAULT false CHECK (NOT deployed),
  stale_before timestamptz NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 8 AND 2000),
  comment_id bigint NOT NULL REFERENCES card_comments(id),
  attestation jsonb NOT NULL CHECK (octet_length(attestation::text) <= 20000),
  archived_by name NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(),
  xact bigint NOT NULL,
  CHECK ((outcome='merged') = (merge_sha IS NOT NULL))
);
CREATE TRIGGER review_history_receipt_immutable BEFORE UPDATE OR DELETE ON review_owner_history_archives
  FOR EACH ROW EXECUTE FUNCTION review_immutable();

CREATE FUNCTION review_owner_history_authorize() RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF coalesce(current_setting('org.agent',true),'') <> '' THEN
    RAISE EXCEPTION 'review: historical archive refused for an org identity';
  END IF;
  IF session_user IN ('sb_org','sb_review_worker') OR session_user <> (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database())
     OR EXISTS (SELECT 1 FROM review_policy WHERE worker_login=session_user) THEN
    RAISE EXCEPTION 'review: historical archive requires the database owner login';
  END IF;
END $$;
REVOKE ALL ON FUNCTION review_owner_history_authorize() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION review_owner_history_authorize() TO pg_database_owner;
GRANT SELECT (card,job,attestation) ON review_owner_history_archives TO pg_database_owner;
GRANT SELECT (id,card,round) ON review_jobs TO pg_database_owner;

CREATE FUNCTION review_history_state_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.state='historical-archived' THEN
    IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'review: historical-archived job is immutable'; END IF;
  ELSIF NEW.state='historical-archived' AND NOT EXISTS (
    SELECT 1 FROM review_owner_history_archives r WHERE r.job=NEW.id AND r.card=NEW.card AND r.xact=txid_current()
  ) THEN RAISE EXCEPTION 'review: historical archive receipt required';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION review_history_state_guard() FROM PUBLIC;
CREATE TRIGGER review_history_state_guard BEFORE INSERT OR UPDATE ON review_jobs
  FOR EACH ROW EXECUTE FUNCTION review_history_state_guard();

-- cards_touch timestamps even repeated review_save blocks. Keep a separate clock
-- so a later worker retry cannot hide a human edit. Legacy rows conservatively
-- start from their stored updated_at. No guessing or backdating at migration time.
CREATE INDEX review_attempts_job_at ON review_attempts(job,at);
CREATE TABLE review_history_retry_clock (
  card text PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
  meaningful_at timestamptz NOT NULL
);
CREATE FUNCTION review_touch_meaningful() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE ignored text[] := ARRAY['updated_at','block_kind','block_reason','tsv'];
BEGIN
  IF OLD.status='blocked' AND NEW.status='blocked' AND NEW.block_kind='tool-error'
     AND EXISTS (SELECT 1 FROM review_policy WHERE worker_login=session_user)
     AND (to_jsonb(OLD)-ignored) = (to_jsonb(NEW)-ignored)
     AND EXISTS (SELECT 1 FROM review_jobs j JOIN review_attempts a ON a.job=j.id
       WHERE j.card=OLD.id AND j.state='blocked' AND j.error IS NOT DISTINCT FROM NEW.block_reason
         AND a.at=now() AND j.updated_at=now()) THEN
    INSERT INTO review_history_retry_clock(card,meaningful_at) VALUES(OLD.id,OLD.updated_at)
      ON CONFLICT(card) DO NOTHING;
  ELSE
    DELETE FROM review_history_retry_clock WHERE card=OLD.id;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION review_touch_meaningful() FROM PUBLIC;
CREATE TRIGGER review_touch_meaningful AFTER UPDATE ON cards
  FOR EACH ROW EXECUTE FUNCTION review_touch_meaningful();

CREATE FUNCTION review_owner_history_archive(p_card text,p_job bigint,p_repo_key text,p_pr integer,p_outcome text,
  p_merge_sha text,p_stale_before timestamptz,p_reason text,p_attestation jsonb)
RETURNS review_owner_history_archives LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  c cards; j review_jobs; r review_owner_history_archives; evidence_id bigint;
  repo_name text := p_attestation->>'repo';
  pr_url text := format('https://github.com/%s/pull/%s',repo_name,p_pr);
  link_pattern text;
BEGIN
  PERFORM review_owner_history_authorize();
  IF p_pr IS NULL OR p_pr<=0 OR p_outcome IS NULL OR p_outcome NOT IN ('merged','closed-unmerged')
     OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 8 AND 2000
     OR length(btrim(coalesce(p_repo_key,'')))=0
     OR p_stale_before IS NULL OR NOT isfinite(p_stale_before) OR p_stale_before>clock_timestamp() THEN
    RAISE EXCEPTION 'review: invalid historical archive request or cutoff';
  END IF;
  IF coalesce(repo_name,'') !~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
     OR p_attestation->>'url' IS DISTINCT FROM pr_url OR p_attestation->>'repoKey' IS DISTINCT FROM p_repo_key
     OR p_attestation->'pr' IS DISTINCT FROM to_jsonb(p_pr) OR coalesce(p_attestation->>'base','')=''
     OR coalesce(p_attestation->>'head','') !~ '^[a-f0-9]{40}$'
     OR (p_outcome='merged' AND (p_attestation->>'state' IS DISTINCT FROM 'MERGED'
       OR coalesce(p_merge_sha,'') !~ '^[a-f0-9]{40}$' OR p_attestation->>'merged' IS DISTINCT FROM p_merge_sha
       OR coalesce(p_attestation->>'baseTip','') !~ '^[a-f0-9]{40}$'))
     OR (p_outcome='closed-unmerged' AND (p_attestation->>'state' IS DISTINCT FROM 'CLOSED'
       OR p_merge_sha IS NOT NULL OR p_attestation->'merged' IS DISTINCT FROM 'null'::jsonb)) THEN
    RAISE EXCEPTION 'review: GitHub attestation conflicts with historical archive request';
  END IF;

  -- Claim the worker's locks first, in its order. The card row also serializes
  -- new jobs and FK-backed evidence inserts. Re-read the latest round under lock.
  IF p_job IS NULL OR NOT pg_try_advisory_xact_lock(hashtextextended('review-job:'||p_job,0))
     OR NOT pg_try_advisory_xact_lock(hashtextextended('review-content:'||p_card,0)) THEN
    RAISE EXCEPTION 'review: missing job or active review worker lock';
  END IF;
  SELECT * INTO STRICT c FROM cards WHERE id=p_card FOR UPDATE;
  SELECT * INTO j FROM review_jobs WHERE card=p_card ORDER BY round DESC LIMIT 1 FOR UPDATE;
  IF j.id IS DISTINCT FROM p_job THEN RAISE EXCEPTION 'review: latest review job changed'; END IF;
  SELECT * INTO r FROM review_owner_history_archives WHERE card=p_card;
  IF FOUND THEN
    IF c.status='archived' AND j.state='historical-archived' AND r.job=p_job AND r.repo_key=p_repo_key
       AND r.repo=repo_name AND r.pr=p_pr AND r.outcome=p_outcome AND r.merge_sha IS NOT DISTINCT FROM p_merge_sha
       AND r.stale_before=p_stale_before AND r.reason=btrim(p_reason) THEN RETURN r; END IF;
    RAISE EXCEPTION 'review: conflicting historical archive receipt for %',p_card;
  END IF;
  IF c.status<>'blocked' OR j.state<>'blocked' OR j.verdict IS NOT NULL OR j.deployed IS NOT NULL OR j.health IS NOT NULL THEN
    RAISE EXCEPTION 'review: historical archive requires a blocked card and job without a verdict, deployment or health';
  END IF;
  IF (j.snapshot IS NOT NULL AND (j.snapshot->>'repo' IS DISTINCT FROM repo_name OR j.snapshot->'pr' IS DISTINCT FROM to_jsonb(p_pr)))
     OR (j.snapshot->>'merged' IS NOT NULL AND j.snapshot->>'merged' IS DISTINCT FROM p_merge_sha)
     OR (j.merged IS NOT NULL AND j.merged IS DISTINCT FROM p_merge_sha) THEN
    RAISE EXCEPTION 'review: review evidence conflicts with the attested PR';
  END IF;

  link_pattern := $re$(^|[[:space:]]|[<("']|\[)$re$ || replace(pr_url,'.','[.]')
    || $re$($|[[:space:]]|[>)"']|\]|[.,;:!?]([[:space:]]|$))$re$;
  SELECT cm.id INTO evidence_id FROM card_comments cm JOIN org_agents a ON a.name=cm.author
    WHERE cm.card_id=p_card AND a.runtime='human' AND cm.body ~ link_pattern ORDER BY cm.id LIMIT 1;
  IF evidence_id IS NULL THEN RAISE EXCEPTION 'review: an exact human comment link to % is required',pr_url; END IF;

  -- Wakeups have no FK to cards. Freeze the task queue briefly for this rare owner operation.
  LOCK TABLE org_wakeups IN SHARE MODE NOWAIT;
  PERFORM 1 FROM review_corrections WHERE card=p_card FOR UPDATE;
  IF EXISTS (SELECT 1 FROM card_runs WHERE card_id=p_card AND finished_at IS NULL)
     OR EXISTS (SELECT 1 FROM org_wakeups WHERE reason='task' AND ref=p_card AND done_at IS NULL)
     OR EXISTS (SELECT 1 FROM review_corrections WHERE card=p_card AND (
       state IN ('queued','claimed','starting','running','retry') OR
       (state='blocked' AND (lease_token IS NOT NULL OR lease_until IS NOT NULL OR run_id IS NOT NULL OR process_id IS NOT NULL))
     )) THEN
    RAISE EXCEPTION 'review: resolve queued or active builder work and corrections first';
  END IF;
  IF greatest(c.created_at,c.started_at,c.completed_at,coalesce((SELECT meaningful_at FROM review_history_retry_clock WHERE card=p_card),c.updated_at),j.created_at)>=p_stale_before
     OR EXISTS (SELECT 1 FROM card_comments WHERE card_id=p_card AND created_at>=p_stale_before)
     OR EXISTS (SELECT 1 FROM card_runs WHERE card_id=p_card AND greatest(claimed_at,heartbeat_at,finished_at)>=p_stale_before)
     OR EXISTS (SELECT 1 FROM org_wakeups WHERE reason='task' AND ref=p_card AND greatest(created_at,claimed_at,done_at)>=p_stale_before)
     OR EXISTS (SELECT 1 FROM review_launches WHERE card=p_card AND created_at>=p_stale_before)
     OR EXISTS (SELECT 1 FROM review_corrections WHERE card=p_card AND greatest(created_at,updated_at)>=p_stale_before)
     OR EXISTS (SELECT 1 FROM card_events e WHERE e.card_id=p_card AND e.at>=p_stale_before AND NOT (
       e.kind='review-blocked' AND e.actor IS NOT DISTINCT FROM j.reviewer AND e.payload->'job' IS NOT DISTINCT FROM to_jsonb(j.id)
       AND EXISTS (SELECT 1 FROM review_attempts a WHERE a.job=j.id AND a.at=e.at)
     )) THEN
    RAISE EXCEPTION 'review: meaningful activity at or after stale cutoff';
  END IF;

  INSERT INTO review_owner_history_archives(card,job,repo_key,repo,pr,outcome,merge_sha,stale_before,reason,
    comment_id,attestation,archived_by,xact)
    VALUES(p_card,j.id,p_repo_key,repo_name,p_pr,p_outcome,p_merge_sha,p_stale_before,btrim(p_reason),
      evidence_id,p_attestation,session_user,txid_current()) RETURNING * INTO r;
  UPDATE review_jobs SET state='historical-archived',error=NULL,updated_at=now() WHERE id=j.id;
  INSERT INTO review_attempts(job,patch) VALUES(j.id,jsonb_build_object('owner_history_archived',r.id,'by',session_user));
  UPDATE review_corrections SET state='cancelled',error='Owner archived historical work',lease_token=NULL,lease_until=NULL,
    updated_at=now() WHERE card=p_card AND state IN ('blocked','review');
  UPDATE cards SET status='archived',completed_at=NULL,block_reason=NULL,block_kind=NULL WHERE id=p_card RETURNING * INTO c;
  IF c.status IS DISTINCT FROM 'archived' THEN RAISE EXCEPTION 'review: historical card archive was intercepted'; END IF;
  PERFORM board_event(p_card,'owner-history-archived',NULL,jsonb_build_object('receipt',r.id,'job',j.id,'repo_key',p_repo_key,
    'repo',repo_name,'pr',p_pr,'outcome',p_outcome,'merge_sha',p_merge_sha,'stale_before',p_stale_before,
    'reason',r.reason,'by',session_user,'reviewed',false,'merged',r.merged,'deployed',false));
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION review_owner_history_archive(text,bigint,text,integer,text,text,timestamptz,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION review_owner_history_archive(text,bigint,text,integer,text,text,timestamptz,text,jsonb) TO pg_database_owner;

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
  IF j.state='historical-archived' AND OLD.status='archived' THEN
    IF NEW.status='archived' THEN RETURN NEW; END IF;
    IF NEW.status IN ('done','review') THEN RAISE EXCEPTION 'review: reopen the archived card before resubmitting'; END IF;
  END IF;
  IF NEW.status='archived' AND OLD.status='blocked' AND j.state='historical-archived'
     AND EXISTS (SELECT 1 FROM review_owner_history_archives r WHERE r.card=NEW.id AND r.job=j.id AND r.xact=txid_current()) THEN RETURN NEW; END IF;
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
    IF j.id IS NULL OR (j.state IN ('rejected','superseded','historical-archived') AND OLD.status NOT IN ('review','done','archived')) THEN
      IF NEW.assignee IS NULL THEN RAISE EXCEPTION 'review: original builder required'; END IF;
      INSERT INTO review_jobs(card,builder,reviewer,repo,round)
      VALUES(NEW.id,NEW.assignee,coalesce(j.reviewer,p.reviewer),NEW.repo,coalesce(j.round+1,0))
      ON CONFLICT(card,round) DO NOTHING;
      PERFORM board_event(NEW.id,'review-submitted',NEW.assignee,jsonb_build_object('round',coalesce(j.round+1,0)));
    END IF;
    NEW.status := 'review'; NEW.completed_at := NULL;
  ELSIF j.id IS NOT NULL AND j.state NOT IN ('rejected','done','superseded','historical-archived') AND NEW.status IN ('ready','running','todo','scheduled') THEN
    IF p.worker_login IS DISTINCT FROM session_user THEN RAISE EXCEPTION 'review: submission is pending'; END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION review_submission_gate() FROM PUBLIC;

-- A historical archive has no completion semantics. Use the latest job so a
-- later reopen and independently completed round can satisfy dependencies.
CREATE FUNCTION board_dependency_satisfied(p_id text,p_status text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT p_status='done' OR (p_status='archived' AND NOT EXISTS (
    SELECT 1
    FROM review_owner_history_archives r
    JOIN review_jobs archived ON archived.id=r.job
    WHERE r.card=p_id AND NOT EXISTS (
      SELECT 1 FROM review_jobs later
      WHERE later.card=r.card AND later.round>archived.round AND later.state='done')
  ))
$$;
REVOKE ALL ON FUNCTION board_dependency_satisfied(text,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION board_promote(p_card text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE c cards;
BEGIN
  SELECT * INTO c FROM cards WHERE id = p_card FOR UPDATE;
  IF c.id IS NULL THEN RETURN false; END IF;
  IF NOT (c.status IN ('todo', 'scheduled') OR (c.status = 'blocked' AND c.block_kind = 'dependency')) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM card_deps d JOIN cards p ON p.id = d.depends_on WHERE d.card_id = p_card AND NOT board_dependency_satisfied(p.id,p.status)) THEN RETURN false; END IF;
  IF c.scheduled_for IS NOT NULL AND c.scheduled_for > now() THEN RETURN false; END IF;
  UPDATE cards SET status = 'ready', block_kind = NULL, block_reason = NULL WHERE id = p_card;
  PERFORM board_event(p_card, 'moved', NULL, json_build_object('from', c.status, 'to', 'ready', 'why', 'promoted')::jsonb);
  PERFORM board_wake(p_card);
  RETURN true;
END
$$;

-- Down Migration
-- Forward only. Immutable historical receipts are retained.

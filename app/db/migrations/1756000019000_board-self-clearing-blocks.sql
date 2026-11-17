-- Up Migration

-- Blocks that clear themselves (board module).
--
-- 1. A dependency block is a link: board_card_block records the card_deps rows, and the card goes back to ready in the
--    same transaction as the last dependency's finish, with a `released` event naming the card that released it.
--    board_reclaim also re-tests every dependency block, including older blocks that named their cards only in the
--    reason text, so cards left blocked on finished work clear on the first sweep.
-- 2. A host-down block names its host. board_reclaim(hosts_up) re-queues those cards when a caller reports the host
--    up (`cli-board host-up <host>`); at most 3 automatic retries per card, then it stays blocked with the count shown.
-- 3. A running card whose latest run has finished and has no live lease is reconciled by board_reclaim: to review when
--    the run left a branch or a PR, else to ready, with a `reconciled` event naming the run.
-- 4. None of these paths touches a done or archived card.

ALTER TABLE cards DROP CONSTRAINT cards_block_kind_check;
ALTER TABLE cards ADD CONSTRAINT cards_block_kind_check
  CHECK (block_kind IN ('dependency','needs-owner','missing-input','tool-error','budget','review-changes','host-down','other'));
ALTER TABLE cards ADD COLUMN block_host text CHECK (block_host ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$');
ALTER TABLE cards ADD COLUMN host_retries integer NOT NULL DEFAULT 0 CHECK (host_retries >= 0);

-- What a run left behind, so a run that ended without a finish can still be routed to review.
ALTER TABLE card_runs ADD COLUMN branch text CHECK (length(branch) BETWEEN 1 AND 200);
ALTER TABLE card_runs ADD COLUMN pr text CHECK (length(pr) BETWEEN 1 AND 500);

-- The host belongs to a host-down block only: any write that changes the block kind drops it.
CREATE FUNCTION cards_block_host_clear() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.block_kind IS DISTINCT FROM 'host-down' THEN NEW.block_host := NULL; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER cards_block_host_clear BEFORE INSERT OR UPDATE ON cards FOR EACH ROW EXECUTE FUNCTION cards_block_host_clear();

-- A finished card lets its dependants through, and each released card says which card released it.
CREATE OR REPLACE FUNCTION cards_promote_dependants() RETURNS trigger AS $$
DECLARE d record;
BEGIN
  IF NEW.status IN ('done', 'archived') AND OLD.status NOT IN ('done', 'archived') THEN
    FOR d IN SELECT dd.card_id, c.status FROM card_deps dd JOIN cards c ON c.id = dd.card_id WHERE dd.depends_on = NEW.id ORDER BY dd.card_id LOOP
      IF board_promote(d.card_id) THEN
        PERFORM board_event(d.card_id, 'released', NULL, jsonb_build_object('by', NEW.id, 'by_status', NEW.status, 'from', d.status));
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- True when linking p_card after p_dep would close a cycle.
CREATE FUNCTION board_dep_cycle(p_card text, p_dep text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT p_card = p_dep OR EXISTS (
    WITH RECURSIVE up AS (SELECT depends_on FROM card_deps WHERE card_id = p_dep
                          UNION SELECT d.depends_on FROM card_deps d JOIN up ON d.card_id = up.depends_on)
    SELECT 1 FROM up WHERE depends_on = p_card)
$$;

-- Block a card with its cause as data: --after <cards> (kind dependency, recorded as links) or --host <name>
-- (kind host-down). Same permission as a move to blocked. A dependency block whose cards are all finished already
-- releases at once, so a block never outlives its reason.
CREATE FUNCTION board_card_block(p_by text, p_card text, p_kind text, p_reason text, p_host text, p_after text[])
RETURNS cards LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c org_agents; card cards; k text; d text;
BEGIN
  c := board_caller(p_by);
  SELECT * INTO card FROM cards WHERE id = p_card FOR UPDATE;
  IF card.id IS NULL THEN RAISE EXCEPTION 'no card %', p_card; END IF;
  IF card.status IN ('done', 'archived') THEN RAISE EXCEPTION 'card % is already %', p_card, card.status; END IF;
  k := coalesce(p_kind, CASE WHEN p_host IS NOT NULL THEN 'host-down' WHEN cardinality(p_after) > 0 THEN 'dependency' END, 'other');
  IF k = 'host-down' AND p_host IS NULL THEN RAISE EXCEPTION 'a host-down block names its host: --host <name>'; END IF;
  IF p_host IS NOT NULL AND k <> 'host-down' THEN RAISE EXCEPTION '--host goes with block kind host-down, not %', k; END IF;
  IF cardinality(p_after) > 0 AND k <> 'dependency' THEN RAISE EXCEPTION '--after goes with block kind dependency, not %', k; END IF;
  IF k = 'dependency' AND coalesce(cardinality(p_after), 0) = 0 AND NOT EXISTS (SELECT 1 FROM card_deps WHERE card_id = p_card) THEN
    RAISE EXCEPTION 'a dependency block names the card it waits for: --after <card>';
  END IF;
  card := board_card_move(p_by, p_card, 'blocked', p_reason, k, NULL);
  FOREACH d IN ARRAY coalesce(p_after, '{}') LOOP PERFORM board_card_link(p_by, p_card, d); END LOOP;
  IF k = 'host-down' THEN
    UPDATE cards SET block_host = p_host WHERE id = p_card RETURNING * INTO card;
  END IF;
  IF k = 'dependency' AND board_promote(p_card) THEN
    PERFORM board_event(p_card, 'released', NULL, jsonb_build_object('by', NULL, 'why', 'every dependency had already finished'));
    SELECT * INTO card FROM cards WHERE id = p_card;
  END IF;
  RETURN card;
END
$$;
GRANT EXECUTE ON FUNCTION board_card_block(text, text, text, text, text, text[]) TO sb_org;

-- The run's agent (or a human, or dispatch) records what the run left: a branch, a PR. On the open run, else the latest.
CREATE FUNCTION board_run_output(p_by text, p_card text, p_branch text, p_pr text)
RETURNS card_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c org_agents; r card_runs;
BEGIN
  c := board_caller(p_by);
  IF p_branch IS NULL AND p_pr IS NULL THEN RAISE EXCEPTION 'say what the run left: a branch, a PR or both'; END IF;
  SELECT * INTO r FROM card_runs WHERE card_id = p_card ORDER BY (finished_at IS NULL) DESC, id DESC LIMIT 1 FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'card % has no live run', p_card; END IF;
  IF c.runtime <> 'human' AND NOT ('dispatch' = ANY (c.capabilities)) AND r.agent_name <> c.name THEN RAISE EXCEPTION 'run % is %''s', r.id, r.agent_name; END IF;
  UPDATE card_runs SET branch = coalesce(p_branch, branch), pr = coalesce(p_pr, pr) WHERE id = r.id RETURNING * INTO r;
  PERFORM board_event(p_card, 'run-output', c.name, jsonb_build_object('run', r.id, 'branch', p_branch, 'pr', p_pr));
  RETURN r;
END
$$;
GRANT EXECUTE ON FUNCTION board_run_output(text, text, text, text) TO sb_org;

-- The sweep. p_hosts_up: hosts a caller has just reported up (the engine never probes a host itself).
DROP FUNCTION board_reclaim();
CREATE FUNCTION board_reclaim(p_hosts_up text[] DEFAULT NULL) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; n integer := 0; m text; last text; run card_runs; found_pr text; dest text; max_retries constant integer := 3;
BEGIN
  -- Lost leases back to ready.
  FOR r IN SELECT id, card_id FROM card_runs WHERE finished_at IS NULL AND lease_until < now() FOR UPDATE SKIP LOCKED LOOP
    UPDATE card_runs SET finished_at = now(), outcome = 'lost' WHERE id = r.id;
    UPDATE cards SET status = 'ready' WHERE id = r.card_id AND status = 'running';
    PERFORM board_event(r.card_id, 'reclaimed', NULL, json_build_object('run', r.id)::jsonb);
    PERFORM board_wake(r.card_id);
    n := n + 1;
  END LOOP;

  -- Due schedules to ready.
  FOR r IN SELECT id FROM cards WHERE status = 'scheduled' AND scheduled_for <= now() LOOP
    IF board_promote(r.id) THEN n := n + 1; END IF;
  END LOOP;

  -- Dependency blocks re-tested. A block with no link rows that names cards in its reason gets those links first.
  FOR r IN SELECT id, block_reason FROM cards WHERE status = 'blocked' AND block_kind = 'dependency' ORDER BY id FOR UPDATE SKIP LOCKED LOOP
    IF NOT EXISTS (SELECT 1 FROM card_deps WHERE card_id = r.id) THEN
      FOR m IN SELECT DISTINCT x[1] FROM regexp_matches(coalesce(r.block_reason, ''), '(t_[0-9a-f]{6,32})', 'g') AS x LOOP
        IF EXISTS (SELECT 1 FROM cards WHERE id = m) AND NOT board_dep_cycle(r.id, m) THEN
          INSERT INTO card_deps (card_id, depends_on) VALUES (r.id, m) ON CONFLICT DO NOTHING;
          PERFORM board_event(r.id, 'linked', NULL, jsonb_build_object('depends_on', m, 'why', 'named in the block reason'));
        END IF;
      END LOOP;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM card_deps WHERE card_id = r.id) THEN CONTINUE; END IF;
    SELECT d.depends_on INTO last FROM card_deps d JOIN cards p ON p.id = d.depends_on
     WHERE d.card_id = r.id ORDER BY coalesce(p.completed_at, p.updated_at) DESC, d.depends_on LIMIT 1;
    BEGIN
      IF board_promote(r.id) THEN
        PERFORM board_event(r.id, 'released', NULL, jsonb_build_object('by', last, 'from', 'blocked', 'via', 'reclaim'));
        n := n + 1;
      END IF;
    EXCEPTION WHEN raise_exception THEN
      PERFORM board_event(r.id, 'reclaim-skipped', NULL, jsonb_build_object('why', SQLERRM));
    END;
  END LOOP;

  -- Host-down blocks on a host reported up: back to ready, at most max_retries times per card.
  IF p_hosts_up IS NOT NULL THEN
    FOR r IN SELECT id, block_host, host_retries FROM cards
              WHERE status = 'blocked' AND block_kind = 'host-down' AND lower(block_host) IN (SELECT lower(h) FROM unnest(p_hosts_up) h)
              ORDER BY id FOR UPDATE SKIP LOCKED LOOP
      IF r.host_retries >= max_retries THEN CONTINUE; END IF;
      BEGIN
        UPDATE cards SET status = 'ready', block_kind = NULL, block_reason = NULL, host_retries = host_retries + 1 WHERE id = r.id;
        PERFORM board_event(r.id, 'host-retry', NULL, jsonb_build_object('host', r.block_host, 'retry', r.host_retries + 1, 'max', max_retries));
        PERFORM board_wake(r.id);
        n := n + 1;
      EXCEPTION WHEN raise_exception THEN
        PERFORM board_event(r.id, 'reclaim-skipped', NULL, jsonb_build_object('why', SQLERRM));
      END;
    END LOOP;
  END IF;

  -- Running cards whose latest run has finished and that hold no live lease: review if the run left a branch or a PR, else ready.
  FOR r IN SELECT c.id FROM cards c
            WHERE c.status = 'running'
              AND EXISTS (SELECT 1 FROM card_runs x WHERE x.card_id = c.id)
              AND NOT EXISTS (SELECT 1 FROM card_runs x WHERE x.card_id = c.id AND x.finished_at IS NULL)
            ORDER BY c.id FOR UPDATE SKIP LOCKED LOOP
    SELECT * INTO run FROM card_runs WHERE card_id = r.id ORDER BY id DESC LIMIT 1;
    found_pr := coalesce(run.pr,
      (SELECT a.pr_url FROM org_approvals a WHERE a.task_id = r.id AND a.pr_url IS NOT NULL AND a.created_at >= run.claimed_at ORDER BY a.id DESC LIMIT 1),
      (SELECT (regexp_match(cc.body, '(https?://[^[:space:]]+/pull/[0-9]+)'))[1] FROM card_comments cc
        WHERE cc.card_id = r.id AND cc.created_at >= run.claimed_at AND cc.body ~ 'https?://[^[:space:]]+/pull/[0-9]+' ORDER BY cc.id DESC LIMIT 1));
    dest := CASE WHEN run.branch IS NOT NULL OR found_pr IS NOT NULL THEN 'review' ELSE 'ready' END;
    BEGIN
      UPDATE cards SET status = dest WHERE id = r.id AND status = 'running';
      PERFORM board_event(r.id, 'reconciled', NULL, jsonb_build_object('run', run.id, 'run_id', run.run_id, 'outcome', run.outcome, 'to', dest, 'branch', run.branch, 'pr', found_pr));
      IF dest = 'ready' THEN PERFORM board_wake(r.id); END IF;
      n := n + 1;
    EXCEPTION WHEN raise_exception THEN
      IF NOT EXISTS (SELECT 1 FROM card_events WHERE card_id = r.id AND kind = 'reclaim-skipped' AND at > now() - interval '24 hours') THEN
        PERFORM board_event(r.id, 'reclaim-skipped', NULL, jsonb_build_object('run', run.id, 'why', SQLERRM));
      END IF;
    END;
  END LOOP;

  RETURN n;
END
$$;

-- Down Migration

DROP FUNCTION board_reclaim(text[]);
CREATE FUNCTION board_reclaim() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; n integer := 0;
BEGIN
  FOR r IN SELECT id, card_id FROM card_runs WHERE finished_at IS NULL AND lease_until < now() FOR UPDATE SKIP LOCKED LOOP
    UPDATE card_runs SET finished_at = now(), outcome = 'lost' WHERE id = r.id;
    UPDATE cards SET status = 'ready' WHERE id = r.card_id AND status = 'running';
    PERFORM board_event(r.card_id, 'reclaimed', NULL, json_build_object('run', r.id)::jsonb);
    PERFORM board_wake(r.card_id);
    n := n + 1;
  END LOOP;
  FOR r IN SELECT id FROM cards WHERE status = 'scheduled' AND scheduled_for <= now() LOOP
    IF board_promote(r.id) THEN n := n + 1; END IF;
  END LOOP;
  RETURN n;
END
$$;
DROP FUNCTION board_run_output(text, text, text, text);
DROP FUNCTION board_card_block(text, text, text, text, text, text[]);
DROP FUNCTION board_dep_cycle(text, text);
CREATE OR REPLACE FUNCTION cards_promote_dependants() RETURNS trigger AS $$
DECLARE d record;
BEGIN
  IF NEW.status IN ('done', 'archived') AND OLD.status NOT IN ('done', 'archived') THEN
    FOR d IN SELECT card_id FROM card_deps WHERE depends_on = NEW.id LOOP PERFORM board_promote(d.card_id); END LOOP;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER cards_block_host_clear ON cards;
DROP FUNCTION cards_block_host_clear();
ALTER TABLE card_runs DROP COLUMN pr, DROP COLUMN branch;
ALTER TABLE cards DROP COLUMN host_retries, DROP COLUMN block_host;
UPDATE cards SET block_kind = 'other' WHERE block_kind = 'host-down';
ALTER TABLE cards DROP CONSTRAINT cards_block_kind_check;
ALTER TABLE cards ADD CONSTRAINT cards_block_kind_check
  CHECK (block_kind IN ('dependency','needs-owner','missing-input','tool-error','budget','review-changes','other'));

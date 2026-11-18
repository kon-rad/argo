-- Up Migration

-- Bug (t_f25205f5, sol's sweep 2026-10-25, #leads 358): a lead could not assign an existing vault card to m4
-- with `--repo vault`; `cli-org task assign <card> m4 --repo vault` failed with "permission denied for table
-- cards". Every other card write goes through a SECURITY DEFINER function, but two lines in org.ts wrote the
-- `cards` table directly over the caller's connection:
--   * assignTask(): `UPDATE cards SET repo = $2 WHERE id = $1`
--   * redoTask():   `UPDATE cards SET block_kind = 'dependency', rounds = $2 WHERE id = $1`
-- The caller is the sb_org row-level-security role (SELECT-only on cards; its policies only grant reads), so a
-- direct write is denied. It surfaced on assign only when the repo actually changed (a vault card starts with
-- repo NULL) and on every review redo.
--
-- Fix, following the pattern this module already uses: move both writes into the SECURITY DEFINER functions
-- that own those card transitions -- `board_card_assign` gains p_repo, `board_card_move` gains p_block_kind
-- and p_rounds -- and grant sb_org EXECUTE on the new signatures, never table access. Adding arguments changes
-- the signature, so the old ones are dropped first; the Down migration restores them.

DROP FUNCTION IF EXISTS board_card_assign(text, text, text, text, text, text, text);
DROP FUNCTION IF EXISTS board_card_move(text, text, text, text);

-- board_card_assign now also sets the repo (a card's code location, decided when it is given). A repo the bots
-- cannot reach is rejected upstream (checkRepo in org.ts); here it is a plain text column that coalesces, so an
-- assign without a repo leaves the existing one untouched.
CREATE OR REPLACE FUNCTION board_card_assign(p_by text, p_card text, p_assignee text, p_project text, p_feature text,
                                             p_work text, p_needs text, p_repo text)
RETURNS cards LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c org_agents; t org_agents; card cards;
BEGIN
  c := board_caller(p_by);
  SELECT * INTO card FROM cards WHERE id = p_card FOR UPDATE;
  IF card.id IS NULL THEN RAISE EXCEPTION 'no card %', p_card; END IF;
  IF card.status IN ('done', 'archived') THEN RAISE EXCEPTION 'card % is %; give a new card instead', p_card, card.status; END IF;
  IF card.status = 'running' THEN RAISE EXCEPTION 'card % is running; wait for the worker or reclaim it first', p_card; END IF;
  IF p_assignee IS NOT NULL THEN
    SELECT * INTO t FROM org_agents WHERE name = p_assignee AND retired_at IS NULL;
    IF t.name IS NULL THEN RAISE EXCEPTION 'unknown agent "%"; run cli-org agents for the roster', p_assignee; END IF;
    PERFORM board_may_assign(c, t);
    PERFORM board_assert_capable(t, coalesce(p_needs, card.needs));
  ELSIF c.runtime <> 'human' AND NOT ('dispatch' = ANY (c.capabilities)) AND card.assignee IS DISTINCT FROM c.name THEN
    RAISE EXCEPTION '% can''t unassign %''s card', c.name, card.assignee;
  END IF;
  IF p_project IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE slug = p_project) THEN RAISE EXCEPTION 'no project "%" in the tracker (cli-projects list)', p_project; END IF;
  IF p_feature IS NOT NULL AND NOT EXISTS (SELECT 1 FROM features WHERE project_slug = coalesce(p_project, card.project_slug) AND slug = p_feature) THEN RAISE EXCEPTION 'no feature "%/%" in the tracker', coalesce(p_project, card.project_slug), p_feature; END IF;
  UPDATE cards SET assignee = p_assignee, project_slug = coalesce(p_project, project_slug),
         feature_slug = CASE WHEN p_project IS NOT NULL THEN p_feature ELSE coalesce(p_feature, feature_slug) END,
         work_type = coalesce(p_work, work_type), needs = coalesce(p_needs, needs), repo = coalesce(p_repo, repo)
   WHERE id = p_card RETURNING * INTO card;
  IF card.project_slug IS NOT NULL AND card.feature_slug IS NOT NULL AND p_assignee IS NOT NULL AND card.kind IN ('work', 'build') THEN
    UPDATE features SET owner = p_assignee WHERE project_slug = card.project_slug AND slug = card.feature_slug;
  END IF;
  PERFORM board_event(p_card, 'assigned', c.name, json_build_object('assignee', p_assignee, 'repo', p_repo)::jsonb);
  IF card.status = 'ready' THEN PERFORM board_wake(p_card); END IF;
  RETURN card;
END
$$;
GRANT EXECUTE ON FUNCTION board_card_assign(text, text, text, text, text, text, text, text) TO sb_org;

-- board_card_move now also carries a block_kind and a round count, so the review redo (which blocks the review
-- card on the next round) needs no second, direct write. Both are optional and coalesce: a plain move leaves
-- them as they were. block_kind falls back to 'other' exactly as before when a card is blocked without a kind.
CREATE OR REPLACE FUNCTION board_card_move(p_by text, p_card text, p_status text, p_note text, p_block_kind text, p_rounds integer)
RETURNS cards LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c org_agents; card cards; was text;
BEGIN
  c := board_caller(p_by);
  SELECT * INTO card FROM cards WHERE id = p_card FOR UPDATE;
  IF card.id IS NULL THEN RAISE EXCEPTION 'no card %', p_card; END IF;
  IF c.runtime <> 'human' AND NOT ('dispatch' = ANY (c.capabilities)) THEN
    IF card.assignee IS DISTINCT FROM c.name THEN RAISE EXCEPTION '% can''t move %''s card', c.name, card.assignee; END IF;
    IF p_status IN ('done', 'archived') THEN RAISE EXCEPTION 'finish the card (cli-board finish) instead of moving it to %', p_status; END IF;
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
GRANT EXECUTE ON FUNCTION board_card_move(text, text, text, text, text, integer) TO sb_org;

-- Down Migration

DROP FUNCTION IF EXISTS board_card_move(text, text, text, text, text, integer);
DROP FUNCTION IF EXISTS board_card_assign(text, text, text, text, text, text, text, text);

CREATE OR REPLACE FUNCTION board_card_assign(p_by text, p_card text, p_assignee text, p_project text, p_feature text, p_work text, p_needs text)
RETURNS cards LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c org_agents; t org_agents; card cards;
BEGIN
  c := board_caller(p_by);
  SELECT * INTO card FROM cards WHERE id = p_card FOR UPDATE;
  IF card.id IS NULL THEN RAISE EXCEPTION 'no card %', p_card; END IF;
  IF card.status IN ('done', 'archived') THEN RAISE EXCEPTION 'card % is %; give a new card instead', p_card, card.status; END IF;
  IF card.status = 'running' THEN RAISE EXCEPTION 'card % is running; wait for the worker or reclaim it first', p_card; END IF;
  IF p_assignee IS NOT NULL THEN
    SELECT * INTO t FROM org_agents WHERE name = p_assignee AND retired_at IS NULL;
    IF t.name IS NULL THEN RAISE EXCEPTION 'unknown agent "%"; run cli-org agents for the roster', p_assignee; END IF;
    PERFORM board_may_assign(c, t);
    PERFORM board_assert_capable(t, coalesce(p_needs, card.needs));
  ELSIF c.runtime <> 'human' AND NOT ('dispatch' = ANY (c.capabilities)) AND card.assignee IS DISTINCT FROM c.name THEN
    RAISE EXCEPTION '% can''t unassign %''s card', c.name, card.assignee;
  END IF;
  IF p_project IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE slug = p_project) THEN RAISE EXCEPTION 'no project "%" in the tracker (cli-projects list)', p_project; END IF;
  IF p_feature IS NOT NULL AND NOT EXISTS (SELECT 1 FROM features WHERE project_slug = coalesce(p_project, card.project_slug) AND slug = p_feature) THEN RAISE EXCEPTION 'no feature "%/%" in the tracker', coalesce(p_project, card.project_slug), p_feature; END IF;
  UPDATE cards SET assignee = p_assignee, project_slug = coalesce(p_project, project_slug),
         feature_slug = CASE WHEN p_project IS NOT NULL THEN p_feature ELSE coalesce(p_feature, feature_slug) END,
         work_type = coalesce(p_work, work_type), needs = coalesce(p_needs, needs)
   WHERE id = p_card RETURNING * INTO card;
  IF card.project_slug IS NOT NULL AND card.feature_slug IS NOT NULL AND p_assignee IS NOT NULL AND card.kind IN ('work', 'build') THEN
    UPDATE features SET owner = p_assignee WHERE project_slug = card.project_slug AND slug = card.feature_slug;
  END IF;
  PERFORM board_event(p_card, 'assigned', c.name, json_build_object('assignee', p_assignee)::jsonb);
  IF card.status = 'ready' THEN PERFORM board_wake(p_card); END IF;
  RETURN card;
END
$$;
GRANT EXECUTE ON FUNCTION board_card_assign(text, text, text, text, text, text, text) TO sb_org;

CREATE OR REPLACE FUNCTION board_card_move(p_by text, p_card text, p_status text, p_note text)
RETURNS cards LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c org_agents; card cards; was text;
BEGIN
  c := board_caller(p_by);
  SELECT * INTO card FROM cards WHERE id = p_card FOR UPDATE;
  IF card.id IS NULL THEN RAISE EXCEPTION 'no card %', p_card; END IF;
  IF c.runtime <> 'human' AND NOT ('dispatch' = ANY (c.capabilities)) THEN
    IF card.assignee IS DISTINCT FROM c.name THEN RAISE EXCEPTION '% can''t move %''s card', c.name, card.assignee; END IF;
    IF p_status IN ('done', 'archived') THEN RAISE EXCEPTION 'finish the card (cli-board finish) instead of moving it to %', p_status; END IF;
  END IF;
  IF card.status = 'running' AND p_status <> 'running' AND EXISTS (SELECT 1 FROM card_runs WHERE card_id = p_card AND finished_at IS NULL) THEN
    UPDATE card_runs SET finished_at = now(), outcome = 'partial' WHERE card_id = p_card AND finished_at IS NULL;
  END IF;
  was := card.status;
  UPDATE cards SET status = p_status,
         started_at = CASE WHEN p_status = 'running' THEN coalesce(started_at, now()) ELSE started_at END,
         completed_at = CASE WHEN p_status = 'done' THEN coalesce(completed_at, now()) ELSE completed_at END,
         block_kind = CASE WHEN p_status = 'blocked' THEN coalesce(block_kind, 'other') WHEN p_status IN ('ready', 'todo', 'running', 'done') THEN NULL ELSE block_kind END,
         block_reason = CASE WHEN p_status = 'blocked' THEN coalesce(p_note, block_reason) WHEN p_status IN ('ready', 'todo', 'running', 'done') THEN NULL ELSE block_reason END
   WHERE id = p_card RETURNING * INTO card;
  PERFORM board_event(p_card, 'moved', c.name, json_build_object('from', was, 'to', p_status, 'note', p_note)::jsonb);
  IF p_status = 'ready' THEN PERFORM board_wake(p_card); END IF;
  RETURN card;
END
$$;
GRANT EXECUTE ON FUNCTION board_card_move(text, text, text, text) TO sb_org;

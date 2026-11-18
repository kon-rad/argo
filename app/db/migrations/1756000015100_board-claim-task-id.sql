-- Lets a lane claim a specific ready card by id, not only "the next ready one for this runtime/agent". Hermes's own
-- claim semantics are "claim this exact task or fail" (hermes_agent/kanban_db.py claim); cc-dispatcher picks a card
-- from its own per-lane, priority-sorted list and then claims that one, so its loop needs the same guarantee from
-- the engine's board. p_task_id is optional and defaults to NULL, so every existing caller (zen-agent's `lane`
-- loop, the page) keeps its current "give me whatever's next" behaviour unchanged.
CREATE OR REPLACE FUNCTION board_card_claim(p_by text, p_runtime text, p_agent text, p_lease_minutes integer, p_board text, p_wakeup bigint DEFAULT NULL, p_task_id text DEFAULT NULL)
RETURNS cards LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c org_agents; card cards;
BEGIN
  IF p_by IS NOT NULL THEN
    c := board_caller(p_by);
    IF c.runtime <> 'human' AND NOT ('dispatch' = ANY (c.capabilities)) AND p_agent IS DISTINCT FROM c.name THEN
      RAISE EXCEPTION '% can claim only its own cards', c.name;
    END IF;
  ELSIF org_me() IS NOT NULL THEN
    RAISE EXCEPTION 'board: no caller';
  END IF;
  IF p_runtime IS NULL AND p_agent IS NULL THEN RAISE EXCEPTION 'claim needs a runtime or an agent'; END IF;
  SELECT k.* INTO card FROM cards k JOIN org_agents a ON a.name = k.assignee
   WHERE k.status = 'ready' AND a.retired_at IS NULL AND a.runtime NOT IN ('human', 'session')
     AND (p_runtime IS NULL OR a.runtime = p_runtime) AND (p_agent IS NULL OR a.name = p_agent) AND (p_board IS NULL OR k.board_slug = p_board)
     AND (p_task_id IS NULL OR k.id = p_task_id)
     AND NOT EXISTS (SELECT 1 FROM card_runs r WHERE r.card_id = k.id AND r.finished_at IS NULL)
   ORDER BY k.priority, k.created_at FOR UPDATE OF k SKIP LOCKED LIMIT 1;
  IF card.id IS NULL THEN
    IF p_task_id IS NOT NULL THEN RETURN NULL; END IF;  -- the named card isn't ready / is already claimed: not an error, the caller moves on
    RETURN NULL;
  END IF;
  UPDATE cards SET status = 'running', started_at = coalesce(started_at, now()) WHERE id = card.id RETURNING * INTO card;
  INSERT INTO card_runs (card_id, agent_name, runtime, wakeup_id, lease_until)
  SELECT card.id, card.assignee, a.runtime, p_wakeup, now() + make_interval(mins => coalesce(p_lease_minutes, 60)) FROM org_agents a WHERE a.name = card.assignee;
  PERFORM board_event(card.id, 'claimed', coalesce(c.name, card.assignee), json_build_object('agent', card.assignee, 'lease_minutes', coalesce(p_lease_minutes, 60))::jsonb);
  RETURN card;
END
$$;

GRANT EXECUTE ON FUNCTION board_card_claim(text, text, text, integer, text, bigint, text) TO sb_org;

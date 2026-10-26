-- Up Migration

-- Phase 1b of the kanban cutover (vault: kanban-board/dev-log/2026-10-26_cutover-phase0-inventory.md): a pause
-- and resume control plane on the engine board. The cutover plan asks for one switch that stops new work without
-- touching a file on one host. Today the only pause is cc-dispatcher's `PAUSE` file in `/home/hermes/cc-runs`,
-- which stops the Claude Code lanes and nothing else: zen-agent's lane loop claims over this board's API and never
-- reads that file. One control plane in Postgres is what both backends can read, and it is the "fewer moving
-- parts" answer to "pause everything for a deploy / a budget day / a runaway loop".
--
-- What goes in:
--   * org_agents.paused / paused_reason / paused_at  -- pause one bot or a whole team's bots.
--   * board_settings.dispatch_enabled                 -- the board-wide switch; false = no new claims at all.
--   * board_card_claim refuses a paused agent and a disabled board. A pause stops *new* claims only: a run that
--     already holds a lease keeps its card, so a pause never orphans work mid-flight. Resuming just clears the
--     flags; the next claim succeeds.
--
-- Owner-only: only a human (or a dispatch-capability bot, matching the rest of the board's write path) may pause
-- or resume. A bot cannot pause itself out of work or pause another, so the control plane cannot be used to
-- starve a colleague. The functions are SECURITY DEFINER like every other board write.

CREATE TABLE board_settings (
  board_slug        text PRIMARY KEY REFERENCES boards(slug) ON UPDATE CASCADE ON DELETE CASCADE,
  dispatch_enabled  boolean NOT NULL DEFAULT true,
  disabled_reason   text,
  disabled_at       timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
-- Every board gets its row lazily on first pause or resume; a board with no row is enabled (the default).
-- sb_org reads it through the same door as the other board tables (SELECT only; every write is a SECURITY DEFINER
-- function). Row-level security matches boards/cards: a board is visible to its own team or to a human.
GRANT SELECT ON board_settings TO sb_org;
ALTER TABLE board_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY board_settings_read ON board_settings FOR SELECT TO sb_org USING (board_visible(board_slug));

ALTER TABLE org_agents ADD COLUMN paused boolean NOT NULL DEFAULT false;
ALTER TABLE org_agents ADD COLUMN paused_reason text;
ALTER TABLE org_agents ADD COLUMN paused_at timestamptz;
CREATE INDEX org_agents_paused_idx ON org_agents (paused) WHERE paused;

-- Is this agent allowed to start new work? A paused agent is not. A disabled board is not. An agent whose team's
-- lead is paused is not either: pausing a team pauses each member's row (board_pause writes those rows), so this
-- is a plain row check and not a team join.
CREATE OR REPLACE FUNCTION board_agent_may_claim(p_name text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT NOT paused AND retired_at IS NULL FROM org_agents WHERE name = p_name), false)
$$;

CREATE OR REPLACE FUNCTION board_dispatch_enabled(p_board text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT dispatch_enabled FROM board_settings WHERE board_slug = coalesce(p_board, 'exo')), true)
$$;

-- A board-level change (a pause, a dispatch switch) has no card, and card_events.card_id is NOT NULL by design:
-- the board's event log is card-scoped. So a control-plane change writes an audit line to #platform, where the
-- owners and leads already read board news, and the card-scoped log stays honest.
CREATE OR REPLACE FUNCTION board_control_event(p_actor text, p_kind text, p_payload jsonb) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO org_messages (channel_slug, author, kind, body, mentions, urgent)
  VALUES ('platform', p_actor, 'status',
          p_kind || ': ' || coalesce(p_payload->>'scope', p_payload->>'board', 'board') ||
          coalesce(' (' || nullif(p_payload->>'reason', '') || ')', ''),
          '{}'::text[], false);
  PERFORM pg_notify('board', json_build_object('kind', p_kind, 'payload', p_payload)::text);
END
$$;

-- Pause or resume a bot, a team's bots, or all bots on a board. p_scope is the name of an agent, a team, or the
-- literal 'all'. The caller must be a human or hold dispatch; a bot cannot pause. p_until is informational only
-- (a note for the reason string); nothing resumes on its own, an owner resumes explicitly. This is deliberate:
-- an unattended auto-resume after a deploy is how a runaway loop comes back while nobody is watching.
CREATE OR REPLACE FUNCTION board_pause(p_by text, p_scope text, p_paused boolean, p_reason text, p_until text DEFAULT NULL, p_board text DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c org_agents; n integer := 0; r text;
BEGIN
  c := board_caller(p_by);
  IF c.runtime <> 'human' AND NOT ('dispatch' = ANY (c.capabilities)) THEN
    RAISE EXCEPTION '% may not pause or resume; only the owner or a dispatch bot can', c.name;
  END IF;
  IF p_paused AND coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'a pause needs a reason'; END IF;
  r := CASE WHEN p_paused THEN coalesce(p_reason, '') || coalesce(' (until ' || p_until || ')', '') ELSE NULL END;
  IF p_scope = 'all' THEN
    UPDATE org_agents SET paused = p_paused, paused_reason = CASE WHEN p_paused THEN r ELSE NULL END,
           paused_at = CASE WHEN p_paused THEN now() ELSE NULL END
     WHERE retired_at IS NULL AND runtime <> 'human';
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSIF EXISTS (SELECT 1 FROM teams WHERE slug = p_scope) THEN
    UPDATE org_agents SET paused = p_paused, paused_reason = CASE WHEN p_paused THEN r ELSE NULL END,
           paused_at = CASE WHEN p_paused THEN now() ELSE NULL END
     WHERE team_slug = p_scope AND retired_at IS NULL AND runtime <> 'human';
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSIF EXISTS (SELECT 1 FROM org_agents WHERE name = p_scope) THEN
    UPDATE org_agents SET paused = p_paused, paused_reason = CASE WHEN p_paused THEN r ELSE NULL END,
           paused_at = CASE WHEN p_paused THEN now() ELSE NULL END
     WHERE name = p_scope;
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    RAISE EXCEPTION 'no agent or team named "%"; run cli-org agents for the roster', p_scope;
  END IF;
  PERFORM board_control_event(c.name, CASE WHEN p_paused THEN 'paused' ELSE 'resumed' END,
                      json_build_object('scope', p_scope, 'agents', n, 'reason', r)::jsonb);
  RETURN n;
END
$$;
GRANT EXECUTE ON FUNCTION board_pause(text, text, boolean, text, text, text) TO sb_org;

-- The board-wide switch, separate from pausing agents: "stop dispatch on this board" without touching the roster.
CREATE OR REPLACE FUNCTION board_set_dispatch(p_by text, p_enabled boolean, p_reason text DEFAULT NULL, p_board text DEFAULT NULL)
RETURNS board_settings LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c org_agents; s board_settings; b text := coalesce(p_board, 'exo');
BEGIN
  c := board_caller(p_by);
  IF c.runtime <> 'human' AND NOT ('dispatch' = ANY (c.capabilities)) THEN
    RAISE EXCEPTION '% may not change dispatch; only the owner or a dispatch bot can', c.name;
  END IF;
  IF NOT p_enabled AND coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'disabling dispatch needs a reason'; END IF;
  INSERT INTO boards (slug, name) VALUES (b, initcap(b)) ON CONFLICT DO NOTHING;
  INSERT INTO board_settings (board_slug, dispatch_enabled, disabled_reason, disabled_at)
       VALUES (b, p_enabled, CASE WHEN p_enabled THEN NULL ELSE p_reason END, CASE WHEN p_enabled THEN NULL ELSE now() END)
  ON CONFLICT (board_slug) DO UPDATE
     SET dispatch_enabled = EXCLUDED.dispatch_enabled, disabled_reason = EXCLUDED.disabled_reason,
         disabled_at = EXCLUDED.disabled_at, updated_at = now()
  RETURNING * INTO s;
  PERFORM board_control_event(c.name, CASE WHEN p_enabled THEN 'dispatch-enabled' ELSE 'dispatch-disabled' END,
                      json_build_object('board', b, 'reason', p_reason)::jsonb);
  RETURN s;
END
$$;
GRANT EXECUTE ON FUNCTION board_set_dispatch(text, boolean, text, text) TO sb_org;

-- board_card_claim, re-issued with the pause gate. Adding p_until as the pause's informational argument would
-- change the signature; instead the gate reads the paused columns directly and the signature stays as
-- 1756000015100 left it (p_by, p_runtime, p_agent, p_lease_minutes, p_board, p_wakeup, p_task_id), so every
-- existing caller is untouched. The new gate is two WHERE clauses: the agent is not paused, and the board's
-- dispatch is enabled.
DROP FUNCTION IF EXISTS board_card_claim(text, text, text, integer, text, bigint, text);
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
  IF NOT board_dispatch_enabled(p_board) THEN
    RETURN NULL;  -- the board is disabled: no new claims; a named claim returns null like a lost race, the lane loop moves on
  END IF;
  SELECT k.* INTO card FROM cards k JOIN org_agents a ON a.name = k.assignee
   WHERE k.status = 'ready' AND a.retired_at IS NULL AND a.runtime NOT IN ('human', 'session') AND NOT a.paused
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

-- Down Migration

DROP FUNCTION IF EXISTS board_card_claim(text, text, text, integer, text, bigint, text);
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
    IF p_task_id IS NOT NULL THEN RETURN NULL; END IF;
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

DROP POLICY IF EXISTS board_settings_read ON board_settings;
REVOKE ALL ON board_settings FROM sb_org;
DROP FUNCTION IF EXISTS board_control_event(text, text, jsonb);
DROP FUNCTION IF EXISTS board_agent_may_claim(text);
DROP FUNCTION IF EXISTS board_dispatch_enabled(text);
DROP FUNCTION IF EXISTS board_set_dispatch(text, boolean, text, text);
DROP FUNCTION IF EXISTS board_pause(text, text, boolean, text, text, text);
DROP INDEX IF EXISTS org_agents_paused_idx;
ALTER TABLE org_agents DROP COLUMN IF EXISTS paused_at;
ALTER TABLE org_agents DROP COLUMN IF EXISTS paused_reason;
ALTER TABLE org_agents DROP COLUMN IF EXISTS paused;
DROP TABLE IF EXISTS board_settings;
